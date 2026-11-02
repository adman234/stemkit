/* Guitar and bass tab from transcribed notes: which string and fret each note
   is played on, and a plain text tab laid out in bars. Kept out of the
   component so scripts/notes-test.mjs can check it */
import type { NoteEvent, StemId } from '../../../shared/types'

export interface Tuning {
  id: string
  name: string
  // open strings as MIDI pitches, lowest string first
  strings: number[]
}

export const GUITAR_TUNINGS: Tuning[] = [
  { id: 'standard', name: 'Standard', strings: [40, 45, 50, 55, 59, 64] },
  { id: 'drop-d', name: 'Drop D', strings: [38, 45, 50, 55, 59, 64] },
  { id: 'half-down', name: 'Half step down', strings: [39, 44, 49, 54, 58, 63] },
  { id: 'd-standard', name: 'D standard', strings: [38, 43, 48, 53, 57, 62] },
  { id: 'drop-c', name: 'Drop C', strings: [36, 43, 48, 53, 57, 62] }
]

export const BASS_TUNINGS: Tuning[] = [
  { id: 'standard', name: 'Standard', strings: [28, 33, 38, 43] },
  { id: 'drop-d', name: 'Drop D', strings: [26, 33, 38, 43] },
  { id: 'half-down', name: 'Half step down', strings: [27, 32, 37, 42] },
  { id: 'five-string', name: '5 string', strings: [23, 28, 33, 38, 43] }
]

/* the tunings that make sense for a stem; none means no tab for it. The
   "other" stem of a four stem split is where the guitar ends up */
export function tuningsFor(stem: StemId | string): Tuning[] {
  if (stem === 'guitar' || stem === 'other') return GUITAR_TUNINGS
  if (stem === 'bass') return BASS_TUNINGS
  return []
}

export const MAX_FRET = 22

