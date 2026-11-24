/**
 * The output of a compound command (`git log -5 && echo === && git status`),
 * filtered step by step: each step's part of the output goes through the
 * filter for that step's command, and everything else stays as it is.
 *
 * Where each part starts comes from the marks `tokenwise run` prints
 * between steps, or else from the output itself: steps that print nothing
 * when they succeed (`cd`, `export`), and literal `echo`/`printf` lines found
 * exactly once where expected. Anything less certain stays as it is: a part
 * two steps may share, a separator that also appears elsewhere, an exit
 * status that is not known and would change the filter's answer.
 */
import { projectStaticFilter } from './filters/index.ts'
import type { FilterOptions } from './filter-options.ts'
import { ProjectionBuilder } from './projection-map.ts'
import type { MappedProjection } from './projection-map.ts'
import { scriptSteps, stepPrint } from './script.ts'
import type { ScriptStep, StepOutput, StepPrint } from './script.ts'
import type { EconomyFilterName, EconomyTransformation, FilterCandidate } from './types.ts'

export interface CompoundInput {
  /** The script as the agent wrote it. */
  readonly command: string
  /** The stream the steps printed to, as the model would read it. */
  readonly text: string
  /** The script's exit status. */
  readonly exitCode: number
  /** stderr is in `text` too. */
  readonly merged: boolean
  /** Each step's output in `text`, from `tokenwise run`'s marks; otherwise found in `text`. */
  readonly steps?: readonly StepOutput[]
  readonly options?: FilterOptions
}

export interface CompoundProjection extends MappedProjection {
  /** The filter of the step that saved the most. */
  readonly filter: EconomyFilterName
  readonly transformation: EconomyTransformation
  /** How many steps were filtered. */
  readonly parts: number
}

/** A step's part of the output; `exitCode` undefined when it is not known. */
interface Part {
  readonly start: number
  readonly end: number
  readonly step: number
  readonly exitCode: number | undefined
}

/** Filter each step's part of a compound command's output; undefined when no part changes. */
export function projectCompound(input: CompoundInput): CompoundProjection | undefined {
  const steps = scriptSteps(input.command)
  if (steps === undefined || steps.length === 1 && steps[0]!.stages.length === 1) return undefined
  const prints = steps.map(step => stepPrint(step, input.merged))
  if (!prints.some(print => print.kind === 'output' && print.commands.length > 0)) return undefined
  const parts = input.steps !== undefined ? markedParts(input.steps, input.text, steps.length) : foundParts(steps, prints, input.text, input.exitCode)
  if (parts === undefined) return undefined
  const filtered: { part: Part; projection: FilterCandidate }[] = []
  for (const part of parts) {
    const print = prints[part.step]!
    if (print.kind !== 'output' || part.end === part.start) continue
    const projection = projectPart(print.commands, input.text.slice(part.start, part.end), part.exitCode, input.options)
    if (projection !== undefined) filtered.push({ part, projection })
  }
  if (filtered.length === 0) return undefined
  const builder = new ProjectionBuilder(input.text)
  let at = 0
  for (const { part, projection } of filtered) {
    builder.keep(at, part.start)
    builder.append(shifted(projection, part.start, input.text.length))
    const rest = input.text.slice(part.end)
    if (rest !== '' && !rest.startsWith('\n')) builder.newline()
    at = part.end
  }
  builder.keep(at, input.text.length)
  const saved = (item: typeof filtered[number]) => (item.part.end - item.part.start) - item.projection.text.length
  const best = filtered.reduce((a, b) => saved(b) > saved(a) ? b : a)
  return { ...builder.finish(), filter: best.projection.filter, transformation: best.projection.transformation, parts: filtered.length }
}

/**
 * A part's projection. With its exit status known, the first command a filter
 * reads it as; otherwise only an answer that is the same whether the step
 * succeeded or failed.
 */
function projectPart(commands: readonly string[], stdout: string, exitCode: number | undefined, options: FilterOptions | undefined): FilterCandidate | undefined {
  for (const command of commands) {
    const attempt = (code: number) => projectStaticFilter({ command, stdout, exitCode: code, ...options === undefined ? {} : { options } })
    if (exitCode !== undefined) {
      const projection = attempt(exitCode)
      if (projection !== undefined) return projection
      continue
    }
    const ok = attempt(0)
    const failed = ok === undefined ? undefined : attempt(1)
    if (ok !== undefined && failed !== undefined && ok.text === failed.text) return ok
  }
  return undefined
}

function shifted(projection: MappedProjection, offset: number, sourceLength: number): MappedProjection {
  return {
    text: projection.text,
    sourceMap: {
      ...projection.sourceMap,
      sourceLength,
      spans: projection.sourceMap.spans.map(span => span.sourceStart === undefined ? span
        : { ...span, sourceStart: span.sourceStart + offset, sourceEnd: span.sourceEnd! + offset }),
    },
  }
}

/** The parts the marks give, when they fit the text and the script. */
function markedParts(marked: readonly StepOutput[], text: string, count: number): readonly Part[] | undefined {
  let end = 0
  for (const part of marked) {
    if (part.start !== end || part.end < part.start || part.step >= count || !Number.isSafeInteger(part.exitCode)) return undefined
    end = part.end
  }
  return end === text.length ? marked.map(part => ({ ...part })) : undefined
}

