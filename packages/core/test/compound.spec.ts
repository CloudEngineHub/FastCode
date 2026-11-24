import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createPolicy, decideShellProjection, instrumentScript, mayProject, projectStaticFilter, scriptSteps, splitMarks, stepPrint } from '../src/index.ts'
import type { ScriptStep, StepOutput } from '../src/index.ts'

const corpus = JSON.parse(readFileSync(new URL('../../../conformance/economy/corpus.json', import.meta.url), 'utf8')) as {
  cases: { id: string; command: string; stdout: string; exitCode: number }[]
}
const sample = (id: string) => corpus.cases.find(item => item.id === id)!
const status = sample('captured/07-git-status')
const make = sample('captured/make/w-nothing-to-do')
const pytest = sample('captured/11-pytest')
const alone = (item: { command: string; stdout: string; exitCode: number }) =>
  projectStaticFilter({ command: item.command, stdout: item.stdout, exitCode: item.exitCode })!.text
const policy = createPolicy()
const decide = (command: string, text: string, exitCode: number, extra: { steps?: StepOutput[]; stderr?: true } = {}) =>
  decideShellProjection({ command, exitCode, rendered: text, stdout: { start: 0, text },
    ...extra.steps ? { steps: extra.steps } : {}, ...extra.stderr ? { stderr: { start: text.length, text: '' } } : {} }, { policy })
const steps = (script: string) => scriptSteps(script)!.map(step => ({ text: step.stages.map(stage => stage.text), next: step.next }))
const print = (script: string, merged = true) => stepPrint(scriptSteps(script)![0] as ScriptStep, merged)

describe('script steps', () => {
  it('splits at &&, ||, ; and newlines outside quotes and substitutions', () => {
    expect(steps('cd /a && git log -5 || echo "a; b && c"; git status\nls $(echo x; echo y) | head -3')).toEqual([
      { text: ['cd /a'], next: '&&' }, { text: ['git log -5'], next: '||' }, { text: ['echo "a; b && c"'], next: ';' },
      { text: ['git status'], next: ';' }, { text: ['ls $(echo x; echo y)', 'head -3'] },
    ])
    expect(steps('git status # what changed\n\n# then\nmake &&\n  make test;')).toEqual([
      { text: ['git status'], next: ';' }, { text: ['make'], next: '&&' }, { text: ['make test'] },
    ])
  })

  it('reads nothing it cannot split by its text alone', () => {
    for (const script of ['cat <<EOF\nx\nEOF', '(cd a && make)', '{ make; }', 'for f in *; do cat $f; done', 'if true; then make; fi',
      'sleep 1 &', 'make |& tee log', 'echo $((1+2))', 'f() { make; }', '! make', 'make &&', 'echo "open']) {
      expect(scriptSteps(script), script).toBeUndefined()
    }
  })

  it('knows the steps that print nothing when they succeed, and the literal lines', () => {
    for (const quiet of ['cd packages/core', 'export A=1 B', 'set -euo pipefail', 'mkdir -p out/x', 'A=1', 'make >/dev/null 2>&1', 'make &>/dev/null', 'test -f x']) {
      expect(print(quiet).kind, quiet).toBe('quiet')
    }
    expect(print('make 2>/dev/null').kind).toBe('output')
    expect(print('make > log', false).kind).toBe('quiet')
    expect(print('make > log', true).kind).toBe('output')
    expect(print('echo "=== git log ==="')).toEqual({ kind: 'literal', text: '=== git log ===\n' })
    expect(print("printf '\\n--- %s ---\\n' status")).toEqual({ kind: 'literal', text: '\n--- status ---\n' })
    // Shells disagree on these, or expand them: no literal.
    for (const other of ['echo -n x', 'echo -e "a"', 'echo -', 'echo "a\\nb"', 'echo ===', 'echo $HOME', 'echo *', 'echo ~']) {
      expect(print(other).kind, other).toBe('output')
    }
  })

  it('reads a pipeline as its first stage only when the rest shows the start unchanged', () => {
    expect(print('git log | head -n 20')).toEqual({ kind: 'output', commands: ['git log | head -n 20', 'git log'] })
    expect(print('git log | cat')).toEqual({ kind: 'output', commands: ['git log | cat', 'git log'] })
    expect(print('pytest 2>&1 | tail -n 5')).toEqual({ kind: 'output', commands: ['pytest 2>&1 | tail -n 5'] })
    expect(print('git log | grep fix')).toEqual({ kind: 'output', commands: ['git log | grep fix'] })
  })
})

