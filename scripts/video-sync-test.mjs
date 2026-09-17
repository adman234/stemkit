// Drives LocalVideoHost.sync with a fake <video> element to check that the
// picture is kept with the stems by nudging its speed, and that a video that
// cannot keep up is never seeked in a loop (which is what makes the YouTube
// embed stutter). Run with: npm run web:test
import { build } from 'esbuild'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const bundle = join(mkdtempSync(join(tmpdir(), 'stemkit-')), 'video.mjs')
await build({
  entryPoints: [new URL('../src/renderer/src/lib/video.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'error'
})
const { LocalVideoHost } = await import(pathToFileURL(bundle).href)

class FakeVideo {
  constructor({ stalls = false, refusesToPlay = false } = {}) {
    this.currentTime = 0
    this.playbackRate = 1
    this.paused = true
    this.readyState = 4
    this.seeking = false
    this.stalls = stalls
    this.refusesToPlay = refusesToPlay
    this.seeks = 0
    this.playCalls = 0
  }
  play() {
    this.playCalls++
    if (!this.refusesToPlay) this.paused = false
    return Promise.resolve()
  }
  pause() {
    this.paused = true
  }
  set _t(v) {}
}
// currentTime assignment counts as a seek
function makeVideo(opts) {
  const v = new FakeVideo(opts)
  v.seekLog = []
  let t = 0
  Object.defineProperty(v, 'currentTime', {
    get: () => t,
    set: (value) => {
      t = value
      v.seeks++
    }
  })
  return v
}

function run(name, { startDrift = 0, stalls = false, refusesToPlay = false, playing = true, seconds = 20 }) {
  const host = new LocalVideoHost()
  const el = makeVideo({ stalls, refusesToPlay })
  host.el = el
  let audio = 0
  el.currentTime = startDrift
  el.seeks = 0
  const step = 1 / 60
  let maxDrift = 0
  let now = 0
  const realNow = performance.now.bind(performance)
  performance.now = () => now
  for (let i = 0; i < seconds * 60; i++) {
    audio += step
    now += step * 1000
    // the video advances on its own unless it is stalled or paused
    if (!el.paused && !stalls) {
      const t = el.currentTime
      el.selfAdvance = true
      el.currentTime = t + step * el.playbackRate
      el.selfAdvance = false
      el.seeks-- // self-advance is not a seek
    }
    const seeksBefore = el.seeks
    const driftBefore = el.currentTime - audio
    host.sync(audio, playing)
    if (el.seeks > seeksBefore && el.seekLog.length < 8) {
      el.seekLog.push({ atSecond: +(i / 60).toFixed(2), driftBefore: +driftBefore.toFixed(3) })
    }
    if (i > 120) maxDrift = Math.max(maxDrift, Math.abs(el.currentTime - audio))
  }
  performance.now = realNow
  if (el.seekLog.length) console.log(`   ${name}: first seeks`, JSON.stringify(el.seekLog.slice(0, 4)))
  console.log(
    `${name.padEnd(34)} seeks ${String(el.seeks).padStart(3)}  play() ${String(el.playCalls).padStart(4)}  ` +
      `final drift ${(el.currentTime - audio).toFixed(3)}s  worst after settling ${maxDrift.toFixed(3)}s  rate ${el.playbackRate.toFixed(3)}`
  )
  return { seeks: el.seeks, maxDrift, drift: el.currentTime - audio, playCalls: el.playCalls }
}

const a = run('in sync', { startDrift: 0 })
const b = run('video 0.15s ahead', { startDrift: 0.15 })
const c = run('video 3s behind', { startDrift: -3 })
const d = run('stalled video', { stalls: true })
const e = run('browser refuses to play', { refusesToPlay: true, stalls: true })

const checks = [
  ['in sync makes no seeks', a.seeks === 0],
  ['small drift is corrected without seeking', b.seeks === 0 && Math.abs(b.drift) < 0.05],
  ['big drift seeks once, then settles', c.seeks === 1 && Math.abs(c.drift) < 0.05],
  ['stalled video backs off instead of seeking on a timer', d.seeks <= 5],
  ['refusing browser: retries play, never seeks', e.seeks === 0 && e.playCalls > 0]
]
let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