export interface TabNote extends NoteEvent {
  // 0 is the lowest string
  string: number
  fret: number
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const FLATS: Record<string, string> = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb' }

/* string names, lowest first, the way tab prints them: E A D G B e. Sharps
   are written as flats, since the usual detuned guitar is "Eb" */
export function stringNames(tuning: Tuning): string[] {
  const names = tuning.strings.map((p) => {
    const n = NAMES[((p % 12) + 12) % 12]
    return FLATS[n] ?? n
  })
  const top = names.length - 1
  if (names[top] === names[0]) names[top] = names[top].toLowerCase()
  return names
}

// two onsets this close together count as struck at the same time
const SAME_ONSET = 0.06
// frets under the hand without moving it: the index finger's and three more
const HAND_SPAN = 4
// keep this many of the cheapest shapes for each chord
const SHAPES_KEPT = 24

interface Shape {
  frets: number[] // per note in the group, matching `strings`
  strings: number[]
  cost: number
  // lowest and highest fret held down; held is false when all are open
  low: number
  high: number
  held: boolean
}

/* every way to play a group of pitches on separate strings */
function shapes(pitches: number[], tuning: number[]): Shape[] {
  const out: Shape[] = []
  const strings: number[] = []
  const frets: number[] = []
  const walk = (i: number): void => {
    if (out.length > 2000) return
    if (i === pitches.length) {
      const held = frets.filter((f) => f > 0)
      const low = held.length ? Math.min(...held) : 0
      const high = held.length ? Math.max(...held) : 0
      const stretch = high - low
      if (stretch > 5) return
      // compact shapes first; a stretch past the hand is possible but
      // unlikely, and so is the top of the neck
      let cost = stretch * 0.15 + Math.max(0, stretch - (HAND_SPAN - 1)) * 3
      for (const f of held) if (f > 15) cost += 0.3
      out.push({ frets: [...frets], strings: [...strings], cost, low, high, held: held.length > 0 })
      return
    }
    for (let s = 0; s < tuning.length; s++) {
      if (strings.includes(s)) continue
      const fret = pitches[i] - tuning[s]
      if (fret < 0 || fret > MAX_FRET) continue
      strings.push(s)
      frets.push(fret)
      walk(i + 1)
      strings.pop()
      frets.pop()
    }
  }
  walk(0)
  return out.sort((a, b) => a.cost - b.cost).slice(0, SHAPES_KEPT)
}

/* where the hand can sit (the index finger's fret) to play a shape */
function handsFor(shape: Shape): number[] {
  const from = Math.max(1, shape.high - (HAND_SPAN - 1))
  if (from > shape.low) return [shape.low]
  const out: number[] = []
  for (let h = from; h <= shape.low; h++) out.push(h)
  return out
}

/* what a shape costs with the hand at a position: a slight pull towards the
   nut, and open strings are odd once the hand is up the neck, where a
   player in position would fret the same note */
function placeCost(shape: Shape, hand: number): number {
  return shape.cost + hand * 0.06 + (hand > 4 ? shape.frets.filter((f) => f === 0).length * 0.8 : 0)
}

/* a chord's shape wherever it sits: strings and frets relative to its
   lowest string, with open strings written apart */
function shapeOf(shape: Shape): string {
  const base = Math.min(...shape.strings)
  const order = shape.strings.map((s, i) => [s - base, shape.frets[i]]).sort((a, b) => a[0] - b[0])
  const fretBase = shape.held ? shape.low : 0
  return order.map(([s, f]) => `${s}:${f === 0 ? 'o' : f - fretBase}`).join(',')
}

/* moving from one place to the next: shifting the hand costs more the less
   time there is to do it, and a single note line stays on nearby strings */
function moveCost(from: Shape, fromHand: number, to: Shape, toHand: number, gap: number): number {
  let cost = 0
  if (fromHand !== toHand) {
    const rush = gap < 0.25 ? 1.5 : gap > 1.5 ? 0.3 : 1
    cost += (0.8 + 0.35 * Math.abs(fromHand - toHand)) * rush
  }
  if (from.strings.length === 1 && to.strings.length === 1) cost += Math.abs(from.strings[0] - to.strings[0]) * 0.25
  // chords of the same size: a player keeps the shape and moves it
  else if (from.strings.length === to.strings.length && shapeOf(from) !== shapeOf(to)) cost += 0.5
  return cost
}

/* pitches outside the instrument move by octaves until they fit */
function fold(pitch: number, tuning: number[]): number {
  let p = pitch
  while (p < tuning[0]) p += 12
  while (p > tuning[tuning.length - 1] + MAX_FRET) p -= 12
  return p
}

/* Picks a string and fret for every note, the way a player would: chords as
   playable shapes, and lines kept in one hand position where they can be.
   A cheapest path through every possible shape of every chord (Viterbi), so
   a shape is chosen for where the part goes next as well as where it was.
   Notes that cannot be played together (more than one per string) lose
   their quietest first. */
export function fingerTab(notes: NoteEvent[], tuning: Tuning): TabNote[] {
  const strings = tuning.strings
  const sorted = [...notes].sort((a, b) => a.start - b.start || b.pitch - a.pitch)

  // notes struck together
  const groups: NoteEvent[][] = []
  for (const note of sorted) {
    const last = groups[groups.length - 1]
    if (last && note.start - last[0].start <= SAME_ONSET) last.push(note)
    else groups.push([note])
  }

  // for each group, the notes kept and the shapes they could take
  const options: { notes: NoteEvent[]; pitches: number[]; shapes: Shape[] }[] = []
  for (const group of groups) {
    // the same pitch twice in one strike is one note
    const byPitch = new Map<number, NoteEvent>()
    for (const n of group) {
      const p = fold(n.pitch, strings)
      const seen = byPitch.get(p)
      if (!seen || n.velocity > seen.velocity) byPitch.set(p, n)
    }
    let kept = [...byPitch.entries()]
      .sort((a, b) => b[1].velocity - a[1].velocity)
      .slice(0, strings.length)
    let found = shapes(
      kept.map(([p]) => p),
      strings
    )
    while (!found.length && kept.length > 1) {
      kept = kept.slice(0, -1)
      found = shapes(
        kept.map(([p]) => p),
        strings
      )
    }
    if (!found.length) continue
    options.push({ notes: kept.map(([, n]) => n), pitches: kept.map(([p]) => p), shapes: found })
  }
  if (!options.length) return []

  // cheapest path over (shape, hand position) states. A shape of open
  // strings only leaves the hand where it was
  interface State {
    shape: number
    hand: number
    cost: number
    back: number
  }
  const first = options[0]
  let row: State[] = []
  first.shapes.forEach((shape, k) => {
    for (const hand of shape.held ? handsFor(shape) : [1]) row.push({ shape: k, hand, cost: placeCost(shape, hand), back: -1 })
  })
  const rows: State[][] = [row]
  for (let i = 1; i < options.length; i++) {
    const prev = rows[i - 1]
    const prevShapes = options[i - 1].shapes
    const gap = options[i].notes[0].start - options[i - 1].notes[0].start
    const carried = [...new Set(prev.map((s) => s.hand))]
    row = []
    options[i].shapes.forEach((shape, k) => {
      for (const hand of shape.held ? handsFor(shape) : carried) {
        let best = Infinity
        let back = 0
        prev.forEach((s, j) => {
          const c = s.cost + moveCost(prevShapes[s.shape], s.hand, shape, hand, gap)
          if (c < best) {
            best = c
            back = j
          }
        })
        row.push({ shape: k, hand, cost: best + placeCost(shape, hand), back })
      }
    })
    rows.push(row)
  }

  const last = rows[rows.length - 1]
  let j = last.reduce((b, s, idx) => (s.cost < last[b].cost ? idx : b), 0)
  const out: TabNote[] = []
  for (let i = options.length - 1; i >= 0; i--) {
    const state = rows[i][j]
    const shape = options[i].shapes[state.shape]
    options[i].notes.forEach((n, m) => out.push({ ...n, string: shape.strings[m], fret: shape.frets[m] }))
    j = state.back
  }
  return out.sort((a, b) => a.start - b.start || a.string - b.string)
}

/* a bend worth writing down: at least about a semitone at its peak
   (bends come in thirds of a semitone) */
export function bendMark(note: NoteEvent): string {
  if (!note.bend || !note.bend.length) return ''
  const up = Math.max(...note.bend)
  return up >= 2.5 ? 'b' : ''
}

/* ---------- text tab ---------- */

// sixteenths: four slots to a beat
const SLOTS_PER_BEAT = 4
const BEATS_PER_BAR = 4
// a line of tab is cut before it gets wider than this
const LINE_WIDTH = 96

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/* a beat grid that covers every note: the chord pass's beats where there are
   some, stretched at their own pace to either side, or a steady tempo */
function beatGrid(notes: TabNote[], beats: number[] | undefined, tempo: number | null | undefined): number[] {
  const first = notes[0].start
  const last = Math.max(...notes.map((n) => n.end))
  let grid: number[]
  if (beats && beats.length >= 4) {
    grid = [...beats]
  } else {
    const step = 60 / (tempo && tempo > 0 ? tempo : 120)
    grid = [0, step]
  }
  // a doubled beat would stall the padding below
  const stepAt = (i: number): number => Math.max(0.1, grid[i + 1] - grid[i])
  // pad by whole bars so bar lines stay put
  while (grid[0] > first) {
    const step = stepAt(0)
    for (let i = 0; i < BEATS_PER_BAR; i++) grid.unshift(grid[0] - step)
  }
  while (grid[grid.length - 1] <= last) grid.push(grid[grid.length - 1] + stepAt(grid.length - 2))
  return grid
}

/* where a moment falls on the grid, in sixteenths from the first beat */
function slotOf(t: number, grid: number[]): number {
  let lo = 0
  let hi = grid.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (grid[mid] <= t) lo = mid
    else hi = mid
  }
  const frac = (t - grid[lo]) / (grid[lo + 1] - grid[lo])
  return lo * SLOTS_PER_BEAT + Math.round(frac * SLOTS_PER_BEAT)
}

