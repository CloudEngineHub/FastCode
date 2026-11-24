/**
 * The top-level steps of a shell script and what each one prints, so the
 * output of a compound command (`git log -5 && git status`) can be told apart
 * by step. Syntax only: nothing here runs or expands a command. The one
 * rewrite is `instrumentScript`, which `tokenwise run` uses to learn where
 * each step's output starts while the script runs as written.
 */

/** A stage of a pipeline: where its text starts and ends in the script. */
export interface ScriptStage {
  readonly start: number
  readonly end: number
  readonly text: string
}

/** How the next step follows: `&&`, `||`, or `;` (a newline reads the same). */
export type StepJoin = '&&' | '||' | ';'

/** A pipeline: one stage, or stages joined by `|`. */
export interface ScriptStep {
  readonly stages: readonly ScriptStage[]
  /** Undefined for the last step. */
  readonly next?: StepJoin
}

const CONTROL = new Set(['if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'select', 'function',
  'coproc', '[[', ']]', '!', 'time', '{', '}'])

/**
 * Split a script at `&&`, `||`, `;`, newlines and `|` outside quotes and
 * substitutions. Undefined for anything whose steps its text alone cannot
 * give: heredocs, `$((`, subshells and groups (`(…)`, `{…}`), control
 * structures (`if`, `for`, `while`, `case`, functions), background jobs
 * (`&`), `|&`, `;;`, and unbalanced quotes. Comments are skipped.
 */
export function scriptSteps(script: string): readonly ScriptStep[] | undefined {
  if (script.length > 65_536 || script.includes('\0') || script.includes('$((')) return undefined
  const steps: { stages: ScriptStage[]; next?: StepJoin }[] = [{ stages: [] }]
  // Contexts inside a word: double quotes, `$(…)` and backticks (operators in them are not the script's).
  const stack: ('"' | '(' | '`')[] = []
  let stageStart = 0
  let stageEnd = 0
  let wordStart = true
  let firstWord = ''
  let inFirstWord = true
  const endStage = (): boolean => {
    const raw = script.slice(stageStart, stageEnd)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text === '' || CONTROL.has(firstWord)) return false
    steps.at(-1)!.stages.push({ start: stageStart + lead, end: stageStart + lead + text.length, text })
    return true
  }
  const startStage = (at: number) => { stageStart = at; stageEnd = at; wordStart = true; firstWord = ''; inFirstWord = true }
  const endStep = (join: StepJoin): boolean => {
    if (!endStage()) return false
    steps.at(-1)!.next = join
    steps.push({ stages: [] })
    return true
  }
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!
    const top = stack.at(-1)
    if (ch === '\\') {
      // An escaped character is part of the word (a line continuation too).
      if (i + 1 >= script.length) return undefined
      if (stack.length === 0 && inFirstWord) firstWord += script[i + 1]
      i++
      wordStart = false
      if (stack.length === 0) stageEnd = i + 1
      continue
    }
    if (top === '"') {
      if (ch === '"') { stack.pop(); if (stack.length === 0) stageEnd = i + 1 }
      else if (ch === '$' && script[i + 1] === '(') { stack.push('('); i++ }
      else if (ch === '`') stack.push('`')
      continue
    }
    if (top === '`') {
      if (ch === '`') { stack.pop(); if (stack.length === 0) stageEnd = i + 1 }
      continue
    }
    if (ch === "'") {
      const close = script.indexOf("'", i + 1)
      if (close < 0) return undefined
      if (stack.length === 0 && inFirstWord) firstWord += script.slice(i + 1, close)
      i = close
      wordStart = false
      if (stack.length === 0) stageEnd = i + 1
      continue
    }
    if (ch === '"') { stack.push('"'); wordStart = false; continue }
    if (ch === '`') { stack.push('`'); wordStart = false; continue }
    if (ch === '$' && script[i + 1] === '(') { stack.push('('); i++; wordStart = false; continue }
    if (top === '(') {
      if (ch === '(') stack.push('(')
      else if (ch === ')') { stack.pop(); if (stack.length === 0) stageEnd = i + 1 }
      continue
    }
    // The script's own level.
    if (ch === '#' && wordStart) {
      // A comment runs to the end of the line; the newline still ends the step.
      const newline = script.indexOf('\n', i)
      i = (newline < 0 ? script.length : newline) - 1
      continue
    }
    if (ch === '<' && script[i + 1] === '<') return undefined
    if (ch === '(' || ch === ')') return undefined
    const two = script.slice(i, i + 2)
    if (two === '&&' || two === '||') {
      if (!endStep(two)) return undefined
      i++
      startStage(i + 1)
      continue
    }
    if (ch === ';' || ch === '\n') {
      if (script[i + 1] === ';') return undefined
      // An empty step (a blank line, a trailing `;`) separates nothing; a line may end after `&&`, `||` or `|`.
      if (script.slice(stageStart, stageEnd).trim() !== '') {
        if (!endStep(';')) return undefined
      } else if (ch === ';' && (steps.at(-1)!.stages.length > 0 || steps.length > 1 && steps.at(-2)!.next !== ';')) return undefined
      startStage(i + 1)
      continue
    }
    if (ch === '|') {
      if (script[i + 1] === '&') return undefined
      if (!endStage()) return undefined
      startStage(i + 1)
      continue
    }
    if (ch === '&') {
      // `2>&1`, `>&2`, `&>file`, `&>>file` are redirects; a lone `&` sends a job to the background.
      if (script[i - 1] === '>' || script[i + 1] === '>') { wordStart = false; stageEnd = i + 1; continue }
      return undefined
    }
    if (/\s/.test(ch)) {
      if (!wordStart && inFirstWord && firstWord !== '') inFirstWord = false
      wordStart = true
      continue
    }
    stageEnd = i + 1
    // An assignment before the command is not its first word.
    if (inFirstWord && ch === '=' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(firstWord)) { firstWord = ''; inFirstWord = false; wordStart = false; continue }
    if (inFirstWord) firstWord += ch
    wordStart = false
  }
  if (stack.length > 0) return undefined
  if (script.slice(stageStart, stageEnd).trim() !== '') { if (!endStage()) return undefined }
  else if (steps.at(-1)!.stages.length > 0) return undefined
  // A trailing join (`a &&`) leaves an empty last step.
  if (steps.at(-1)!.stages.length === 0) {
    steps.pop()
    if (steps.length === 0 || steps.at(-1)!.next !== ';') return undefined
    delete steps.at(-1)!.next
  }
  return steps.length > 0 ? steps.map(step => step.next === undefined ? { stages: step.stages } : { stages: step.stages, next: step.next }) : undefined
}

