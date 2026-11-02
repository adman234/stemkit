// Checks the note helpers: names, the top line picked out of a chordal part,
// overtones kept out of it, the MIDI file read back event by event, and the
// strings and frets picked for tab.
// Run with: npm run web:test
import { build } from 'esbuild'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const dir = mkdtempSync(join(tmpdir(), 'stemkit-'))
async function load(name) {
  const outfile = join(dir, `${name}.mjs`)
  await build({
    entryPoints: [new URL(`../src/renderer/src/lib/${name}.ts`, import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'error'
  })
  return import(pathToFileURL(outfile).href)
}
const { noteName, isBlackKey, pitchRange, notesAt, isOvertone, topLine, notesToMidi } = await load('notes')
const { fingerTab, tabToText, stringNames, tuningsFor, GUITAR_TUNINGS, BASS_TUNINGS } = await load('tab')

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

// tab
{
  const std = GUITAR_TUNINGS[0]
  const frets = (tab) => tab.map((n) => `${n.string}/${n.fret}`).join(' ')
  checks.push(['tab: string names', stringNames(std).join(' ') === 'E A D G B e' && stringNames(GUITAR_TUNINGS[2]).join(' ') === 'Eb Ab Db Gb Bb eb'])
  checks.push(['tab: a tuning for guitar, other and bass, none for vocals', tuningsFor('guitar').length > 0 && tuningsFor('other').length > 0 && tuningsFor('bass')[0].strings.length === 4 && tuningsFor('vocals').length === 0])
  // an open E major chord comes out as the open shape
  const chord = fingerTab([40, 47, 52, 56, 59, 64].map((p) => note(0, 1, p)), std)
  checks.push(['tab: open E chord', frets(chord) === '0/0 1/2 2/2 3/1 4/0 5/0'])
  // A minor pentatonic up the neck stays in the fifth position box
  const run = [45, 48, 50, 52, 55, 57, 60, 62, 64, 67, 69, 72]
  const box = fingerTab(run.map((p, i) => note(i * 0.2, i * 0.2 + 0.2, p)), std)
  checks.push(['tab: a pentatonic run stays in one position', box.every((n) => n.fret >= 5 && n.fret <= 8)])
  checks.push(['tab: every fret matches its pitch', box.every((n) => std.strings[n.string] + n.fret === n.pitch)])
  // a power chord shape slid along the A string keeps its shape
  const power = [45, 47, 48].flatMap((root, i) => [note(i, i + 0.5, root), note(i, i + 0.5, root + 7)])
  const slid = fingerTab(power, std)
  checks.push(['tab: a power chord keeps its shape', slid.length === 6 && slid.every((n, i) => n.string === (i % 2 ? 2 : 1) && n.fret === [0, 2, 2, 4, 3, 5][i])])
  // more notes than strings, or two on one string: the quietest go
  // E2 and F2 only fit on the low string
  const crowd = fingerTab([note(0, 1, 40, 100), note(0, 1, 41, 40), note(0, 1, 64, 80)], std)
  checks.push(['tab: unplayable notes drop the quietest', crowd.length === 2 && crowd.some((n) => n.pitch === 40) && crowd.some((n) => n.pitch === 64)])
  // below the guitar: moved up an octave to fit
  checks.push(['tab: a note below the low string moves up an octave', frets(fingerTab([note(0, 1, 30)], std)) === '0/2'])
  checks.push(['tab: bass in standard tuning', frets(fingerTab([note(0, 1, 28), note(1, 2, 33)], BASS_TUNINGS[0])) === '0/0 1/0'])

  // text: a riff on the beat at 120 BPM, then a long rest, then more
  const riff = [note(0, 0.25, 40), note(0.25, 0.5, 43), note(0.5, 0.75, 45, 90, [0, 3, 3]), note(20, 20.5, 40)]
  const text = tabToText(fingerTab(riff, std), std, { tempo: 120, title: 'Riff' })
  const lines = text.split('\n')
  const low = lines.find((l) => l.startsWith('E|'))
  checks.push(['tab text: header names the tuning', lines[0] === 'Riff' && lines[1].startsWith('Tuning: Standard (E A D G B e)')])
  const a = lines.find((l) => l.startsWith('A|'))
  // eighths at 120 BPM: every other sixteenth; the bend widens its column
  checks.push(['tab text: notes land on their sixteenths', !!low && !!a && low.startsWith('E|0---3-----') && a.startsWith('A|--------0b-')])
  checks.push(['tab text: high string printed first', lines.findIndex((l) => l.startsWith('e|')) < lines.findIndex((l) => l.startsWith('E|'))])
  checks.push(['tab text: a long rest is left out', /\(\d+ bars without notes\)/.test(text) && text.includes('[0:20]')])
  {
    // every row of one block is the same length
    const block = lines.slice(lines.indexOf('[0:00]') + 1, lines.indexOf('[0:00]') + 7)
    checks.push(['tab text: a block is six equal rows', block.length === 6 && block.every((l) => l.length === block[0].length)])
  }
  // the chord pass's beats lay the bars out, even when they drift
  const beats = [...Array(16)].map((_, i) => 1 + i * 0.6)
  const onBeat = tabToText(fingerTab([note(1, 1.3, 40), note(1.6, 1.9, 40), note(3.4, 3.7, 40)], std), std, { beats })
  const row = onBeat.split('\n').find((l) => l.startsWith('E|'))
  checks.push(['tab text: notes follow the beat grid', !!row && row.startsWith('E|0-------0-------') && row.split('|')[2].startsWith('0-')])
}

let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
