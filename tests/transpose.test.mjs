import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerTsHooks } from './helpers/ts-resolve.mjs'

const hooks = registerTsHooks()
const { transposeChordLabel, transposeChords, transposeNotes, shiftedTitle } = await import(
  new URL('../src/shared/transpose.ts', import.meta.url).href
)
hooks.deregister()

test('chord labels move their root and keep the quality', () => {
  assert.equal(transposeChordLabel('C:maj', 2), 'D:maj')
  assert.equal(transposeChordLabel('A#:min7', 3), 'C#:min7')
  assert.equal(transposeChordLabel('B', 1), 'C')
  assert.equal(transposeChordLabel('C', -1), 'B')
  assert.equal(transposeChordLabel('Bb', 2), 'C')
  assert.equal(transposeChordLabel('F#m', -6), 'Cm')
  assert.equal(transposeChordLabel('N', 4), 'N')
  assert.equal(transposeChordLabel('E:min', 0), 'E:min')
})

test('shifting and unshifting a chord gives it back', () => {
  for (const root of ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']) {
    for (let n = -6; n <= 6; n++) {
      assert.equal(transposeChordLabel(transposeChordLabel(`${root}:7`, n), -n), `${root}:7`)
    }
  }
})

const chords = {
  key: { tonic: 'G', mode: 'major', name: 'G major', confidence: 0.8, alternative: 'E minor', relative: 'E minor' },
  tempo: 120,
  beats: [0, 0.5],
  segments: [
    { start: 0, end: 1, label: 'G:maj', raw: 'G:maj' },
    { start: 1, end: 2, label: 'N', raw: 'N' },
    { start: 2, end: 3, label: 'E:min', raw: 'E:min', user: 'C:maj' }
  ],
  duration: 3,
  source: 'mix',
  model: 'test'
}

test('chord data shifts every label and the key, leaving timing alone', () => {
  const up = transposeChords(chords, 2)
  assert.deepEqual(up.segments.map((s) => s.label), ['A:maj', 'N', 'F#:min'])
  assert.equal(up.segments[2].user, 'D:maj')
  assert.equal(up.segments[0].start, 0)
  assert.equal(up.key.name, 'A major')
  assert.equal(up.key.relative, 'F# minor')
  assert.deepEqual(up.beats, chords.beats)
  assert.equal(chords.segments[0].label, 'G:maj', 'the stored data is not touched')
  assert.equal(transposeChords(chords, 0), chords)
})

test('notes move by semitones and drop off the MIDI range', () => {
  const data = {
    stem: 'bass',
    notes: [
      { start: 0, end: 1, pitch: 40, velocity: 90 },
      { start: 1, end: 2, pitch: 1, velocity: 90 },
      { start: 2, end: 3, pitch: 126, velocity: 90, bend: [0, 1] }
    ],
    duration: 3,
    source: 'bass',
    model: 'test'
  }
  assert.deepEqual(transposeNotes(data, -3).notes.map((n) => n.pitch), [37, 123])
  assert.deepEqual(transposeNotes(data, 2).notes.map((n) => n.pitch), [42, 3])
  assert.equal(transposeNotes(data, 2).notes[0].velocity, 90)
  assert.equal(data.notes[0].pitch, 40)
  assert.equal(transposeNotes(data, 0), data)
})

test('downloads of a shifted view carry the shift in their name', () => {
  assert.equal(shiftedTitle('Song', 0), 'Song')
  assert.equal(shiftedTitle('Song', 2), 'Song (+2 st)')
  assert.equal(shiftedTitle('Song', -3), 'Song (-3 st)')
})