/** Where a stage's stdout and stderr go: the shell's own streams, nowhere, or a file. */
type Target = 'out' | 'err' | 'null' | 'file'

/**
 * A stage's words without its redirects, and where its streams end up
 * (`>/dev/null 2>&1`, `2>&1`, `> file`, `&>file`, `>&2`). Undefined for
 * words the reading here does not cover (quotes with expansions, globs).
 */
function stageWords(text: string): { readonly words: readonly string[]; readonly out: Target; readonly err: Target } | undefined {
  const words: string[] = []
  const fds: Record<1 | 2, Target> = { 1: 'out', 2: 'err' }
  let i = 0
  const target = (word: string): Target => word === '/dev/null' ? 'null' : 'file'
  const readWord = (): string | undefined => {
    let word = ''
    let started = false
    while (i < text.length && !/\s/.test(text[i]!)) {
      const ch = text[i]!
      if (ch === "'") {
        const close = text.indexOf("'", i + 1)
        if (close < 0) return undefined
        word += text.slice(i + 1, close); i = close + 1; started = true
        continue
      }
      if (ch === '"') {
        const close = text.indexOf('"', i + 1)
        if (close < 0) return undefined
        const inner = text.slice(i + 1, close)
        if (/[$`\\]/.test(inner)) return undefined
        word += inner; i = close + 1; started = true
        continue
      }
      // Unquoted: no globs, no `~`, and no `=` first (zsh reads `=cmd` as the path of cmd).
      if (!/[A-Za-z0-9_=:./,@%+-]/.test(ch) || ch === '=' && !started) return undefined
      word += ch; i++; started = true
    }
    return started ? word : undefined
  }
  while (i < text.length) {
    if (/\s/.test(text[i]!)) { i++; continue }
    const redirect = /^(&|[12])?(>>?)(&[12])?/.exec(text.slice(i))
    if (redirect !== null && redirect[0] !== '') {
      i += redirect[0].length
      const fd = redirect[1] === '2' ? 2 : 1
      if (redirect[3] !== undefined) {
        if (redirect[1] === '&') return undefined
        const from = redirect[3] === '&2' ? 2 : 1
        fds[fd] = fds[from]
        continue
      }
      while (i < text.length && /\s/.test(text[i]!)) i++
      const file = readWord()
      if (file === undefined) return undefined
      if (redirect[1] === '&') { fds[1] = target(file); fds[2] = target(file) }
      else fds[fd] = target(file)
      continue
    }
    if (text[i] === '<') return undefined
    const word = readWord()
    if (word === undefined) return undefined
    words.push(word)
  }
  return { words, out: fds[1], err: fds[2] }
}

/** The quiet steps agents put between commands: they print nothing when they succeed. */
const QUIET_PROGRAMS = new Set(['mkdir', 'touch', 'rm', 'cp', 'mv', 'chmod', 'ln', 'sleep'])
const ENVIRONMENT_SCRIPT = /^(?:[^/]*\/)+(?:activate|\.env(?:\.[\w-]+)?|[\w-]+\.env)$/u

function quietBuiltin(words: readonly string[]): boolean {
  let start = 0
  while (start < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/u.test(words[start]!)) start++
  const [head, ...args] = words.slice(start)
  // Only assignments: the shell sets variables and prints nothing.
  if (head === undefined) return start > 0
  if (start > 0) return false
  // `cd -` and `pushd`/`popd` print the directory.
  if (head === 'cd') return args.length === 1 && args[0] !== '-'
  if (head === 'export' || head === 'unset') return args.length > 0 && args.every(arg => /^[A-Za-z_][A-Za-z0-9_]*(?:=|$)/u.test(arg))
  if (head === 'set') return args.length > 0 && args.every(arg => /^[-+][euo]+$|^(?:pipefail|errexit|nounset)$/u.test(arg))
  if (head === 'true' || head === ':') return args.length === 0
  if (head === 'test' || head === '[') return true
  if (head === 'source' || head === '.') return args.length === 1 && ENVIRONMENT_SCRIPT.test(args[0]!)
  if (QUIET_PROGRAMS.has(head)) return !args.some(arg => /^-[A-Za-z]*v|^--verbose$/u.test(arg))
  return false
}

/** What `echo` or `printf` prints with only literal words, the same in bash, zsh and sh; undefined otherwise. */
function literalPrint(words: readonly string[]): string | undefined {
  const [head, ...args] = words
  if (head === 'echo') {
    // Options and backslashes read differently in bash, zsh and sh (`echo -e`, `echo -`, `echo 'a\n'`).
    if (args.length > 0 && /^-[A-Za-z]*$/u.test(args[0]!) || args.some(arg => arg.includes('\\'))) return undefined
    return `${args.join(' ')}\n`
  }
  if (head === 'printf') {
    const [format, ...values] = args
    if (format === undefined || format.startsWith('-')) return undefined
    const pieces: (string | null)[] = []
    for (let i = 0; i < format.length; i++) {
      const ch = format[i]!
      if (ch === '\\') {
        const next = format[++i]
        const escape = next === 'n' ? '\n' : next === 't' ? '\t' : next === '\\' ? '\\' : undefined
        if (escape === undefined) return undefined
        pieces.push(escape)
      } else if (ch === '%') {
        const next = format[++i]
        if (next === '%') pieces.push('%')
        else if (next === 's') pieces.push(null)
        else return undefined
      } else pieces.push(ch)
    }
    const slots = pieces.filter(piece => piece === null).length
    if (slots === 0) return values.length === 0 ? pieces.join('') : undefined
    let text = ''
    let at = 0
    do {
      for (const piece of pieces) text += piece ?? values[at++] ?? ''
    } while (at < values.length)
    return text
  }
  return undefined
}

/**
 * Whether a stage after a pipe shows the start of its input unchanged: `cat`,
 * or `head` by lines. Not `tail`: a filter reading the end of an output as
 * the whole would miss what the cut-off start told it (a capture header, a
 * mode line).
 */
export function keepsStart(text: string): boolean {
  const words = stageWords(text)
  if (words === undefined || words.out !== 'out' || words.err !== 'err') return false
  const [name, ...args] = words.words
  if (name === 'cat') return args.length === 0
  return name === 'head' && /^(?:|-\d+|-n\s*\d+|--lines=\d+)$/u.test(args.join(' '))
}

/** What a step prints where the output is read. */
export type StepPrint =
  | { readonly kind: 'quiet' }
  | { readonly kind: 'literal'; readonly text: string }
  /** Output not known before it runs. `commands`: what a filter may read it as, best first. */
  | { readonly kind: 'output'; readonly commands: readonly string[] }

/**
 * What a step prints, read with stderr in the same output (`merged`) or
 * apart. A quiet step prints nothing when it succeeds; a literal one prints
 * exactly its text. A pipeline whose later stages show the start of the
 * output unchanged (`| head -50`, `| cat`) may also be read as its first stage.
 */
export function stepPrint(step: ScriptStep, merged: boolean): StepPrint {
  const shown = (target: Target) => target === 'out' || merged && target === 'err'
  const first = step.stages[0]!
  if (step.stages.length === 1) {
    const words = stageWords(first.text)
    if (words !== undefined) {
      const literal = literalPrint(words.words)
      if (literal !== undefined) return !shown(words.out) ? { kind: 'quiet' } : words.out === 'out' ? { kind: 'literal', text: literal } : { kind: 'output', commands: [] }
      if (quietBuiltin(words.words) || !shown(words.out) && !shown(words.err)) return { kind: 'quiet' }
    }
    return { kind: 'output', commands: [first.text] }
  }
  const text = step.stages.map(stage => stage.text).join(' | ')
  const commands = step.stages.slice(1).every(stage => keepsStart(stage.text)) ? [text, first.text] : [text]
  return { kind: 'output', commands }
}

/** Words that would see or change the marks `instrumentScript` adds, or the step function itself. */
const NOT_INSTRUMENTED = [
  /\b(?:PIPESTATUS|pipestatus|BASH_COMMAND|xtrace|__tw_\w*)\b/u,
  // As a command: replacing the shell or its streams, traps, listings of functions and variables.
  /(?:^|[;&|\n]\s*)(?:exec|trap|declare|typeset|functions|compgen)(?:\s|$)/u,
  // `set` alone lists functions too; `set -x` traces the mark calls.
  /(?:^|[;&|\n]\s*)set(?:\s*(?:$|[;&|\n])|\s+[^;&|\n]*-\w*x)/u,
]

/** The start and end of a step's mark: an ASCII record separator, `TW`, a nonce, the step and the previous exit status. */
export function stepMark(nonce: string, step: number, status: number): string {
  return `\u001eTW${nonce} ${step} ${status}\u001e\n`
}

/**
 * The script with a mark printed on stdout and stderr before each step, for
 * `tokenwise run` to split the output by step and learn each step's exit
 * status. The mark function returns the status it found, so `$?`, `&&`,
 * `||`, `set -e` and the script's own exit status work as before, and it
 * passes `$_` on. Undefined when a split would not hold: fewer than two
 * steps, syntax `scriptSteps` does not read, and scripts that read pipeline
 * statuses, set traps, trace commands, replace the shell or list functions.
 */
export function instrumentScript(script: string, nonce: string): string | undefined {
  if (!/^[A-Za-z0-9]{8,32}$/u.test(nonce) || NOT_INSTRUMENTED.some(pattern => pattern.test(script))) return undefined
  const steps = scriptSteps(script)
  if (steps === undefined || steps.length < 2 || steps.length > 200) return undefined
  const mark = (fd: string) => `printf '\\036TW${nonce} %s %s\\036\\n' "$1" "$__tw_s"${fd} 2>/dev/null || :`
  const define = `__tw_mark() { __tw_s=$?; ${mark('')}; ${mark(' >&2')}; return $__tw_s; }; `
  let out = ''
  let at = 0
  steps.forEach((step, index) => {
    const start = step.stages[0]!.start
    const join = index === 0 ? ';' : steps[index - 1]!.next!
    out += script.slice(at, start) + `__tw_mark ${index} "\${_-}" ${join} `
    at = start
  })
  return define + out + script.slice(at)
}

/** Where a step's output starts and ends in a stream, the step, and its exit status. */
export interface StepOutput {
  readonly start: number
  readonly end: number
  readonly step: number
  readonly exitCode: number
}

/**
 * Remove the marks of `instrumentScript` from one stream. Returns the text
 * without them and, when every mark is well formed and in step order, where
 * each step's output is; the last step's status is the script's.
 */
export function splitMarks(text: string, nonce: string, exitCode: number): { readonly text: string; readonly steps?: readonly StepOutput[] } {
  const pattern = new RegExp(`\u001eTW${nonce} (\\d+) (\\d+)\u001e\n`, 'gu')
  let clean = ''
  let at = 0
  const marks: { at: number; step: number; status: number }[] = []
  for (const match of text.matchAll(pattern)) {
    clean += text.slice(at, match.index)
    marks.push({ at: clean.length, step: Number(match[1]), status: Number(match[2]) })
    at = match.index + match[0].length
  }
  clean += text.slice(at)
  // A mark cut short (the shell was killed while printing it) or out of order: no split, but never a leftover mark.
  if (clean.includes(`\u001eTW${nonce}`)) return { text: clean.split(new RegExp(`\u001eTW${nonce}[^\n]*\n?`, 'gu')).join('') }
  if (marks.length === 0 || marks[0]!.at !== 0 || marks.some((mark, i) => i > 0 && mark.step <= marks[i - 1]!.step)) return { text: clean }
  const steps = marks.map((mark, i) => ({
    start: mark.at, end: marks[i + 1]?.at ?? clean.length, step: mark.step, exitCode: marks[i + 1]?.status ?? exitCode,
  }))
  return { text: clean, steps }
}
