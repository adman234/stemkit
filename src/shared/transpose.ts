import type { ChordData, ChordSegment, NoteData } from './types'

/* Pitch shifting moves everything the player shows along with the audio:
   chord labels, the key, and the transcribed notes (so the note roll, the
   tab and the MIDI/text downloads follow it). Stored data never changes;
   these make shifted copies for display, and unshift turns a chord picked
   in the shifted view back into the song's own pitch before it is saved. */

// chords.json spells roots with sharps (see CHORD_LABEL on the server)
const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

const mod12 = (n: number): number => ((n % 12) + 12) % 12

const ROOT = /^([A-G])([#b♯♭]?)/

// moves the leading note name of a chord label ('F#:min7', 'Bb', 'N' stays)
export function transposeChordLabel(label: string, semitones: number): string {
  if (!semitones) return label
  const m = ROOT.exec(label)
  if (!m) return label
  const accidental = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0
  const pc = mod12(LETTER[m[1]] + accidental + semitones)
  return SHARPS[pc] + label.slice(m[0].length)
}

function shiftSegment(seg: ChordSegment, semitones: number): ChordSegment {
  const out: ChordSegment = {
    ...seg,
    label: transposeChordLabel(seg.label, semitones),
    raw: transposeChordLabel(seg.raw, semitones)
  }
  if (seg.user !== undefined) out.user = transposeChordLabel(seg.user, semitones)
  return out
}

export function transposeChords(data: ChordData, semitones: number): ChordData {
  if (!semitones) return data
  return {
    ...data,
    key: {
      ...data.key,
      tonic: transposeChordLabel(data.key.tonic, semitones),
      name: transposeChordLabel(data.key.name, semitones),
      alternative: transposeChordLabel(data.key.alternative, semitones),
      relative: transposeChordLabel(data.key.relative, semitones)
    },
    segments: data.segments.map((s) => shiftSegment(s, semitones))
  }
}

// MIDI note numbers stay inside 0..127; a note pushed past either end is dropped
export function transposeNotes(data: NoteData, semitones: number): NoteData {
  if (!semitones) return data
  return {
    ...data,
    notes: data.notes
      .map((n) => ({ ...n, pitch: n.pitch + semitones }))
      .filter((n) => n.pitch >= 0 && n.pitch <= 127)
  }
}

// the name a download gets when the view is shifted, e.g. 'Song (+2)'
export function shiftedTitle(title: string, semitones: number): string {
  if (!semitones) return title
  return `${title} (${semitones > 0 ? '+' : '-'}${Math.abs(semitones)} st)`
}
