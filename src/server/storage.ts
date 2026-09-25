import { spawn } from 'child_process'
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync } from 'fs'
import { basename, join } from 'path'

/* How stems are kept on disk. The splitter writes 32-bit float WAV, around
   20 MB per stem per minute, which is far more precision than the source
   carries: YouTube hands over roughly 120 kbps Opus. Measured on a dense rock
   track split eleven ways, 16-bit FLAC stayed about 70 dB clear of the float
   original at a tenth of the size, and 24-bit FLAC about 112 dB clear at a
   bit over a quarter.

   Chosen by whoever runs the container (STEMKIT_STEM_FORMAT), not by anyone
   with the web page open, since it decides how much disk the library takes. */
export type StemFormat = 'flac16' | 'flac24' | 'wav'

export const STEM_FORMATS: StemFormat[] = ['flac16', 'flac24', 'wav']

export function parseStemFormat(raw: string | undefined): { format: StemFormat; invalid?: string } {
  const value = (raw ?? '').trim().toLowerCase()
  if (!value) return { format: 'flac16' }
  if ((STEM_FORMATS as string[]).includes(value)) return { format: value as StemFormat }
  return { format: 'flac16', invalid: value }
}

export const STEM_FORMAT_SETTING = parseStemFormat(process.env.STEMKIT_STEM_FORMAT)
export const STEM_FORMAT = STEM_FORMAT_SETTING.format

const ENCODE: Record<Exclude<StemFormat, 'wav'>, string[]> = {
  flac16: ['-c:a', 'flac', '-sample_fmt', 's16'],
  flac24: ['-c:a', 'flac', '-sample_fmt', 's32', '-bits_per_raw_sample', '24']
}

function run(ffmpeg: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', ...args])
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-64000)
    })
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }))
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

export interface CompressResult {
  result: 'compressed' | 'kept' | 'failed'
  reason?: string
}

/* Measures and encodes a float WAV stem in one pass. The FLAC is kept only if
   nothing in the stem went past full scale, which an integer format would
   clip; a stem like that stays float, and it is rare. The WAV is removed only
   once its FLAC is complete and in place, so a crash part way through leaves
   one whole file or the other, never neither. */
export async function compressStem(ffmpeg: string, wav: string, format: StemFormat): Promise<CompressResult> {
  if (format === 'wav') return { result: 'kept' }
  const out = wav.replace(/\.wav$/i, '.flac')
  const partial = `${out}.part`
  const { code, stderr } = await run(ffmpeg, ['-y', '-i', wav, '-af', 'astats', ...ENCODE[format], '-f', 'flac', partial])
  if (code !== 0) {
    rmSync(partial, { force: true })
    return { result: 'failed', reason: stderr.trim().split(/\r?\n/).pop() || `ffmpeg exited ${code}` }
  }
  // the last one printed belongs to the whole file rather than a channel
  const peaks = [...stderr.matchAll(/Peak level dB: (-?[\d.]+|-?inf)/g)]
  const peak = peaks.length ? parseFloat(peaks[peaks.length - 1][1].replace('inf', 'Infinity')) : NaN
  if (Number.isNaN(peak)) {
    rmSync(partial, { force: true })
    return { result: 'kept', reason: 'could not measure its peak, so it was left as it was' }
  }
  if (peak > 0) {
    rmSync(partial, { force: true })
    return { result: 'kept', reason: `peaks at +${peak.toFixed(2)} dB, over full scale` }
  }
  renameSync(partial, out)
  rmSync(wav, { force: true })
  return { result: 'compressed' }
}

/* Re-encodes anything ffmpeg can read as FLAC at its own depth, which is
   exact for integer sources such as the 16-bit mix older songs kept */
export async function flacCopy(ffmpeg: string, input: string, output: string): Promise<boolean> {
  const partial = `${output}.part`
  const { code } = await run(ffmpeg, ['-y', '-v', 'error', '-i', input, '-c:a', 'flac', '-f', 'flac', partial])
  if (code !== 0) {
    rmSync(partial, { force: true })
    return false
  }
  renameSync(partial, output)
  return true
}

export interface FlacInfo {
  bits: number
  sampleRate: number
  channels: number
  samples: number
}

/* The fields of a FLAC file's STREAMINFO block, which always comes first:
   after the "fLaC" marker and a 4 byte block header come block and frame
   sizes (10 bytes), then 20 bits of sample rate, 3 of channels less one,
   5 of bits per sample less one and 36 of total samples per channel */
export function flacInfo(head: Buffer): FlacInfo | null {
  if (head.length < 26 || head.toString('ascii', 0, 4) !== 'fLaC') return null
  const b = head.subarray(8)
  return {
    sampleRate: (b[10] << 12) | (b[11] << 4) | (b[12] >> 4),
    channels: ((b[12] >> 1) & 0x07) + 1,
    bits: (((b[12] & 0x01) << 4) | (b[13] >> 4)) + 1,
    samples: (b[13] & 0x0f) * 2 ** 32 + b.readUInt32BE(14)
  }
}

export function readFlacInfo(path: string): FlacInfo | null {
  const head = Buffer.alloc(26)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, head, 0, head.length, 0)
  } finally {
    closeSync(fd)
  }
  return flacInfo(head)
}

/* A WAV of a stored stem, for downloads and the player's last resort. FLAC
   comes back out at the depth it was stored with, so what leaves the server
   is exactly what is kept; a WAV is handed over as it is. */
export async function wavCopy(ffmpeg: string, file: string, dir: string): Promise<string> {
  if (/\.wav$/i.test(file)) return file
  mkdirSync(dir, { recursive: true })
  const out = join(dir, basename(file).replace(/\.[^.]+$/, '.wav'))
  const bits = readFlacInfo(file)?.bits ?? 16
  const { code, stderr } = await run(ffmpeg, [
    '-y',
    '-v',
    'error',
    '-i',
    file,
    '-c:a',
    bits > 16 ? 'pcm_s24le' : 'pcm_s16le',
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-flags:a',
    '+bitexact',
    out
  ])
  if (code !== 0 || !existsSync(out)) {
    throw new Error(`could not turn ${basename(file)} back into WAV: ${stderr.trim() || `ffmpeg exited ${code}`}`)
  }
  return out
}
