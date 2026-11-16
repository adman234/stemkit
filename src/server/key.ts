import { spawn } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'
import { join } from 'path'
import { getStatus } from './env'
import { loadSongs, songDir, sourceFile, stemFile, stemsFor } from '../main/library'
import { detectOnce, runKeyScript } from '../main/keydetect'
import type { SongKey } from '../shared/types'

/* Upstream's key detection, fed from what the web library keeps. A fresh
   split is detected from its float WAVs before they are compressed (see
   splitMix); a song already in the library only has FLAC stems, which
   key.py cannot read, so the pitched stems are summed into one float WAV
   with ffmpeg first. key.py only looks at the first four minutes. */

const MAX_SECONDS = 240

function mixDown(ffmpeg: string, inputs: string[], out: string): Promise<void> {
  const args = ['-hide_banner', '-loglevel', 'error', '-y']
  for (const input of inputs) args.push('-t', String(MAX_SECONDS), '-i', input)
  if (inputs.length > 1) {
    args.push('-filter_complex', `amix=inputs=${inputs.length}:normalize=0:duration=longest`)
  }
  args.push('-ac', '1', '-ar', '22050', '-c:a', 'pcm_f32le', out)
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr?.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-500)))
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))))
  })
}

// drums carry no pitch, the same rule as upstream's keyInputs
export function storedKeyInputs(videoId: string): string[] {
  const song = loadSongs().find((s) => s.videoId === videoId)
  const files = stemsFor(song)
    .filter((s) => s !== 'drums')
    .map((s) => stemFile(videoId, s))
    .filter((f): f is string => f !== null)
  if (files.length) return files
  const source = sourceFile(videoId)
  return source ? [source] : []
}

export async function detectStoredKey(videoId: string): Promise<SongKey> {
  const ffmpeg = getStatus().ffmpeg.path
  const inputs = storedKeyInputs(videoId)
  if (!ffmpeg || inputs.length === 0) return { detected: null }
  const scratch = join(songDir(videoId), `.key-${randomUUID().slice(0, 8)}`)
  try {
    mkdirSync(scratch, { recursive: true })
    const wav = join(scratch, 'key.wav')
    await mixDown(ffmpeg, inputs, wav)
    return await runKeyScript([wav])
  } catch (err) {
    console.error(`[key] ${videoId}: ${err instanceof Error ? err.message : String(err)}`)
    return { detected: null }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

export function detectKey(videoId: string, force: boolean): Promise<SongKey> {
  return detectOnce(videoId, () => detectStoredKey(videoId), { force })
}
