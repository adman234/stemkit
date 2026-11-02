// Checks the note helpers: names, the top line picked out of a chordal part,
// overtones kept out of it, and the MIDI file read back event by event.
// Run with: npm run web:test
import { build } from 'esbuild'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const bundle = join(mkdtempSync(join(tmpdir(), 'stemkit-')), 'notes.mjs')
await build({
  entryPoints: [new URL('../src/renderer/src/lib/notes.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'error'
})
const { noteName, isBlackKey, pitchRange, notesAt, isOvertone, topLine, notesToMidi } = await import(
  pathToFileURL(bundle).href
)

const checks = []
const near = (a, b, tolerance = 0.002) => Math.abs(a - b) < tolerance
const note = (start, end, pitch, velocity = 90, bend) => ({ start, end, pitch, velocity, ...(bend ? { bend } : {}) })

// names
checks.push(['middle C is C4', noteName(60) === 'C4'])
checks.push(['low E on a guitar is E2', noteName(40) === 'E2'])
checks.push(['A440 is A4', noteName(69) === 'A4'])
checks.push(['sharps are spelled with #', noteName(61) === 'C#4' && isBlackKey(61) && !isBlackKey(64)])
checks.push(['range of a part', JSON.stringify(pitchRange([note(0, 1, 50), note(1, 2, 64)])) === '{"low":50,"high":64}'])
{
  const part = [...Array(200)].map((_, i) => note(i, i + 1, 50 + (i % 15)))
  part.push(note(300, 301, 97), note(301, 302, 30))
  checks.push(['range ignores a stray note far outside the part', JSON.stringify(pitchRange(part)) === '{"low":50,"high":64}'])
}
checks.push(['notes sounding at a moment, lowest first', notesAt([note(0, 2, 64), note(1, 3, 52), note(3, 4, 55)], 1.5).map((n) => n.pitch).join() === '52,64'])

// a lead line over a held chord: the lead wins wherever it plays
{
  const chord = [note(0, 4, 40), note(0, 4, 47), note(0, 4, 52)]
  const lead = [note(1, 1.5, 64), note(1.5, 2, 67), note(2, 3, 69)]
  const line = topLine([...chord, ...lead].sort((a, b) => a.start - b.start))
  checks.push([
    'top line: the chord top, then the lead',
    line.map((n) => n.pitch).join() === '52,64,67,69'
  ])
  checks.push(['top line: the chord top is cut where the lead starts', near(line[0].end, 1)])
  checks.push(['top line: one note at a time', line.every((n, i) => i === 0 || line[i - 1].end <= n.start + 1e-9)])
}

// an octave overtone the model heard alongside a played note
{
  const played = note(0, 0.5, 52, 100)
  const ghost = note(0.01, 0.4, 64, 60)
  checks.push(['an octave above a louder note is an overtone', isOvertone(ghost, [played, ghost])])
  checks.push(['a louder note above is not', !isOvertone(note(0, 0.5, 64, 110), [played])])
  checks.push(['a fourth above is not', !isOvertone(note(0, 0.5, 57, 50), [played])])
  checks.push(['a played octave, about as loud, is not', !isOvertone(note(0, 0.5, 64, 90), [played])])
  const line = topLine([played, ghost])
  checks.push(['top line skips the overtone', line.length === 1 && line[0].pitch === 52])
}

// a riff with a bend: shortening a note shortens its bend samples
{
  const line = topLine([note(0, 1, 59, 90, [0, 0, 1, 2, 3, 3, 3, 3, 3, 3]), note(0.5, 1, 62)])
  checks.push(['a shortened bend keeps its start', line[0].bend.join() === '0,0,1,2,3'])
}

/* ---------- MIDI read back ---------- */

function readMidi(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const str = (o, n) => String.fromCharCode(...bytes.slice(o, o + n))
  if (str(0, 4) !== 'MThd') throw new Error('no header')
  const ppq = view.getUint16(12)
  if (str(14, 4) !== 'MTrk') throw new Error('no track')
  const end = 22 + view.getUint32(18)
  let p = 22
  let tick = 0
  let tempo = 500000
  const events = []
  const vlq = () => {
    let v = 0
    for (;;) {
      const b = bytes[p++]
      v = (v << 7) | (b & 0x7f)
      if (!(b & 0x80)) return v
    }
  }
  while (p < end) {
    tick += vlq()
    const status = bytes[p++]
    if (status === 0xff) {
      const type = bytes[p++]
      const len = vlq()
      if (type === 0x51) tempo = (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2]
      events.push({ tick, meta: type })
      p += len
    } else if ((status & 0xf0) === 0xc0) {
      events.push({ tick, program: bytes[p++] })
    } else {
      events.push({ tick, status: status & 0xf0, a: bytes[p++], b: bytes[p++] })
    }
  }
  const seconds = (t) => (t * tempo) / 1_000_000 / ppq
  return { ppq, tempo, events, seconds, end: p === end }
}

{
  const notes = [
    note(0.5, 1.0, 52, 80),
    note(1.0, 1.5, 55, 100),
    note(2.0, 3.0, 59, 70, [0, 0, 3, 6, 6, 6]),
    note(4.0, 5.0, 40, 60),
    note(4.0, 5.0, 47, 60, [3, 3])
  ]
  const midi = readMidi(notesToMidi(notes, { tempo: 100, stem: 'guitar' }))
  const ons = midi.events.filter((e) => e.status === 0x90)
  const offs = midi.events.filter((e) => e.status === 0x80)
  const bends = midi.events.filter((e) => e.status === 0xe0)
  checks.push(['MIDI: the track parses to its end', midi.end])
  checks.push(['MIDI: tempo is written', near(60_000_000 / midi.tempo, 100, 0.01)])
  checks.push(['MIDI: a guitar program', midi.events.some((e) => e.program === 29)])
  checks.push(['MIDI: every note on and off', ons.length === 5 && offs.length === 5])
  checks.push([
    'MIDI: notes land at their times',
    notes.every((n) => ons.some((e) => e.a === n.pitch && near(midi.seconds(e.tick), n.start, 0.002)))
  ])
  checks.push([
    'MIDI: and end at their times',
    notes.every((n) => offs.some((e) => e.a === n.pitch && near(midi.seconds(e.tick), n.end, 0.002)))
  ])
  checks.push(['MIDI: velocities kept', ons.find((e) => e.a === 55).b === 100])
  const value = (e) => ((e.b << 7) | e.a) - 8192
  checks.push([
    'MIDI: a two semitone bend reaches the top of the wheel, then resets',
    bends.some((e) => value(e) === 8191) && value(bends[bends.length - 1]) === 0
  ])
  checks.push([
    'MIDI: no bends on notes that sound together',
    bends.every((e) => midi.seconds(e.tick) < 3.5)
  ])
  const offBeforeOn = midi.events.findIndex((e) => e.status === 0x80 && e.a === 52) <
    midi.events.findIndex((e) => e.status === 0x90 && e.a === 55)
  checks.push(['MIDI: a note ends before the next one on the same tick starts', offBeforeOn])
}

let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
