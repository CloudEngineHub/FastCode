import { describe, expect, it } from 'vitest'
import { savedCard } from '../src/index.ts'

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/gu, '')
const saved = { savedTokens: 2402, rawTokens: 3080 }

describe('the card that says what a conversation saved', () => {
  it('draws a small jar beside the tokens saved and a bar for how much shorter the outputs it shortened got, in English', () => {
    expect(savedCard(saved, { lines: true })).toBe([
      ' ▗▄▄▖',
      '▗▛●░▜▖ TokenWise · saved 2,402 tokens in this conversation',
      '▐●●●●▌ ▰▰▰▰▰▰▰▰▱▱ 78% off',
    ].join('\n'))
    // The jar fills with the share: a little saved is still one coin.
    expect(savedCard({ savedTokens: 12, rawTokens: 5000 }, { lines: true })).toBe([
      ' ▗▄▄▖',
      '▗▛░░▜▖ TokenWise · saved 12 tokens in this conversation',
      '▐●···▌ ▱▱▱▱▱▱▱▱▱▱ under 1% off',
    ].join('\n'))
  })

  it('fits each agent: colour, a title of its own, a label before the first line, a lid that survives trimming, or one line', () => {
    const coloured = savedCard(saved, { lines: true, color: true })!
    expect(coloured).toContain('\x1b[38;2;79;227;193m')
    expect(plain(coloured)).toBe(savedCard(saved, { lines: true }))
    expect(savedCard(saved, { lines: true, untitled: true })!.split('\n')[1]).toBe('▗▛●░▜▖ saved 2,402 tokens in this conversation')
    expect(savedCard(saved, { lines: true, breakFirst: true })!.startsWith('\n ▗▄▄▖\n')).toBe(true)
    // Grok trims a message's leading whitespace: a braille blank keeps the lid over the jar.
    expect(savedCard(saved, { lines: true, trimmed: true })!.trim().split('\n')[0]).toBe('\u2800▗▄▄▖')
    expect(savedCard(saved)).toBe('TokenWise · saved 2,402 tokens in this conversation ▰▰▰▰▰▰▰▰▱▱ 78% off')
  })

  it('fills as pi plays it: from nothing to the number, never past it', () => {
    const frame = (progress: number) => savedCard(saved, { lines: true, progress })!.split('\n')
    expect(frame(0).slice(1)).toEqual(['▗▛░░▜▖ TokenWise · saved 0 tokens in this conversation', '▐····▌ ▱▱▱▱▱▱▱▱▱▱ 78% off'])
    const counts = [0, 0.2, 0.4, 0.6, 0.8, 1].map(p => Number(/saved ([\d,]+)/u.exec(frame(p)[1]!)![1]!.replace(/,/gu, '')))
    expect(counts).toEqual([...counts].sort((a, b) => a - b))
    expect(counts.at(-1)).toBe(2402)
    expect(frame(2)).toEqual(frame(1))
  })

  it('says what learned rules saved, and once what TokenWise just learned', () => {
    const learned = { ...saved, learnedTokens: 1830 }
    expect(savedCard(learned, { lines: true })!.split('\n')[2]).toBe('▐●●●●▌ ▰▰▰▰▰▰▰▰▱▱ 78% off · 1,830 from learned rules')
    const news = 'output from python3 etl.py is now shorter for every agent (/tokenwise to see or undo)'
    expect(savedCard(learned, { lines: true }, news)).toBe([
      ' ▗▄▄▖',
      '▗▛●░▜▖ TokenWise · saved 2,402 tokens in this conversation',
      '▐●●●●▌ ▰▰▰▰▰▰▰▰▱▱ 78% off · 1,830 from learned rules',
      '       ✦ Just learned: output from python3 etl.py is now shorter for every agent (/tokenwise to see or undo)',
    ].join('\n'))
    expect(savedCard(saved, {}, news)).toBe('TokenWise · saved 2,402 tokens in this conversation ▰▰▰▰▰▰▰▰▱▱ 78% off'
      + ' · ✦ Just learned: output from python3 etl.py is now shorter for every agent (/tokenwise to see or undo)')
    // Nothing saved (or nothing more): the news alone.
    expect(savedCard(undefined, { lines: true, breakFirst: true }, news)).toBe(`\nTokenWise ✦ Just learned: ${news}`)
    expect(savedCard({ savedTokens: 0, rawTokens: 10 }, { lines: true, untitled: true }, news)).toBe(`✦ Just learned: ${news}`)
    expect(plain(savedCard(learned, { lines: true, color: true }, news)!)).toBe(savedCard(learned, { lines: true }, news))
    // pi's fill counts the learned part up too, never past the whole.
    expect(savedCard(learned, { lines: true, progress: 0 })!.split('\n')[2]).toContain('· 0 from learned rules')
  })

  it('says nothing for a conversation that saved nothing', () => {
    expect(savedCard({ savedTokens: 0, rawTokens: 400 }, { lines: true })).toBeUndefined()
    expect(savedCard({ savedTokens: -50, rawTokens: 400 })).toBeUndefined()
  })

  it('can say another row than what was just learned, with its own label', () => {
    const off = { label: 'Switched off:', text: 'rule etl-batch-progress, since the agent asked for the original 3 of 7 times it shortened output (/tokenwise to see or bring it back)' }
    expect(savedCard(saved, { lines: true }, off)!.split('\n')[3])
      .toBe('       ✦ Switched off: rule etl-batch-progress, since the agent asked for the original 3 of 7 times it shortened output (/tokenwise to see or bring it back)')
    // With nothing saved, said on its own; on one line, after the bar.
    expect(savedCard(undefined, {}, off)).toBe(`TokenWise ✦ Switched off: ${off.text}`)
    expect(savedCard(saved, {}, off)).toBe(`TokenWise · saved 2,402 tokens in this conversation ▰▰▰▰▰▰▰▰▱▱ 78% off · ✦ Switched off: ${off.text}`)
    expect(savedCard(saved, { lines: true }, 'output from x is now shorter')!.split('\n')[3]).toBe('       ✦ Just learned: output from x is now shorter')
  })
})