function occurrences(text: string, literal: string): number {
  let count = 0
  for (let at = text.indexOf(literal); at >= 0; at = text.indexOf(literal, at + literal.length)) count++
  return count
}

/**
 * The parts found in the output: the literal lines, each where the script
 * prints it and nowhere else, split the text into gaps; a gap is a step's
 * part when exactly one step that prints unknown output falls in it (a blank
 * `echo` next to it is cut off). When the script failed, literal lines may
 * be missing from the end, if only `&&` follows the last one found: the
 * steps after it stopped at the failure, so the step before the first
 * missing line has the script's status.
 */
function foundParts(steps: readonly ScriptStep[], prints: readonly StepPrint[], text: string, exitCode: number): readonly Part[] | undefined {
  const literal = (step: number) => { const print = prints[step]!; return print.kind === 'literal' ? print.text : undefined }
  const anchors = prints.flatMap((_, step) => literal(step)?.trim() ? [{ step, text: literal(step)! }] : [])
  // Some hosts trim the output's final newline (Copilot): a literal line can end the text without its own.
  const trimmed = (value: string) => value.endsWith('\n') && !text.endsWith(value) && text.endsWith(value.slice(0, -1)) ? 1 : 0
  const found: { step: number; text: string; start: number; end: number }[] = []
  let position = 0
  for (const [index, anchor] of anchors.entries()) {
    let at = text.indexOf(anchor.text, position)
    let end = at + anchor.text.length
    if (at < 0 && index === anchors.length - 1 && trimmed(anchor.text) === 1 && text.length - anchor.text.length + 1 >= position) {
      at = text.length - anchor.text.length + 1
      end = text.length
    }
    if (at < 0) break
    found.push({ ...anchor, start: at, end })
    position = end
  }
  // Each literal line appears only where it was found: no copy of a separator inside another step's output.
  for (const value of new Set(anchors.map(anchor => anchor.text))) {
    if (occurrences(text, value) + trimmed(value) !== found.filter(item => item.text === value).length) return undefined
  }
  const missing = anchors.length - found.length
  const lastFound = found.at(-1)?.step ?? -1
  if (missing > 0 && (exitCode === 0 || steps.slice(lastFound + 1, -1).some(step => step.next !== '&&'))) return undefined
  const status = statuses(steps, prints, new Set(found.map(item => item.step)), exitCode)
  const parts: Part[] = []
  const gap = (start: number, end: number, from: number, to: number, failed: boolean) => {
    const producers: number[] = []
    for (let step = from; step < to; step++) if (prints[step]!.kind === 'output') producers.push(step)
    if (producers.length !== 1) return
    const producer = producers[0]!
    let before = '', after = ''
    for (let step = from; step < to; step++) {
      const blank = literal(step)
      if (blank !== undefined) { if (step < producer) before += blank; else after += blank }
    }
    if (!text.startsWith(before, start) || end - start < before.length + after.length || text.slice(end - after.length, end) !== after) return
    if (end - after.length > start + before.length) {
      parts.push({ start: start + before.length, end: end - after.length, step: producer, exitCode: failed ? exitCode : status[producer] })
    }
  }
  let previous = { step: -1, end: 0 }
  for (const item of found) {
    gap(previous.end, item.start, previous.step + 1, item.step, false)
    previous = item
  }
  gap(previous.end, text.length, previous.step + 1, missing > 0 ? anchors[found.length]!.step : steps.length, missing > 0)
  return parts
}

/**
 * Each step's exit status where the script shows it, else undefined. In a
 * run of `&&`, a step before a literal line that printed succeeded. In the
 * last such run, every step succeeded when the script did; when it failed,
 * the last step that prints unknown output, with nothing after it but quiet
 * or literal steps, gets the script's status (it failed, or the failure
 * stopped the script around it).
 */
function statuses(steps: readonly ScriptStep[], prints: readonly StepPrint[], printed: ReadonlySet<number>, exitCode: number): (number | undefined)[] {
  const status: (number | undefined)[] = steps.map(() => undefined)
  let start = 0
  for (let end = 0; end < steps.length; end++) {
    if (steps[end]!.next === '&&') continue
    // steps[start..end] are joined by `&&` alone, or `end` follows `||`.
    const joinedByAnd = steps.slice(start, end).every(step => step.next === '&&') && (start === 0 || steps[start - 1]!.next === ';')
    if (joinedByAnd) {
      let lastPrinted = -1
      for (let step = start; step <= end; step++) if (printed.has(step)) lastPrinted = step
      for (let step = start; step < lastPrinted; step++) status[step] = 0
      if (end === steps.length - 1) {
        if (exitCode === 0) for (let step = start; step <= end; step++) status[step] = 0
        else {
          let last = end
          while (last >= start && prints[last]!.kind !== 'output') last--
          if (last >= start && last >= lastPrinted) status[last] = exitCode
        }
      }
    }
    start = end + 1
  }
  return status
}
