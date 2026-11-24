import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { constants } from 'node:os'
import { instrumentScript, mayProject, splitMarks } from '@tokenwise/core'
import type { StepOutput } from '@tokenwise/core'
import { shellQuote } from './context.ts'
import { projectOutput } from './project.ts'

export interface RunOptions {
  readonly host: string
  readonly sessionId: string | null
  readonly callId: string | null
  readonly tool: string
  /** Shell script run with `$SHELL -c` (or /bin/sh). */
  readonly script?: string
  /** Program and arguments run directly, without a shell. */
  readonly argv?: readonly string[]
}

/** Per stream; beyond it TokenWise stops buffering and passes the rest through unchanged. */
const CAPTURE_LIMIT = 32 * 1024 * 1024
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/** The command text filters see: the script itself, never TokenWise's wrapper. */
export function commandText(options: Pick<RunOptions, 'script' | 'argv'>): string {
  if (options.script !== undefined) return options.script
  const argv = options.argv ?? []
  if (argv.length === 3 && SHELLS.has(basename(argv[0]!)) && (argv[1] === '-c' || argv[1] === '-lc')) return argv[2]!
  return argv.map(shellQuote).join(' ')
}

function shellProgram(env: NodeJS.ProcessEnv): string {
  const shell = env.SHELL
  return shell && shell.startsWith('/') && SHELLS.has(basename(shell)) ? shell : '/bin/sh'
}

/** A step mark is one short `printf`, so it never runs past this many bytes. */
const MAX_MARK = 64

/**
 * Removes the step marks of `instrumentScript` from a stream as it is read.
 * A mark is printed by one write, so only the end of a read can hold part of
 * one; that part waits for the next read. A mark cut short when the shell is
 * killed is dropped.
 */
export class MarkFilter {
  private pending: Buffer = Buffer.alloc(0)
  private readonly prefix: Buffer
  constructor(nonce: string) {
    this.prefix = Buffer.from(`\u001eTW${nonce}`)
  }

  push(chunk: Buffer): Buffer {
    const data = this.pending.length > 0 ? Buffer.concat([this.pending, chunk]) : chunk
    this.pending = Buffer.alloc(0)
    const out: Buffer[] = []
    let at = 0
    for (;;) {
      const i = data.indexOf(0x1e, at)
      if (i < 0) { out.push(data.subarray(at)); break }
      const head = data.subarray(i, i + this.prefix.length)
      if (!this.prefix.subarray(0, head.length).equals(head)) { out.push(data.subarray(at, i + 1)); at = i + 1; continue }
      const end = head.length < this.prefix.length ? -1 : data.indexOf('\u001e\n', i + this.prefix.length)
      if (end >= 0 && end + 2 - i <= MAX_MARK) { out.push(data.subarray(at, i)); at = end + 2; continue }
      if (data.length - i < MAX_MARK) { out.push(data.subarray(at, i)); this.pending = data.subarray(i); break }
      // Not a whole mark: drop the nonce, keep what follows.
      out.push(data.subarray(at, i)); at = i + this.prefix.length
    }
    return Buffer.concat(out)
  }

  /** The end of the stream: what waited is output unless it starts with the whole nonce. */
  end(): Buffer {
    const rest = this.pending
    this.pending = Buffer.alloc(0)
    return rest.length >= this.prefix.length && rest.subarray(0, this.prefix.length).equals(this.prefix) ? Buffer.alloc(0) : rest
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true })
function decode(chunks: readonly Buffer[]): string | undefined {
  try { return utf8.decode(Buffer.concat(chunks)) } catch { return undefined }
}

/**
 * Run a command, then print a projection of its output when a filter applies.
 * Exit status and signals are passed through. Output is printed when the
 * command finishes; unfiltered output keeps the original stdout/stderr order.
 */
