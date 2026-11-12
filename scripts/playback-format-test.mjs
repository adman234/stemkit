// Checks which playback copy each browser is sent to. Firefox decodes Opus
// itself on every platform while its AAC leans on the operating system, so
// Gecko is sent to the Opus copy and everyone else to AAC; the WAV, which
// the app decodes itself, is always the last resort.
// Run with: npm run web:test
import { build } from 'esbuild'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const bundle = join(mkdtempSync(join(tmpdir(), 'stemkit-')), 'playback.mjs')
await build({
  entryPoints: [new URL('../src/shared/playback.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'error'
})
const { playbackFormats } = await import(pathToFileURL(bundle).href)

// the real strings, taken from the browsers themselves
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:156.0) Gecko/20100101 Firefox/156.0'
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0'
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36'
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const FIREFOX_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/119.0 Mobile/15E148 Safari/605.1.15'

const everything = () => true
const noOpus = (type) => !type.includes('opus')

const checks = []
const first = (ua, canPlay = everything) => playbackFormats(ua, canPlay)[0]

checks.push(['firefox is sent to the ogg copy for the WebAssembly decoder', first(FIREFOX) === 'ogg'])
checks.push(['firefox on android too, which is where it matters', first(FIREFOX_ANDROID) === 'ogg'])
checks.push([
  'firefox falls back to its own Opus decoder next',
  playbackFormats(FIREFOX, everything)[1] === 'webm'
])
checks.push([
  'firefox without WebAssembly goes straight to its own Opus decoder',
  playbackFormats(FIREFOX, everything, false)[0] === 'webm'
])
checks.push(['chrome is not sent the ogg copy', !playbackFormats(CHROME, everything).includes('ogg')])
checks.push(['chrome keeps the AAC copy', first(CHROME) === 'm4a'])
checks.push(['safari keeps the AAC copy', first(SAFARI) === 'm4a'])
// FxiOS is WebKit underneath, and may not take Opus
checks.push(['firefox on ios is not treated as firefox', first(FIREFOX_IOS) === 'm4a'])

// a browser that will not claim Opus is not offered it first
checks.push(['a browser without Opus is left on AAC', playbackFormats(FIREFOX, noOpus, false)[0] === 'm4a'])

for (const [name, ua, count] of [['firefox', FIREFOX, 4], ['chrome', CHROME, 3]]) {
  const formats = playbackFormats(ua, everything)
  checks.push([`${name} still has every format to fall back on`, formats.length === count])
  checks.push([`${name} ends on the WAV, which cannot be refused`, formats[formats.length - 1] === 'wav'])
}

let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
