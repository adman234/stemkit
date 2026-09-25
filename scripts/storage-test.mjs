// Checks how stems are stored: the STEMKIT_STEM_FORMAT parsing, the FLAC
// header reader, the one-pass compress that refuses to clip a stem over full
// scale, and the WAV copies handed out for downloads. The last three drive
// the real ffmpeg, and are skipped where there is none.
// Run with: npm run web:test
import { build } from 'esbuild'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const work = mkdtempSync(join(tmpdir(), 'stemkit-storage-'))
const bundle = join(work, 'storage.mjs')
await build({
  entryPoints: [new URL('../src/server/storage.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'error'
})
const storage = await import(pathToFileURL(bundle).href)

const checks = []
const check = (name, ok) => checks.push([name, !!ok])

/* ---------- the setting ---------- */

check('unset means flac16', storage.parseStemFormat(undefined).format === 'flac16')
check('blank means flac16', storage.parseStemFormat('  ').format === 'flac16')
check('flac24 is taken as given', storage.parseStemFormat('flac24').format === 'flac24')
check('wav is taken as given', storage.parseStemFormat('WAV').format === 'wav')
const typo = storage.parseStemFormat('flac-24')
check('a typo falls back to flac16 and is reported', typo.format === 'flac16' && typo.invalid === 'flac-24')

/* ---------- float WAVs to feed it ---------- */

function floatWav(path, frames, sample) {
  const data = Buffer.alloc(frames * 2 * 4)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < 2; c++) data.writeFloatLE(sample(f, c), (f * 2 + c) * 4)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(3, 20) // IEEE float, as the splitter writes
  head.writeUInt16LE(2, 22)
  head.writeUInt32LE(44100, 24)
  head.writeUInt32LE(44100 * 8, 28)
  head.writeUInt16LE(8, 32)
  head.writeUInt16LE(32, 34)
  head.write('data', 36)
  head.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([head, data]))
}

// the integer samples of a WAV the server hands out, as floats
function readIntWav(path) {
  const buf = readFileSync(path)
  const bits = buf.readUInt16LE(34)
  let at = 12
  while (buf.toString('ascii', at, at + 4) !== 'data') at += 8 + buf.readUInt32LE(at + 4)
  const size = buf.readUInt32LE(at + 4)
  const width = bits / 8
  const out = []
  for (let i = at + 8; i + width <= at + 8 + size; i += width) {
    out.push(bits === 16 ? buf.readInt16LE(i) / 32768 : buf.readIntLE(i, 3) / 8388608)
  }
  return { bits, samples: out }
}

const tone = (f, c) => 0.6 * Math.sin((2 * Math.PI * 440 * f) / 44100 + c)

let ffmpeg = null
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
  ffmpeg = 'ffmpeg'
} catch {}

if (!ffmpeg) {
  console.log('SKIP  no ffmpeg on PATH, so compressing and WAV copies are not checked here')
} else {
  const frames = 44100

  // an ordinary stem becomes 16-bit FLAC, and the WAV goes
  const plain = join(work, 'plain.wav')
  floatWav(plain, frames, tone)
  const r16 = await storage.compressStem(ffmpeg, plain, 'flac16')
  check('an ordinary stem is compressed', r16.result === 'compressed')
  check('its FLAC is in place', existsSync(join(work, 'plain.flac')))
  check('and its float WAV is gone', !existsSync(plain))
  const info16 = storage.readFlacInfo(join(work, 'plain.flac'))
  check('the FLAC header reads as 16-bit stereo 44.1 kHz', info16?.bits === 16 && info16?.channels === 2 && info16?.sampleRate === 44100)
  check('and says every frame is there', info16?.samples === frames)

  // the download is a 16-bit WAV of the same audio, sample for sample
  const back = await storage.wavCopy(ffmpeg, join(work, 'plain.flac'), join(work, 'out16'))
  const wav16 = readIntWav(back)
  check('a download of it is a 16-bit WAV', wav16.bits === 16)
  check('with every sample', wav16.samples.length === frames * 2)
  let worst = 0
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < 2; c++) worst = Math.max(worst, Math.abs(wav16.samples[f * 2 + c] - tone(f, c)))
  }
  check('within 16-bit rounding of the original', worst < 2 / 32768)

  // 24-bit keeps the extra depth all the way out
  const deep = join(work, 'deep.wav')
  floatWav(deep, frames, tone)
  await storage.compressStem(ffmpeg, deep, 'flac24')
  check('flac24 stores 24 bits', storage.readFlacInfo(join(work, 'deep.flac'))?.bits === 24)
  const wav24 = readIntWav(await storage.wavCopy(ffmpeg, join(work, 'deep.flac'), join(work, 'out24')))
  check('and hands out a 24-bit WAV', wav24.bits === 24)

  // a stem over full scale would clip in any integer format, so it stays
  const hot = join(work, 'hot.wav')
  floatWav(hot, frames, (f, c) => (f === 1000 ? 1.4 : tone(f, c)))
  const rHot = await storage.compressStem(ffmpeg, hot, 'flac16')
  check('a stem over full scale is left alone', rHot.result === 'kept' && /over full scale/.test(rHot.reason ?? ''))
  check('its WAV is still there', existsSync(hot))
  check('and no FLAC or half-written file is left', !existsSync(join(work, 'hot.flac')) && !existsSync(join(work, 'hot.flac.part')))

  // a WAV is handed over as it is
  check('a stored WAV is not copied', (await storage.wavCopy(ffmpeg, hot, join(work, 'x'))) === hot)

  // wav mode leaves everything as the splitter wrote it
  const kept = join(work, 'kept.wav')
  floatWav(kept, 100, tone)
  const rWav = await storage.compressStem(ffmpeg, kept, 'wav')
  check('wav mode compresses nothing', rWav.result === 'kept' && existsSync(kept))
}

check('a file that is not FLAC has no FLAC header', storage.flacInfo(Buffer.from('RIFF0000WAVEfmt ...........')) === null)

let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
