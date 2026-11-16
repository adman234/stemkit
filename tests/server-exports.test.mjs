import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerTsHooks } from './helpers/ts-resolve.mjs'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// the web server's side of upstream's export dialog (src/server/exports.ts)
// and its key detection for songs already in the library (src/server/key.ts)
const root = mkdtempSync(join(tmpdir(), 'stemkit-server-exports-'))
after(() => rmSync(root, { recursive: true, force: true }))
const hooks = registerTsHooks({
  stubEnv: `export const userDataDir = () => ${JSON.stringify(root)}
export const venvPython = () => 'python'
export const keyScript = () => 'key.py'
export const getStatus = () => ({ ffmpeg: { path: null } })`
})
const exports = await import(new URL('../src/server/exports.ts', import.meta.url).href)
const key = await import(new URL('../src/server/key.ts', import.meta.url).href)
const { saveSongs } = await import(new URL('../src/main/library.ts', import.meta.url).href)
hooks.deregister()

const wav = new Uint8Array([82, 73, 70, 70, 9, 9])
const noTranscode = async () => assert.fail('transcode must not run for wav')

test('a file export lands in its own scratch folder and downloads as that file', async () => {
  const bundle = exports.beginExport('file', 'My Song: mix', 'wav')
  assert.match(bundle.token, /^[0-9a-f-]{36}$/)
  assert.equal(exports.exportFiles(bundle).length, 0, 'nothing to download before a write')
  await exports.writeExport(bundle.token, null, wav, noTranscode)
  exports.endExport(bundle.token)
  const files = exports.exportFiles(bundle)
  assert.equal(files.length, 1)
  assert.equal(files[0].name, 'My Song- mix.wav')
  assert.deepEqual(new Uint8Array(readFileSync(files[0].path)), wav)
  assert.ok(files[0].path.startsWith(exports.exportsRoot()))
  assert.equal(exports.exportBundle(bundle.token), bundle, 'kept for a repeat download')
})

test('a folder export zips as name/stem files and refuses writes after it ends', async () => {
  const bundle = exports.beginExport('folder', 'Song (+2 st)', 'wav')
  await exports.writeExport(bundle.token, 'vocals', wav, noTranscode)
  await exports.writeExport(bundle.token, 'bass', wav, noTranscode)
  exports.endExport(bundle.token)
  assert.deepEqual(
    exports.exportFiles(bundle).map((f) => f.name),
    ['Song (+2 st)/bass.wav', 'Song (+2 st)/vocals.wav']
  )
  await assert.rejects(async () => exports.writeExport(bundle.token, 'drums', wav, noTranscode))
  await assert.rejects(async () => exports.writeExport('not-a-token', null, wav, noTranscode), /Unknown export/)
})

test('aac exports transcode through the given ffmpeg step', async () => {
  const bundle = exports.beginExport('file', 'Song', 'aac')
  let called = 0
  await exports.writeExport(bundle.token, null, wav, async (_src, dest) => {
    called++
    writeFileSync(dest, 'm4a')
  })
  exports.endExport(bundle.token)
  assert.equal(called, 1)
  assert.equal(exports.exportFiles(bundle)[0].name, 'Song.m4a')
})

// the server streams each uploaded WAV to disk first (writeExportFile), so a
// long song is never held in memory
test('a streamed wav upload becomes the export file without a copy', async () => {
  const bundle = exports.beginExport('folder', 'Streamed', 'wav')
  const upload = exports.exportUploadPath(bundle)
  assert.ok(upload.startsWith(bundle.dir), 'the upload sits inside the export, so the sweep owns it')
  writeFileSync(upload, wav)
  const dest = await exports.writeExportFile(bundle.token, 'vocals', upload, noTranscode)
  exports.endExport(bundle.token)
  assert.equal(existsSync(upload), false, 'renamed, not copied')
  assert.deepEqual(new Uint8Array(readFileSync(dest)), wav)
  assert.deepEqual(
    exports.exportFiles(bundle).map((f) => f.name),
    ['Streamed/vocals.wav'],
    'the hidden upload name never shows in the download'
  )
})

test('a streamed upload for an aac export is transcoded from the file on disk', async () => {
  const bundle = exports.beginExport('file', 'Streamed', 'aac')
  const upload = exports.exportUploadPath(bundle)
  writeFileSync(upload, wav)
  let source
  await exports.writeExportFile(bundle.token, null, upload, async (src, dest) => {
    source = src
    writeFileSync(dest, 'm4a')
  })
  exports.endExport(bundle.token)
  assert.equal(source, upload)
  assert.equal(exports.exportFiles(bundle)[0].name, 'Streamed.m4a')
  await assert.rejects(exports.writeExportFile('no-such-token', null, upload, noTranscode), /Unknown export session/)
})

test('the sweep removes expired exports and folders a restart left behind', () => {
  const bundle = exports.beginExport('file', 'Old', 'wav')
  const orphan = join(exports.exportsRoot(), 'left-over')
  mkdirSync(orphan, { recursive: true })
  exports.sweepExports(bundle.createdAt + 1000)
  assert.equal(existsSync(orphan), false)
  assert.equal(existsSync(bundle.dir), true, 'a fresh export stays')
  exports.sweepExports(bundle.createdAt + exports.EXPORT_KEEP_MS + 1)
  assert.equal(existsSync(bundle.dir), false)
  assert.equal(exports.exportBundle(bundle.token), undefined)
})

test('stored key detection reads the pitched stems, else the source, and needs ffmpeg', async () => {
  const songs = join(root, 'songs')
  const song = { videoId: 'abcdefghijk', stems: ['vocals', 'drums', 'bass'], title: 'T', duration: 1, addedAt: 1 }
  saveSongs([song])
  const stems = join(songs, song.videoId, 'stems')
  mkdirSync(stems, { recursive: true })
  for (const s of ['vocals', 'drums']) writeFileSync(join(stems, `${s}.flac`), 'x')
  writeFileSync(join(stems, 'bass.wav'), 'x')
  const inputs = key.storedKeyInputs(song.videoId).map((f) => f.replace(/\\/g, '/').split('/').pop())
  assert.deepEqual(inputs, ['vocals.flac', 'bass.wav'], 'drums carry no pitch')
  // without ffmpeg the stored stems cannot be read: unknown, never a throw
  assert.deepEqual(await key.detectStoredKey(song.videoId), { detected: null })
})