/* The tab as text, the way it is posted online: one row per string, high
   string on top, bars of 4/4 in sixteenths on the beat grid, a time stamp
   over each line and runs of empty bars left out. The bar lines start on the
   first beat found, which is not always the downbeat. */
export function tabToText(
  notes: TabNote[],
  tuning: Tuning,
  opts: { beats?: number[]; tempo?: number | null; title?: string; source?: string } = {}
): string {
  const names = stringNames(tuning)
  const width = Math.max(...names.map((n) => n.length))
  const label = names.map((n) => n.padEnd(width, ' '))
  const header = [
    opts.title ?? 'Tab',
    `Tuning: ${tuning.name} (${[...names].join(' ')})${opts.tempo ? `, about ${Math.round(opts.tempo)} BPM` : ''}`,
    `${opts.source ?? 'Transcribed by StemKit'}. Machine made: check it by ear.`,
    ''
  ]
  if (!notes.length) return [...header, '(no notes)', ''].join('\n')

  const grid = beatGrid(notes, opts.beats, opts.tempo)
  const slotsPerBar = SLOTS_PER_BEAT * BEATS_PER_BAR
  // cells[bar][slot][string] = text
  const bars = new Map<number, Map<number, string[]>>()
  for (const n of notes) {
    const slot = slotOf(n.start, grid)
    const bar = Math.floor(slot / slotsPerBar)
    const at = slot - bar * slotsPerBar
    if (!bars.has(bar)) bars.set(bar, new Map())
    const cols = bars.get(bar)!
    if (!cols.has(at)) cols.set(at, Array(tuning.strings.length).fill(''))
    const col = cols.get(at)!
    // two quick notes landing in one sixteenth on one string: the first stays
    if (!col[n.string]) col[n.string] = `${n.fret}${bendMark(n)}`
  }

  const barText = (bar: number): string[] => {
    const cols = bars.get(bar)
    const rows = tuning.strings.map(() => '')
    for (let slot = 0; slot < slotsPerBar; slot++) {
      const col = cols?.get(slot)
      const w = col ? Math.max(1, ...col.map((c) => c.length)) : 1
      for (let s = 0; s < rows.length; s++) rows[s] += (col?.[s] ?? '').padEnd(w, '-') + '-'
    }
    return rows
  }

  const lines: string[] = [...header]
  const used = [...bars.keys()].sort((a, b) => a - b)
  const lastBar = used[used.length - 1]
  let bar = used[0]
  while (bar <= lastBar) {
    // a run of empty bars is left out, saying how long it was; one empty bar
    // inside a phrase is a rest and stays
    const emptyRun = (from: number): number => {
      let end = from
      while (end <= lastBar && !bars.has(end)) end++
      return end - from
    }
    const gap = emptyRun(bar)
    if (gap >= 2) {
      lines.push(`(${gap} bars without notes)`, '')
      bar += gap
      continue
    }
    const rows = label.map((l) => `${l}|`)
    const start = grid[bar * BEATS_PER_BAR]
    while (bar <= lastBar && emptyRun(bar) < 2) {
      const next = barText(bar)
      if (rows[0].length > width + 1 && rows[0].length + next[0].length > LINE_WIDTH) break
      next.forEach((r, s) => (rows[s] += `${r}|`))
      bar++
    }
    lines.push(`[${clock(start)}]`)
    // high string on top
    for (let s = rows.length - 1; s >= 0; s--) lines.push(rows[s])
    lines.push('')
  }
  return lines.join('\n')
}
