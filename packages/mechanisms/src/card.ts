/**
 * What TokenWise saved in a conversation, at the end of a turn, as a small card:
 * the jar `tokenwise saved` draws, three rows tall: a mint jar of gold coins, the
 * tokens saved, and a bar for how much shorter that made the outputs TokenWise
 * shortened (of their originals only: output it left alone is not counted).
 *
 *      ▗▄▄▖
 *     ▗▛●░▜▖ TokenWise · saved 2,402 tokens in this conversation
 *     ▐●●●●▌ ▰▰▰▰▰▰▰▰▱▱ 78% off
 *
 * Learned rules' part of the saving follows the bar when there is one
 * ("· 1,830 from learned rules"), and once after a learning run adopted rules,
 * a fourth row says what TokenWise just learned (`news`); with nothing saved
 * yet, that row is said on its own.
 *
 * Always in English, whatever the locale (the person's decision, 2026-11-20).
 *
 * Agents show it differently, so the style says what this one can take: colour
 * (where escape codes reach the terminal), several lines, a title of its own (an
 * OpenCode toast has one), a label it puts before the first line. `progress`
 * draws one frame of the fill pi plays: the number counts up, the jar and the
 * bar fill.
 */
import type { ConversationSavings } from './conversation.ts'

export interface CardStyle {
  /** ANSI colour: only where the agent hands escape codes to the terminal. */
  readonly color?: boolean
  /** The three-row card; otherwise one line. */
  readonly lines?: boolean
  /** Start on a line of its own: the agent puts a label before the first line. */
  readonly breakFirst?: boolean
  /** Leave out "TokenWise": the agent shows it as the title. */
  readonly untitled?: boolean
  /** The agent trims the message's leading whitespace (Grok): the lid's first column is a braille blank, which stays. */
  readonly trimmed?: boolean
  /** One frame of the fill, 0 to 1; 1 (the default) is the card as it stays. */
  readonly progress?: number
}

type Rgb = readonly [number, number, number]
// TokenWise's colours (Cyber Mint): a mint jar of gold coins on ink, as in the logo.
const FRAME: Rgb = [62, 178, 152]
const FILL: readonly Rgb[] = [[255, 210, 74], [224, 165, 0]]
const EMPTY: Rgb = [52, 66, 62]
const MINT: Rgb = [79, 227, 193]
const BRIGHT: Rgb = [167, 255, 233]
const BAR_OFF: Rgb = [64, 80, 76]

const BAR_CELLS = 10
const JAR_CELLS = 6

/** Ease out: the count slows as it lands. */
const ease = (p: number) => 1 - (1 - p) ** 3

/** A row under the card, said once by its caller: what TokenWise just learned, or switched off. */
export interface CardNews { readonly label: string; readonly text: string }

/**
 * The card, or undefined when there is nothing to say. `news` is what a
 * learning run just taught TokenWise, as `adoptedPhrase` says it (with
 * where to see it), or another row with its own label.
 */
export function savedCard(summary: ConversationSavings | undefined, style: CardStyle = {}, news?: string | CardNews): string | undefined {
  const saved = summary?.savedTokens ?? 0
  const paint = (rgb: Rgb, text: string, bold = false) => style.color ? `\x1b[${bold ? '1;' : ''}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[0m` : text
  const title = style.untitled ? '' : `${paint(MINT, 'TokenWise', true)} · `
  const row = typeof news === 'string' ? { label: 'Just learned:', text: news } : news
  const learned = row ? `${paint(FILL[0]!, '✦')} ${paint(MINT, row.label, true)} ${row.text}` : undefined
  if (!(saved > 0)) return learned && `${style.breakFirst ? '\n' : ''}${style.untitled ? '' : `${paint(MINT, 'TokenWise', true)} `}${learned}`
  const p = Math.min(1, Math.max(0, style.progress ?? 1))
  const share = summary!.rawTokens > 0 ? Math.min(100, 100 * saved / summary!.rawTokens) : 0

  const tokens = Math.round(saved * ease(p)).toLocaleString('en-US')
  const percent = share >= 1 ? `${Math.round(share)}%` : 'under 1%'
  const said = `saved ${paint(BRIGHT, tokens, true)} tokens in this conversation`
  const byRules = summary!.learnedTokens ?? 0
  const off = `${percent} off`
    + (byRules > 0 ? ` · ${paint(BRIGHT, Math.round(Math.min(byRules, saved) * ease(p)).toLocaleString('en-US'))} from learned rules` : '')

  const filled = Math.round(share / 100 * BAR_CELLS * ease(p))
  const bar = paint(MINT, '▰'.repeat(filled)) + paint(BAR_OFF, '▱'.repeat(BAR_CELLS - filled))
  if (!style.lines) return `${style.breakFirst ? '\n' : ''}${title}${said} ${bar} ${off}${learned ? ` · ${learned}` : ''}`

  // Coins fill the jar from the bottom row, one per cell: four below, two in the shoulders; anything saved is at least one.
  const coins = Math.round(Math.max(1, Math.round(share / 100 * JAR_CELLS)) * ease(p))
  const cell = (index: number, empty: string) => index < coins ? paint(FILL[index % 2]!, '●') : paint(EMPTY, empty)
  const lid = paint(FRAME, `${style.trimmed ? '\u2800' : ' '}▗▄▄▖`)
  const top = paint(FRAME, '▗▛') + [4, 5].map(i => cell(i, '░')).join('') + paint(FRAME, '▜▖')
  const bottom = paint(FRAME, '▐') + [0, 1, 2, 3].map(i => cell(i, '·')).join('') + paint(FRAME, '▌')
  // The news row starts under the words, past the jar's six columns.
  return [`${style.breakFirst ? '\n' : ''}${lid}`, `${top} ${title}${said}`, `${bottom} ${bar} ${off}`, ...learned ? [`${' '.repeat(JAR_CELLS + 1)}${learned}`] : []].join('\n')
}
