/* Helpers for transcribed notes: naming, picking the top line out of a
   polyphonic part, and writing a MIDI file. Kept out of the component so
   scripts/notes-test.mjs can check them */
import type { NoteEvent } from '../../../shared/types'

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/* 52 reads as 'E3' (scientific pitch, middle C is C4) */
export function noteName(pitch: number): string {
  return `${NAMES[((pitch % 12) + 12) % 12]}${Math.floor(pitch / 12) - 1}`
}

export function isBlackKey(pitch: number): boolean {
  return [1, 3, 6, 8, 10].includes(((pitch % 12) + 12) % 12)
}

// how far past the middle of a part a note can sit and still set the range
const RANGE_REACH = 7

/* The pitches a part lives in, for the roll's height: the middle 90% of its
   notes, stretched to take in anything within a fifth of that. One stray
   overtone two octaves up would otherwise squash the part into thin rows. */
export function pitchRange(notes: NoteEvent[]): { low: number; high: number } {
  if (notes.length === 0) return { low: 48, high: 72 }
  const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b)
  const core = (q: number): number => pitches[Math.min(pitches.length - 1, Math.floor(q * pitches.length))]
  const from = core(0.05) - RANGE_REACH
  const to = core(0.95) + RANGE_REACH
  const inside = pitches.filter((p) => p >= from && p <= to)
  return { low: inside[0], high: inside[inside.length - 1] }
}

/* notes sounding at a moment, lowest first */
export function notesAt(notes: NoteEvent[], position: number): NoteEvent[] {
  return notes.filter((n) => n.start <= position && position < n.end).sort((a, b) => a.pitch - b.pitch)
}

// two onsets this close together count as struck at the same time
const SAME_ONSET = 0.06
// how far above a louder note an overtone is usually heard: an octave, an
// octave and a fifth, two octaves
const OVERTONES = [12, 19, 24]

// an overtone comes out well under the note that makes it: on test riffs
// at most about two thirds as loud, where a played octave is about as loud
const OVERTONE_LEVEL = 0.75

/* An overtone the model heard as a note of its own: it starts with a much
   louder note one of the usual intervals below. Left in, it would win the
   top line over the note actually played. */
export function isOvertone(note: NoteEvent, notes: NoteEvent[]): boolean {
  return notes.some(
    (other) =>
      other !== note &&
      OVERTONES.includes(note.pitch - other.pitch) &&
      Math.abs(other.start - note.start) <= SAME_ONSET &&
      note.velocity <= other.velocity * OVERTONE_LEVEL
  )
}

/* The top line of a part: at each onset, the highest note struck, cut short
   where the next one starts so only one sounds at a time. On a guitar stem
   that holds rhythm and lead together this is mostly the lead, or the top
   string of the chords where there is no lead. Expects notes sorted by start. */
export function topLine(notes: NoteEvent[]): NoteEvent[] {
  const candidates = notes.filter((n) => !isOvertone(n, notes))
  const kept: NoteEvent[] = []
  for (const note of candidates) {
    const beaten = candidates.some(
      (other) =>
        other !== note &&
        other.pitch > note.pitch &&
        other.start <= note.start + SAME_ONSET &&
        other.end > note.start + SAME_ONSET
    )
    if (beaten) continue
    const prev = kept[kept.length - 1]
    if (prev && Math.abs(prev.start - note.start) <= SAME_ONSET) {
      // struck together: the higher one already won, keep it
      if (prev.pitch >= note.pitch) continue
      kept.pop()
    }
    kept.push(note)
  }
  return kept.map((note, i) => {
    const next = kept[i + 1]
    if (!next || next.start >= note.end) return note
    const end = Math.max(note.start + 0.02, next.start)
    // a bend sampled over the old length has to shrink with it
    if (!note.bend) return { ...note, end }
    const keep = Math.max(1, Math.round((note.bend.length * (end - note.start)) / (note.end - note.start)))
    return { ...note, end, bend: note.bend.slice(0, keep) }
  })
}

/* ---------- MIDI ---------- */

const PPQ = 480

// General MIDI programs (zero based) that sound like each stem
const PROGRAMS: Record<string, number> = {
  guitar: 29, // overdriven guitar
  bass: 33, // electric bass, finger
  piano: 0,
  vocals: 53, // voice oohs
  other: 0
}

function varLen(value: number): number[] {
  let v = Math.max(0, Math.round(value))
  const bytes = [v & 0x7f]
  v >>= 7
  while (v > 0) {
    bytes.unshift((v & 0x7f) | 0x80)
    v >>= 7
  }
  return bytes
}

function text(s: string): number[] {
  return Array.from(new TextEncoder().encode(s))
}

/* A type 0 MIDI file of the notes. The tempo only lays out bars in a DAW;
   every note lands at its own time whatever it is. Pitch bends are written
   for notes that sound alone (one channel has one bend wheel), in the
   standard two semitone range, the way Basic Pitch writes them. */
export function notesToMidi(
  notes: NoteEvent[],
  opts: { tempo?: number | null; stem?: string; name?: string } = {}
): Uint8Array<ArrayBuffer> {
  const bpm = opts.tempo && opts.tempo > 0 ? opts.tempo : 120
  const ticks = (seconds: number): number => Math.round((seconds * bpm * PPQ) / 60)
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.pitch - b.pitch)

  // events as [tick, order, bytes]; order puts note-offs before note-ons
  // and bend resets on the same tick
  const events: [number, number, number[]][] = []
  sorted.forEach((note, i) => {
    const on = ticks(note.start)
    const off = Math.max(on + 1, ticks(note.end))
    const pitch = Math.max(0, Math.min(127, note.pitch))
    const velocity = Math.max(1, Math.min(127, Math.round(note.velocity)))
    events.push([on, 2, [0x90, pitch, velocity]])
    events.push([off, 0, [0x80, pitch, 0]])
    const alone = !sorted.some((other, j) => j !== i && other.start < note.end && other.end > note.start)
    if (alone && note.bend && note.bend.length > 0) {
      const step = (note.end - note.start) / note.bend.length
      let last = 0
      note.bend.forEach((b, k) => {
        const value = Math.max(-8192, Math.min(8191, Math.round((b * 4096) / 3)))
        if (value === last) return
        last = value
        const raw = value + 8192
        events.push([ticks(note.start + k * step), 1, [0xe0, raw & 0x7f, raw >> 7]])
      })
      if (last !== 0) events.push([off, 1, [0xe0, 0x00, 0x40]])
    }
  })
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1])

  const tempo = Math.round(60_000_000 / bpm)
  const name = text(opts.name ?? 'StemKit notes')
  const track: number[] = [
    0x00, 0xff, 0x03, ...varLen(name.length), ...name,
    0x00, 0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff,
    0x00, 0xc0, PROGRAMS[opts.stem ?? ''] ?? 0
  ]
  let now = 0
  for (const [tick, , bytes] of events) {
    track.push(...varLen(tick - now), ...bytes)
    now = tick
  }
  track.push(0x00, 0xff, 0x2f, 0x00)

  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff]
  const length = track.length
  const chunk = [0x4d, 0x54, 0x72, 0x6b, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff]
  return new Uint8Array([...header, ...chunk, ...track])
}
