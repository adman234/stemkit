// Checks how a stem turns into an AudioBuffer. The splitter writes 32-bit
// float WAVs, which Firefox refuses to hand to decodeAudioData, so those are
// parsed in the app: this pins down that the samples survive the trip, that
// light playback thins them to mono without wrecking the signal, and that
// anything that is not a WAV still goes to the browser's own decoder.
// Run with: npm run web:test
import { build } from 'esbuild'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

/* ---------- a browser, more or less ---------- */

let light = false
let decodeCalls = 0

class FakeAudioBuffer {
  constructor(channels, length, sampleRate) {
    this.numberOfChannels = channels
    this.length = length
    this.sampleRate = sampleRate
    this.duration = length / sampleRate
    this.data = Array.from({ length: channels }, () => new Float32Array(length))
  }
  getChannelData(i) {
    return this.data[i]
  }
}

class FakeAudioContext {
  constructor(options) {
    this.sampleRate = options?.sampleRate ?? 44100
    this.closed = false
  }
  createBuffer(channels, length, sampleRate) {
    return new FakeAudioBuffer(channels, length, sampleRate)
  }
  async decodeAudioData() {
    decodeCalls++
    // Firefox's message, which is where this whole path came from
    throw new Error('The buffer passed to decodeAudioData contains invalid content')
  }
  async close() {
    this.closed = true
  }
}

globalThis.AudioContext = FakeAudioContext
globalThis.CustomEvent = class CustomEvent {
  constructor(type) {
    this.type = type
  }
}
globalThis.localStorage = {
  getItem: () => (light ? '1' : '0'),
  setItem: (_k, v) => {
    light = v === '1'
  }
}
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  dispatchEvent: () => {},
  localStorage: globalThis.localStorage
}

const bundle = join(mkdtempSync(join(tmpdir(), 'stemkit-')), 'engine.mjs')
await build({
  entryPoints: [new URL('../src/renderer/src/lib/engine.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'error'
})
const { decodeStem, setLightPlayback } = await import(pathToFileURL(bundle).href)

/* ---------- WAV files to feed it ---------- */

// format 3 is IEEE float, 1 is integer PCM, 0xfffe is the extensible header
// that puts the real format inside a GUID
function wav({ format = 3, bits = 32, channels = 2, sampleRate = 44100, frames = 100, sample }) {
  const width = bits >> 3
  const fmtSize = format === 0xfffe ? 40 : 16
  const dataSize = frames * channels * width
  const buffer = new ArrayBuffer(12 + 8 + fmtSize + 8 + dataSize)
  const view = new DataView(buffer)
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, fmtSize, true)
  view.setUint16(20, format, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * width, true)
  view.setUint16(32, channels * width, true)
  view.setUint16(34, bits, true)
  if (format === 0xfffe) {
    view.setUint16(36, 22, true)
    view.setUint16(38, bits, true)
    view.setUint32(40, 3, true)
    view.setUint16(44, 3, true) // the real format, at the front of the GUID
  }
  const dataAt = 20 + fmtSize
  ascii(dataAt, 'data')
  view.setUint32(dataAt + 4, dataSize, true)
  let at = dataAt + 8
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < channels; c++) {
      const value = sample(f, c)
      if (format === 3 || format === 0xfffe) view.setFloat32(at, value, true)
      else if (bits === 16) view.setInt16(at, Math.round(value * 32767), true)
      else if (bits === 24) {
        const v = Math.round(value * 8388607)
        view.setUint8(at, v & 0xff)
        view.setUint8(at + 1, (v >> 8) & 0xff)
        view.setUint8(at + 2, (v >> 16) & 0xff)
      }
      at += width
    }
  }
  return buffer
}

/* ---------- checks ---------- */

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

const ramp = (f, c) => Math.fround((f % 50) / 100 - (c === 1 ? 0.25 : 0))

// 1. a float WAV, at full quality, comes back exactly as it went in
setLightPlayback(false)
let buffer = await decodeStem(wav({ frames: 441, sample: ramp }))
check('a 32-bit float WAV decodes without the browser', buffer.numberOfChannels === 2, `${buffer.numberOfChannels} channels`)
check('it keeps the sample rate', buffer.sampleRate === 44100, String(buffer.sampleRate))
check('it keeps every frame', buffer.length === 441, String(buffer.length))
let exact = true
for (let f = 0; f < 441; f++) {
  for (let c = 0; c < 2; c++) if (buffer.getChannelData(c)[f] !== ramp(f, c)) exact = false
}
check('the samples survive intact', exact)
check('the browser decoder was never asked', decodeCalls === 0, `${decodeCalls} calls`)

// 2. an extensible header hides the real format inside a GUID
buffer = await decodeStem(wav({ format: 0xfffe, frames: 441, sample: ramp }))
check('an extensible float WAV decodes too', buffer.getChannelData(0)[7] === ramp(7, 0))

// 3. integer WAVs still work, through the slower per-sample path
buffer = await decodeStem(wav({ format: 1, bits: 16, frames: 441, sample: ramp }))
check('a 16-bit WAV decodes', Math.abs(buffer.getChannelData(0)[30] - ramp(30, 0)) < 1e-4)
buffer = await decodeStem(wav({ format: 1, bits: 24, frames: 441, sample: ramp }))
check('a 24-bit WAV decodes', Math.abs(buffer.getChannelData(0)[30] - ramp(30, 0)) < 1e-6)

// 4. light playback: mono, lower rate, and the signal still holds its level
setLightPlayback(true)
buffer = await decodeStem(wav({ frames: 44100, sample: () => 1 }))
check('light playback is mono', buffer.numberOfChannels === 1, `${buffer.numberOfChannels} channels`)
check('light playback drops the rate', buffer.sampleRate === 24000, String(buffer.sampleRate))
check('light playback keeps the duration', Math.abs(buffer.duration - 1) < 0.01, `${buffer.duration.toFixed(3)}s`)
check(
  'light playback keeps the level',
  buffer.getChannelData(0).every((v) => Math.abs(v - 1) < 1e-6)
)
// 44.1 kHz stereo is 352800 bytes a second, 24 kHz mono is 96000
const memory = buffer.length * buffer.numberOfChannels * 4
check('light playback is a quarter of the memory', memory * 3.6 <= 44100 * 2 * 4, `${memory} bytes per second`)

// a quiet stem should not come back loud, or vice versa: averaging channels
// must not double the level
buffer = await decodeStem(wav({ frames: 4410, sample: (_f, c) => (c === 0 ? 0.5 : -0.5) })) // out of phase
check(
  'opposite channels cancel rather than clip',
  buffer.getChannelData(0).every((v) => Math.abs(v) < 1e-6)
)

// 5. anything that is not a WAV goes to the browser, and its failure is the
// one the player reports
setLightPlayback(false)
decodeCalls = 0
const notWav = new TextEncoder().encode('<!doctype html><title>404</title>').buffer
let message = ''
try {
  await decodeStem(notWav)
} catch (err) {
  message = err.message
}
check('a non-WAV reply is handed to the browser decoder', decodeCalls === 1, `${decodeCalls} calls`)
check('and its error is passed on', message.includes('decodeAudioData'), message)

// 6. a truncated WAV should not throw a range error out of the parser
const short = wav({ frames: 441, sample: ramp }).slice(0, 200)
let survived = true
try {
  buffer = await decodeStem(short)
} catch (err) {
  survived = err.message.includes('decodeAudioData')
}
check('a truncated WAV fails cleanly', survived)

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
