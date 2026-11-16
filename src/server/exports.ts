import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { randomUUID } from 'crypto'
import { basename, join } from 'path'
import { songsDir } from './env'
import { sanitizeName } from '../main/library'
import { closeSession, openSession, writeToSession } from '../main/export-session'

/* The web side of upstream's export dialog. The browser renders the audio
   exactly as the desktop app does and hands each WAV over through the same
   sessions (src/main/export-session.ts); where the desktop app asks for a
   save path, the server picks a scratch folder of its own, and once the
   session ends the result is fetched back as one download: the file itself,
   or a zip of the folder for a separate export. Finished exports are kept a
   while so the download can be repeated, then swept. */

export const EXPORT_KEEP_MS = 30 * 60_000

export interface ExportBundle {
  token: string
  kind: 'file' | 'folder'
  // the scratch folder this export owns, removed as a whole
  dir: string
  // the file (kind file) or the folder of files (kind folder)
  path: string
  name: string
  ext: string
  createdAt: number
}

const bundles = new Map<string, ExportBundle>()

// scratch lives on the songs volume: the container's /tmp sits inside the
// docker image, which is small on Unraid
export function exportsRoot(): string {
  return join(songsDir(), '.exports')
}

export function beginExport(kind: 'file' | 'folder', name: string, format: 'wav' | 'aac'): ExportBundle {
  sweepExports()
  const ext = format === 'aac' ? 'm4a' : 'wav'
  const safe = sanitizeName(String(name)) || 'export'
  const id = randomUUID()
  const dir = join(exportsRoot(), id)
  const path = kind === 'file' ? join(dir, `${safe}.${ext}`) : join(dir, safe)
  mkdirSync(kind === 'file' ? dir : path, { recursive: true })
  const token = openSession(kind, path, format)
  const bundle: ExportBundle = { token, kind, dir, path, name: safe, ext, createdAt: Date.now() }
  bundles.set(token, bundle)
  return bundle
}

export function exportBundle(token: string): ExportBundle | undefined {
  return bundles.get(token)
}

export function writeExport(
  token: string,
  fileName: string | null,
  wav: Uint8Array,
  transcode: (src: string, dest: string) => Promise<void>
): Promise<string> {
  if (!bundles.has(token)) throw new Error('Unknown export session')
  return writeToSession(token, fileName, wav, transcode)
}

/* where a WAV the browser is uploading is streamed to before it joins the
   export: inside the bundle's own folder, so the rename onto the export is
   on the same volume and the sweep removes anything an abort leaves */
export function exportUploadPath(bundle: ExportBundle): string {
  return join(bundle.dir, `.upload-${randomUUID()}.wav`)
}

/* writeExport for a WAV already on disk. Upstream's session takes the bytes
   in memory, which for a long song is hundreds of megabytes per stem; it is
   handed none here and the file stands in for them: renamed onto the
   destination for a WAV export, or given to the transcoder for AAC */
export async function writeExportFile(
  token: string,
  fileName: string | null,
  file: string,
  transcode: (src: string, dest: string) => Promise<void>
): Promise<string> {
  const bundle = bundles.get(token)
  if (!bundle) throw new Error('Unknown export session')
  const dest = await writeToSession(token, fileName, new Uint8Array(0), (_empty, out) => transcode(file, out))
  if (bundle.ext === 'wav') renameSync(file, dest)
  return dest
}

export function endExport(token: string): void {
  closeSession(token)
}

/* what a finished export downloads as: null while nothing was written */
export function exportFiles(bundle: ExportBundle): { name: string; path: string }[] {
  if (bundle.kind === 'file') {
    return existsSync(bundle.path) ? [{ name: basename(bundle.path), path: bundle.path }] : []
  }
  if (!existsSync(bundle.path)) return []
  return readdirSync(bundle.path)
    .filter((f) => !f.startsWith('.'))
    .sort()
    .map((f) => ({ name: `${bundle.name}/${f}`, path: join(bundle.path, f) }))
    .filter((f) => statSync(f.path).isFile())
}

export function sweepExports(now = Date.now()): void {
  for (const [token, bundle] of bundles) {
    if (now - bundle.createdAt < EXPORT_KEEP_MS) continue
    bundles.delete(token)
    closeSession(token)
    rmSync(bundle.dir, { recursive: true, force: true })
  }
  // folders left behind by a restart
  const root = exportsRoot()
  if (!existsSync(root)) return
  const live = new Set([...bundles.values()].map((b) => b.dir))
  for (const entry of readdirSync(root)) {
    const dir = join(root, entry)
    if (!live.has(dir)) rmSync(dir, { recursive: true, force: true })
  }
}
