// Checks the stem chips of the landscape stage view: a chip shows and flips
// what is actually heard, even after a preset has set solos instead of mutes.
// Run with: npm run web:test
import { build } from 'esbuild'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const bundle = join(mkdtempSync(join(tmpdir(), 'stemkit-')), 'mix.mjs')
await build({
  entryPoints: [new URL('../src/renderer/src/lib/mix.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'error'
})
const { isAudible, toggleAudible } = await import(pathToFileURL(bundle).href)

const IDS = ['vocals', 'drums', 'bass', 'guitar']
const heard = (mutes, solos) => IDS.filter((id) => isAudible(id, mutes, solos))
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])

const checks = []

// plain mutes
{
  const a = toggleAudible(IDS, new Set(), new Set(), 'drums')
  checks.push(['tapping an audible stem mutes it', same(heard(a.mutes, a.solos), ['vocals', 'bass', 'guitar'])])
  const b = toggleAudible(IDS, a.mutes, a.solos, 'drums')
  checks.push(['tapping it again brings it back', same(heard(b.mutes, b.solos), IDS)])
}

// a preset left solos behind
{
  const solos = new Set(['vocals'])
  const a = toggleAudible(IDS, new Set(), solos, 'vocals')
  checks.push(['solo active: tapping the audible stem mutes it', !isAudible('vocals', a.mutes, a.solos)])
  checks.push(['solo active: solos are cleared afterwards', a.solos.size === 0])
  checks.push([
    'solo active: other stems stay silent',
    ['drums', 'bass', 'guitar'].every((id) => !isAudible(id, a.mutes, a.solos))
  ])

  const b = toggleAudible(IDS, new Set(), solos, 'drums')
  checks.push(['solo active: tapping a silent stem makes it audible', isAudible('drums', b.mutes, b.solos)])
  checks.push([
    'solo active: the soloed stem is still audible',
    isAudible('vocals', b.mutes, b.solos)
  ])
  checks.push([
    'solo active: untouched stems keep their audibility',
    !isAudible('bass', b.mutes, b.solos) && !isAudible('guitar', b.mutes, b.solos) && b.solos.size === 0
  ])
}

// a stem both muted and soloed is silent, and tapping brings it in
{
  const a = toggleAudible(IDS, new Set(['vocals']), new Set(['vocals']), 'vocals')
  checks.push(['muted and soloed counts as silent', isAudible('vocals', a.mutes, a.solos)])
}

// the inputs are left alone
{
  const mutes = new Set(['bass'])
  const solos = new Set(['vocals', 'bass'])
  toggleAudible(IDS, mutes, solos, 'vocals')
  checks.push([
    'inputs are not mutated',
    mutes.size === 1 && mutes.has('bass') && solos.size === 2 && solos.has('vocals') && solos.has('bass')
  ])
}

let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