export function run(options: RunOptions): Promise<never> {
  const env = process.env
  const command = commandText(options)
  const program = options.script !== undefined ? shellProgram(env) : options.argv?.[0]
  // A compound script prints a mark before each step, so each step's output can go through its own filter.
  const nonce = randomBytes(12).toString('hex')
  const instrumented = options.script !== undefined && mayProject(options.script) ? instrumentScript(options.script, nonce) : undefined
  const args = options.script !== undefined ? ['-c', instrumented ?? options.script] : (options.argv ?? []).slice(1)
  if (!program) {
    process.stderr.write('tokenwise run: missing command (use -c <script> or -- <program> [args...])\n')
    process.exit(2)
  }
  const child = spawn(program, args, { stdio: ['inherit', 'pipe', 'pipe'], env })
  // `chunk` without marks, as written; `raw` as read.
  const order: { fd: 1 | 2; chunk: Buffer; raw: Buffer }[] = []
  const marks = instrumented === undefined ? undefined : { 1: new MarkFilter(nonce), 2: new MarkFilter(nonce) }
  const sizes = { 1: 0, 2: 0 }
  let passthrough = false
  const forward = (signal: NodeJS.Signals) => () => { try { child.kill(signal) } catch { /* Already gone. */ } }
  const handlers = FORWARDED.map(signal => [signal, forward(signal)] as const)
  for (const [signal, handler] of handlers) process.on(signal, handler)
  const write = (fd: 1 | 2, data: Buffer | string) => (fd === 1 ? process.stdout : process.stderr).write(data)
  const collect = (fd: 1 | 2) => (raw: Buffer) => {
    const chunk = marks ? marks[fd].push(raw) : raw
    if (passthrough) { write(fd, chunk); return }
    order.push({ fd, chunk, raw })
    sizes[fd] += raw.length
    if (sizes[fd] > CAPTURE_LIMIT) {
      // Too large to hold: stop filtering and stream everything from here on.
      passthrough = true
      for (const item of order.splice(0)) write(item.fd, item.chunk)
    }
  }
  child.stdout!.on('data', collect(1))
  child.stderr!.on('data', collect(2))

  return new Promise<never>(() => {
    child.on('error', error => {
      for (const [signal, handler] of handlers) process.off(signal, handler)
      const code = (error as NodeJS.ErrnoException).code
      process.stderr.write(`tokenwise run: ${program}: ${code === 'ENOENT' ? 'command not found' : error.message}\n`)
      process.exit(code === 'ENOENT' ? 127 : 126)
    })
    child.on('close', (code, signal) => {
      for (const [name, handler] of handlers) process.off(name, handler)
      if (marks) for (const fd of [1, 2] as const) {
        const rest = marks[fd].end()
        if (rest.length === 0) continue
        if (passthrough) write(fd, rest)
        else order.push({ fd, chunk: rest, raw: Buffer.alloc(0) })
      }
      const finish = () => {
        if (signal) {
          process.kill(process.pid, signal)
          // Signals without a default terminating action fall through to the shell convention.
          process.exit(128 + (constants.signals[signal] ?? 1))
        }
        process.exit(code ?? 1)
      }
      if (passthrough) return void flushThen(finish)
      try {
        const replaced = project(options, command, code, signal, order, instrumented === undefined ? undefined : nonce)
        if (replaced) {
          if (replaced.first === 2) { if (replaced.stderr) write(2, replaced.stderr); if (replaced.stdout) write(1, replaced.stdout) }
          else { if (replaced.stdout) write(1, replaced.stdout); if (replaced.stderr) write(2, replaced.stderr) }
        } else for (const item of order) write(item.fd, item.chunk)
      } catch {
        for (const item of order) write(item.fd, item.chunk)
      }
      flushThen(finish)
    })
  })
}

function flushThen(next: () => void): void {
  let pending = 2
  const done = () => { if (--pending === 0) next() }
  process.stdout.write('', done)
  process.stderr.write('', done)
}

function project(options: RunOptions, command: string, code: number | null, signal: NodeJS.Signals | null,
  order: readonly { fd: 1 | 2; chunk: Buffer; raw: Buffer }[], nonce: string | undefined): { stdout?: string; stderr?: string; first: 1 | 2 } | undefined {
  const stdout = decode(order.filter(item => item.fd === 1).map(item => item.chunk))
  const stderr = decode(order.filter(item => item.fd === 2).map(item => item.chunk))
  // Binary output is never filtered, and neither is the other stream of the same command.
  if (stdout === undefined || stderr === undefined) return undefined
  const steps = nonce === undefined ? undefined : stepsOf(order.filter(item => item.fd === 1).map(item => item.raw), stdout, nonce, code ?? -1)
  const projected = projectOutput({ host: options.host, delivery: 'command-wrapper', tool: options.tool, sessionId: options.sessionId,
    callId: options.callId, command, exitCode: code ?? -1, interrupted: signal !== null || code === null, stdout, stderr,
    ...steps === undefined ? {} : { steps } })
  return projected ? { ...projected, first: order[0]?.fd ?? 1 } : undefined
}

/** Where each step printed in `text` (the stream without marks), from the marks read with it; undefined if they disagree. */
function stepsOf(raw: readonly Buffer[], text: string, nonce: string, exitCode: number): readonly StepOutput[] | undefined {
  const marked = decode(raw)
  if (marked === undefined) return undefined
  const split = splitMarks(marked, nonce, exitCode)
  return split.text === text ? split.steps : undefined
}