describe('compound commands, found in the output', () => {
  it('filters each step between literal separators by its own filter', () => {
    const script = `echo "=== status ==="; ${make.command} && echo "=== next ===" && ${status.command}`
    const text = `=== status ===\n${make.stdout}=== next ===\n${status.stdout}`
    const decision = decide(script, text, 0)
    expect(decision).toMatchObject({ kind: 'project', parts: 2 })
    // The `make` step follows `;`, so its status is not known, but `make -w`'s filter answers the same either way.
    expect(decision.kind === 'project' && decision.text).toBe(`=== status ===\n${alone(make)}=== next ===\n${alone(status)}`)
    expect(mayProject(script)).toBe(true)
  })

  it('keeps a step whose filter needs an exit status the output does not show', () => {
    // `git status` after `;` may have failed; its filter reads only successful runs.
    const script = `${status.command}; echo "=== then ==="; ${make.command}`
    const text = `${status.stdout}=== then ===\n${make.stdout}`
    const decision = decide(script, text, 0)
    expect(decision.kind === 'project' && decision.text).toBe(`${status.stdout}=== then ===\n${alone(make)}`)
    // Joined by `&&`, the separator printed, so git status succeeded.
    const joined = decide(`${status.command} && echo "=== then ===" && ${make.command}`, text, 0)
    expect(joined.kind === 'project' && joined.text).toBe(`${alone(status)}=== then ===\n${alone(make)}`)
  })

  it('passes when a separator also appears in a step, or two steps share a part', () => {
    const copied = `${status.stdout}=== then ===\n${make.stdout}=== then ===\n`
    expect(decide(`${status.command} && echo "=== then ===" && ${make.command}`, copied, 0)).toMatchObject({ kind: 'pass', matchDetail: 'compound-output-unrecognized' })
    expect(decide(`${status.command} && ${make.command}`, status.stdout + make.stdout, 0)).toMatchObject({ kind: 'pass', matchDetail: 'compound-output-unrecognized' })
  })

  it('gives the failing step the script status when the separators after it are missing', () => {
    const script = `echo "=== tests ===" && ${pytest.command} && echo "=== status ===" && ${status.command}`
    const text = `=== tests ===\n${pytest.stdout}`
    const decision = decide(script, text, 1)
    expect(decision.kind === 'project' && decision.text).toBe(`=== tests ===\n${alone(pytest)}`)
    // After a success nothing may be missing.
    expect(decide(script, text, 0).kind).toBe('pass')
  })

  it('finds a final separator whose newline the host trimmed', () => {
    const script = `export CI=1 && mkdir -p out && ${make.command} && echo "---- done ----"`
    const decision = decide(script, `${make.stdout}---- done ----`, 0)
    expect(decision.kind === 'project' && decision.text).toBe(`${alone(make)}---- done ----`)
    // Only at the very end, and only the last separator.
    expect(decide(`${make.command} && echo "-- a" && ${status.command}`, `${make.stdout}-- a${status.stdout}`, 0).kind).toBe('pass')
  })

  it('cuts a blank echo off the step next to it', () => {
    const script = `echo "== a"; ${make.command}; echo; echo "== b"`
    const decision = decide(script, `== a\n${make.stdout}\n== b\n`, 0)
    expect(decision.kind === 'project' && decision.text).toBe(`== a\n${alone(make)}\n== b\n`)
  })
})

describe('compound commands, marked by tokenwise run', () => {
  it('filters each marked step with its own exit status', () => {
    const script = `${status.command} && ${make.command}; ${pytest.command}`
    const text = status.stdout + make.stdout + pytest.stdout
    const marked: StepOutput[] = [
      { start: 0, end: status.stdout.length, step: 0, exitCode: 0 },
      { start: status.stdout.length, end: status.stdout.length + make.stdout.length, step: 1, exitCode: 0 },
      { start: status.stdout.length + make.stdout.length, end: text.length, step: 2, exitCode: 1 },
    ]
    const decision = decide(script, text, 1, { steps: marked })
    expect(decision).toMatchObject({ kind: 'project', parts: 3 })
    expect(decision.kind === 'project' && decision.text).toBe(alone(status) + alone(make) + alone(pytest))
    // Marks that do not cover the text are not used.
    expect(decide(script, text, 1, { steps: marked.slice(0, 2) }).kind).toBe('pass')
  })
})

describe('step marks', () => {
  it('marks each step, keeping the joins', () => {
    const script = 'cd /tmp && git status || echo no\nmake'
    const out = instrumentScript(script, 'nonce1234')!
    expect(out).toContain('__tw_mark 0 "${_-}" ; cd /tmp && __tw_mark 1 "${_-}" && git status || __tw_mark 2 "${_-}" || echo no\n__tw_mark 3 "${_-}" ; make')
  })

  it('leaves alone scripts that would see or change the marks', () => {
    for (const script of ['false | true; echo ${PIPESTATUS[0]}', "trap 'x' ERR; make; make", 'exec >log; make; make', 'set -x; make; make',
      'set; make', 'declare -f; make', 'make', 'cat <<EOF\nx\nEOF']) {
      expect(instrumentScript(script, 'nonce1234'), script).toBeUndefined()
    }
    expect(instrumentScript('set -e; make; find . -exec ls {} +', 'nonce1234')).toBeDefined()
  })

  it('splits a stream at its marks and drops a mark cut short', () => {
    const mark = (step: number, status: number) => `\u001eTWnonce1234 ${step} ${status}\u001e\n`
    expect(splitMarks(`${mark(0, 0)}a\n${mark(2, 1)}b`, 'nonce1234', 3)).toEqual({ text: 'a\nb', steps: [
      { start: 0, end: 2, step: 0, exitCode: 1 }, { start: 2, end: 3, step: 2, exitCode: 3 },
    ] })
    expect(splitMarks(`${mark(0, 0)}a\n\u001eTWnonce1234 1`, 'nonce1234', 0)).toEqual({ text: 'a\n' })
    expect(splitMarks(`x${mark(0, 0)}a`, 'nonce1234', 0)).toEqual({ text: 'xa' })
    expect(splitMarks(`${mark(1, 0)}a${mark(0, 0)}`, 'nonce1234', 0)).toEqual({ text: 'a' })
  })
})
