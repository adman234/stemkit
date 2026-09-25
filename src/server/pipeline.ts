import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import type { JobEvent, JobStage, SplitOptions } from '../shared/types'
import { parseVideoId } from '../shared/url'
import {
  DEFAULT_SPLIT,
  MODELS,
  modelsFor,
  normalizeSplit,
  outputStems,
  planSteps,
  splitTag,
  type PlannedStep
} from '../shared/engines'
import { broadcast } from './events'
import { STEM_FORMAT, compressStem, flacCopy } from './storage'
import {
  chordsScript,
  ensureModel,
  getStatus,
  hasGpuAcceleration,
  modelsDir,
  msstScript,
  roformerScript,
  separateScript,
  venvPython,
  venvYtDlp,
  ytDlpRuntimeArgs
} from './env'
// desktop main-process modules, reused as-is (see scripts/build-server.mjs)
import { loadSettings } from '../main/settings'
import {
  loadSongs,
  mixWavPath,
  rawDownloadPath,
  songDir,
  sourceFile,
  stemFile,
  stemsDir,
  stemsFor,
  stemsPresent,
  upsertSong
} from '../main/library'
import { cacheThumbnail } from '../main/thumbs'

export { searchYouTube } from '../main/pipeline'

/* ---------- playback copies ---------- */

/* Stems are 32-bit float WAV, around 20 MB per minute each. That is the
   right thing to export, but a phone pulling six of them over wifi waits
   minutes, so playback uses a compressed copy at about a twentieth of the
   size. The WAVs stay untouched and are what downloads still hand over.

   Two formats, because decoding one of them is not something every browser
   can promise: AAC leans on a decoder from the operating system, while Opus
   is carried by the browser itself wherever it runs. The client asks for
   whichever its own browser is surest about. */
export type PreviewFormat = 'm4a' | 'webm'

const PREVIEW_ARGS: Record<PreviewFormat, string[]> = {
  m4a: ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart'],
  webm: ['-c:a', 'libopus', '-b:a', '128k']
}

export function previewPath(videoId: string, stem: string, format: PreviewFormat = 'm4a'): string {
  return join(songDir(videoId), 'preview', `${stem}.${format}`)
}

const previewJobs = new Map<string, Promise<boolean>>()

export function ensurePreview(
  videoId: string,
  stem: string,
  format: PreviewFormat = 'm4a'
): Promise<boolean> {
  const out = previewPath(videoId, stem, format)
  if (existsSync(out)) return Promise.resolve(true)
  const source = stemFile(videoId, stem)
  if (!source) return Promise.resolve(false)
  const key = `${videoId}/${stem}.${format}`
  const started = Date.now()
  let job = previewJobs.get(key)
  if (!job) {
    let why = ''
    job = new Promise<boolean>((resolve) => {
      const ffmpeg = getStatus().ffmpeg.path
      if (!ffmpeg) {
        why = 'no ffmpeg on PATH'
        return resolve(false)
      }
      mkdirSync(dirname(out), { recursive: true })
      const partial = `${out}.part.${format}`
      const child = spawn(ffmpeg, ['-y', '-i', source, ...PREVIEW_ARGS[format], partial])
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-400)
      })
      child.on('error', (err) => {
        why = err.message
        resolve(false)
      })
      child.on('close', (code) => {
        if (code === 0 && existsSync(partial)) {
          renameSync(partial, out)
          resolve(true)
        } else {
          why = `ffmpeg exited ${code}: ${stderr.trim().slice(-160)}`
          rmSync(partial, { force: true })
          resolve(false)
        }
      })
    })
      .then((ok) => {
        console.log(
          `[preview] ${videoId}/${stem}.${format}: ${
            ok ? `ready in ${Math.round((Date.now() - started) / 100) / 10}s` : `failed, ${why || 'unknown'}`
          }`
        )
        return ok
      })
      .finally(() => {
        previewJobs.delete(key)
      })
    previewJobs.set(key, job)
  }
  return job
}

/* made in the background once a split finishes, so the first play is quick */
export async function buildPreviews(
  videoId: string,
  stems: string[],
  format: PreviewFormat = 'm4a'
): Promise<void> {
  for (const stem of stems) {
    if (!existsSync(songDir(videoId))) return
    await ensurePreview(videoId, stem, format)
  }
}

/* ---------- key and chords ---------- */

export function chordsPath(videoId: string): string {
  return join(songDir(videoId), 'chords.json')
}

export function hasChords(videoId: string): boolean {
  return existsSync(chordsPath(videoId))
}

const chordJobs = new Set<string>()

/* chords read best from the harmonic stems: no drums thumping through the
   analysis and no vocals to mistake for harmony. Falls back to the mix */
function chordInputs(videoId: string): { paths: string[]; source: string } {
  const song = loadSongs().find((s) => s.videoId === videoId)
  const harmonic = ['bass', 'other', 'guitar', 'piano']
    .filter((name) => song?.stems?.includes(name as never))
    .map((name) => stemFile(videoId, name))
    .filter((file): file is string => file !== null)
  if (harmonic.length > 0) {
    return {
      paths: harmonic,
      source: `stems: ${harmonic.map((f) => basename(f, extname(f))).join(', ')}`
    }
  }
  return { paths: [sourceFile(videoId) ?? mixWavPath(videoId)], source: 'full mix' }
}

/* runs chord detection for a song already in the library */
export async function detectChords(videoId: string): Promise<void> {
  if (chordJobs.has(videoId)) return
  if (!existsSync(songDir(videoId))) {
    broadcast('chords:event', { videoId, error: 'That song is not in the library' })
    return
  }
  chordJobs.add(videoId)
  broadcast('chords:event', { videoId, running: true })
  try {
    const ok = await ensureModel('chords')
    if (!ok) throw new Error('Could not download the chord model')
    const { paths, source } = chordInputs(videoId)
    const gpu = loadSettings().gpuSplit && (await hasGpuAcceleration())
    await runChords(videoId, paths, source, gpu ? 'cuda' : 'cpu')
    broadcast('chords:event', { videoId, ready: true })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    broadcast('chords:event', { videoId, error: message })
    console.error(`[chords] ${videoId}: ${message}`)
  } finally {
    chordJobs.delete(videoId)
  }
}

function runChords(
  videoId: string,
  paths: string[],
  source: string,
  device: string,
  job?: ActiveJob,
  onPct?: (pct: number, message?: string) => void
): Promise<void> {
  const args = [
    chordsScript(),
    '--input',
    ...paths,
    '--out',
    chordsPath(videoId),
    '--ckpt-dir',
    modelsDir(),
    '--device',
    device,
    '--source',
    source
  ]
  const holder: ActiveJob = job ?? { videoId, tag: 'chords', cancelled: false, standalone: true }
  return runProcess(holder, venvPython(), args, {
    onLine: (line) => {
      if (!onPct) return
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      if (parsed.type !== 'progress') return
      const pct = Number(parsed.pct ?? 0)
      const message = typeof parsed.message === 'string' ? parsed.message : undefined
      if (message && pct === 0) onPct(0, message)
      else onPct(pct, message)
    }
  })
}

/* ---------- video for local playback ---------- */

export function videoPath(videoId: string): string {
  return join(songDir(videoId), 'video.mp4')
}

export function hasVideo(videoId: string): boolean {
  return existsSync(videoPath(videoId))
}

const videoJobs = new Map<string, ChildProcess>()

export function videoDownloading(videoId: string): boolean {
  return videoJobs.has(videoId)
}

/* Downloads the video track (no audio: the stems are the audio) so the
   player can run it locally and stay in sync, instead of streaming the
   YouTube embed and seeking it whenever it drifts */
export async function fetchVideo(videoId: string): Promise<void> {
  if (hasVideo(videoId)) {
    broadcast('video:event', { videoId, ready: true })
    return
  }
  if (videoJobs.has(videoId)) return
  const dir = songDir(videoId)
  if (!existsSync(dir)) {
    broadcast('video:event', { videoId, error: 'That song is not in the library' })
    return
  }
  const height = loadSettings().videoHeight || 480
  const url = `https://www.youtube.com/watch?v=${videoId}`
  const target = join(dir, 'video.%(ext)s')
  broadcast('video:event', { videoId, pct: 0 })

  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        venvYtDlp(),
        [
          ...ytDlpRuntimeArgs(),
          '-f',
          // video only, H.264 first so every browser can play it
          `bv*[height<=${height}][vcodec^=avc1]/bv*[height<=${height}][ext=mp4]/bv*[height<=${height}]/b[height<=${height}]`,
          '--no-playlist',
          '-o',
          target,
          url
        ],
        { env: process.env }
      )
      videoJobs.set(videoId, child)
      let maxPct = 0
      let stderrTail = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const piece of chunk.toString().split(/[\r\n]/)) {
          const m = piece.match(/(\d+(?:\.\d+)?)%/)
          if (!m) continue
          const pct = parseFloat(m[1])
          if (pct > maxPct && pct <= 100) {
            maxPct = pct
            broadcast('video:event', { videoId, pct: Math.round(pct) })
          }
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-600)
      })
      child.on('error', reject)
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(stderrTail.split('\n').filter(Boolean).slice(-1)[0] || `yt-dlp exited ${code}`))
      )
    })

    const downloaded = readdirSync(dir).find((f) => f.startsWith('video.'))
    if (!downloaded) throw new Error('the download produced no file')
    if (downloaded !== 'video.mp4') {
      // a webm or mkv container: repackage as mp4 without re-encoding
      const source = join(dir, downloaded)
      const ffmpeg = getStatus().ffmpeg.path
      if (!ffmpeg) throw new Error('ffmpeg is missing from the container')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(ffmpeg, ['-y', '-i', source, '-an', '-c', 'copy', '-movflags', '+faststart', videoPath(videoId)])
        videoJobs.set(videoId, child)
        child.on('error', reject)
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))))
      })
      rmSync(source, { force: true })
    }
    broadcast('video:event', { videoId, ready: true })
    console.log(`[video] ${videoId}: ready (${height}p)`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    for (const f of existsSync(dir) ? readdirSync(dir) : []) {
      if (f.startsWith('video.')) rmSync(join(dir, f), { force: true })
    }
    broadcast('video:event', { videoId, error: message })
    console.error(`[video] ${videoId}: ${message}`)
  } finally {
    videoJobs.delete(videoId)
  }
}

/* Split pipeline for the web version. Download and conversion follow the
   desktop pipeline (src/main/pipeline.ts); separation is planned from the
   engine and options picked in the add-song panel (src/shared/engines.ts)
   and runs as a chain of Python steps:

     vocals   roformer.py, the dedicated vocal model (studio vocals)
     demucs   separate.py, the Quick engine
     sw       msst.py, the Best engine (BS-Roformer SW)
     drumsep  msst.py, splits the drums stem into the kit pieces */

interface ActiveJob {
  videoId: string
  title?: string
  tag: string
  cancelled: boolean
  proc?: ChildProcess
  // work started on its own (chords for a song already in the library)
  // rather than as part of a split, so it is not in the jobs map
  standalone?: boolean
}

const jobs = new Map<string, ActiveJob>()

const MAX_CONCURRENT_SEPARATIONS = Math.max(1, Number(process.env.STEMKIT_MAX_JOBS ?? 2) || 2)
let activeSeparations = 0
const separationWaiters: Array<() => void> = []

function acquireSeparation(): Promise<() => void> {
  if (activeSeparations < MAX_CONCURRENT_SEPARATIONS) {
    activeSeparations++
    return Promise.resolve(releaseSeparation)
  }
  return new Promise((resolve) => {
    separationWaiters.push(() => {
      activeSeparations++
      resolve(releaseSeparation)
    })
  })
}

function releaseSeparation(): void {
  activeSeparations--
  separationWaiters.shift()?.()
}

function send(ev: JobEvent): void {
  broadcast('job:event', ev)
}

function progress(job: ActiveJob, stage: JobStage, pct: number, message?: string): void {
  if (!jobs.has(job.videoId) || job.cancelled) return
  send({
    kind: 'progress',
    data: { videoId: job.videoId, stage, pct, message, title: job.title, model: job.tag }
  })
}

function alive(job: ActiveJob): boolean {
  return !job.cancelled && (job.standalone || jobs.has(job.videoId))
}

/* requests from the desktop-style API (no options) map onto the Quick engine
   with the old global quality settings */
function legacySplit(stems?: string[]): SplitOptions {
  const settings = loadSettings()
  return normalizeSplit({
    engine: 'quick',
    stems: stems?.length ? stems : DEFAULT_SPLIT.stems,
    studioVocals: settings.roformerVocals,
    secondPass: settings.shifts === 2,
    drumKit: false
  })
}

export async function startJob(
  rawUrl: string,
  _model?: string,
  stems?: string[],
  rawOptions?: unknown
): Promise<void> {
  const url = rawUrl.trim()
  const videoId = parseVideoId(url)
  if (!videoId) {
    send({ kind: 'failed', data: { videoId: '', message: 'Could not parse a YouTube URL or video id out of that' } })
    return
  }
  if (jobs.has(videoId)) {
    send({ kind: 'failed', data: { videoId, message: 'This song is already being processed' } })
    return
  }

  const options = rawOptions ? normalizeSplit(rawOptions) : legacySplit(stems)
  // what the player shows beside the stems: the video, downloaded to play in
  // step, or only the cover image. A client that does not say gets whatever
  // the settings file has
  const picture = options.picture ?? (loadSettings().downloadVideo ? 'video' : 'thumbnail')
  const tag = splitTag(options)
  const expected = outputStems(options)
  const job: ActiveJob = { videoId, tag, cancelled: false }
  jobs.set(videoId, job)
  const startedAt = Date.now()

  const bail = (message: string): never => {
    throw new Error(message)
  }

  try {
    const existing = loadSongs().find((s) => s.videoId === videoId)
    const covered =
      !!existing?.options &&
      splitTag(existing.options) === tag &&
      expected.every((s) => existing.stems?.includes(s)) &&
      stemsPresent(videoId, existing.stems ?? [])
    if (covered && existing) {
      // same split, but the picture choice may have changed
      const song =
        existing.options?.picture === picture
          ? existing
          : upsertSong({ ...existing, options: { ...existing.options!, picture } })[0]
      if (picture === 'video' && !existing.video) void fetchVideo(videoId)
      send({ kind: 'done', data: { videoId, song } })
      return
    }
    if (existing) rmSync(songDir(videoId), { recursive: true, force: true })

    mkdirSync(songDir(videoId), { recursive: true })
    progress(job, 'metadata', 0, 'Reading video info')

    let raw = ''
    await runProcess(job, venvYtDlp(), [...ytDlpRuntimeArgs(), '-J', '--no-playlist', '--skip-download', url], {
      onStdout: (chunk) => {
        raw += chunk
      }
    })
    let meta = { title: 'Unknown title', duration: 0 }
    try {
      const parsed = JSON.parse(raw)
      meta = {
        title: typeof parsed.title === 'string' ? parsed.title : 'Unknown title',
        duration: typeof parsed.duration === 'number' ? Math.round(parsed.duration) : 0
      }
      void cacheThumbnail(videoId, typeof parsed.thumbnail === 'string' ? parsed.thumbnail : undefined)
    } catch {
      bail('Could not read video metadata')
    }
    if (!alive(job)) return
    job.title = meta.title
    progress(job, 'metadata', 100, meta.title)

    progress(job, 'download', 0, 'Downloading audio from YouTube')
    let maxPct = 0
    await runProcess(
      job,
      venvYtDlp(),
      [...ytDlpRuntimeArgs(), '-f', 'bestaudio/best', '--no-playlist', '-o', rawDownloadPath(videoId), url],
      {
        onStdout: (chunk) => {
          for (const piece of chunk.split(/[\r\n]/)) {
            const m = piece.match(/(\d+(?:\.\d+)?)%/)
            if (!m) continue
            const pct = parseFloat(m[1])
            if (pct > maxPct && pct <= 100) {
              maxPct = pct
              progress(job, 'download', pct)
            }
          }
        }
      }
    )
    if (!alive(job)) return

    const dir = songDir(videoId)
    const rawFile = readdirSync(dir).find((f) => f.startsWith('raw.'))
    if (!rawFile) bail('Download produced no file')
    const rawPath = join(dir, rawFile as string)

    progress(job, 'convert', 0, 'Converting to WAV')
    const ffmpeg = getStatus().ffmpeg.path
    if (!ffmpeg) bail('ffmpeg is missing from the container')
    await runProcess(job, ffmpeg as string, [
      '-y',
      '-i',
      rawPath,
      '-af',
      'aresample=44100:resampler=soxr',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      mixWavPath(videoId)
    ])
    // the download is what gets kept: the WAV made from it is ten times the
    // size and no better, and only has to exist while the split runs
    renameSync(rawPath, join(dir, `source${extname(rawPath)}`))
    if (!alive(job)) return
    progress(job, 'convert', 100)

    // the video downloads in the background: the split does not wait for it
    if (picture === 'video') void fetchVideo(videoId)

    mkdirSync(stemsDir(videoId), { recursive: true })
    progress(job, 'separate', 0, 'Waiting for a free engine slot…')

    const release = await acquireSeparation()
    try {
      if (!alive(job)) return
      const gpu = loadSettings().gpuSplit && (await hasGpuAcceleration())

      for (const id of modelsFor(options)) {
        const { name, sizeMb } = MODELS[id]
        const ok = await ensureModel(id, (pct) =>
          progress(job, 'separate', 0, `Downloading ${name} (${sizeMb} MB, one time): ${pct}%`)
        )
        if (!alive(job)) return
        if (!ok) bail(`Could not download ${name}. Check the container's internet access and try again.`)
      }

      const minutes = meta.duration > 0 ? meta.duration / 60 : 4
      await separate(job, options, planSteps(options, minutes, gpu), gpu ? 'cuda' : 'cpu')
      if (!alive(job)) return

      if (!stemsPresent(videoId, expected)) bail('Separation finished but stem files are missing')
      rmSync(join(dir, 'instrumental.wav'), { force: true })
      rmSync(join(dir, 'studio-vocals'), { recursive: true, force: true })

      // chords and the drum kit have read the float WAVs by now, so they can
      // be stored the way the container is set up to keep them
      if (STEM_FORMAT !== 'wav') {
        progress(job, 'finalize', 0, 'Compressing stems')
        await compressSong(videoId, expected)
      }
      rmSync(mixWavPath(videoId), { force: true })

      progress(job, 'finalize', 100, 'Adding to library')
      const songs = upsertSong({
        videoId,
        title: meta.title,
        duration: meta.duration,
        addedAt: existing?.addedAt ?? Date.now(),
        model: tag,
        stems: expected,
        took: Math.round((Date.now() - startedAt) / 1000),
        options: { ...options, picture }
      })
      send({ kind: 'done', data: { videoId, song: songs[0] } })
      // the playback copies are not worth making the split wait for
      void buildPreviews(videoId, expected)
    } finally {
      release()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message !== 'cancelled') send({ kind: 'failed', data: { videoId, message } })
  } finally {
    jobs.delete(videoId)
  }
}

/* ---------- storage ---------- */

async function compressSong(videoId: string, stems: string[]): Promise<void> {
  const ffmpeg = getStatus().ffmpeg.path
  if (!ffmpeg) return
  for (const name of stems) {
    const wav = join(stemsDir(videoId), `${name}.wav`)
    if (!existsSync(wav)) continue
    const { result, reason } = await compressStem(ffmpeg, wav, STEM_FORMAT)
    if (result === 'kept' && reason) console.log(`[storage] ${videoId}/${name}: left as float WAV, ${reason}`)
    if (result === 'failed') console.warn(`[storage] ${videoId}/${name}: could not compress, ${reason}`)
  }
}

function folderBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? folderBytes(path) : statSync(path).size
  }
  return total
}

let compacting = false

/* Songs split before stems were compressed are brought into line in the
   background, one at a time, so an existing library shrinks on the first
   start after an update. Only WAVs are touched: a stem already in FLAC keeps
   the depth it was stored with, and a switch to wav later converts nothing
   back, since that would only cost space. The WAV mix older songs kept
   becomes source.flac, which is exact because it was 16-bit to begin with. */
export async function compactLibrary(): Promise<void> {
  const ffmpeg = getStatus().ffmpeg.path
  if (!ffmpeg || compacting) return
  compacting = true
  let songs = 0
  let freed = 0
  try {
    for (const song of loadSongs()) {
      const { videoId } = song
      // a song being split or analysed is still using its files
      if (jobs.has(videoId) || chordJobs.has(videoId)) continue
      const dir = songDir(videoId)
      if (!existsSync(dir)) continue
      const before = folderBytes(dir)
      let touched = false

      if (STEM_FORMAT !== 'wav') {
        for (const name of stemsFor(song)) {
          const wav = join(stemsDir(videoId), `${name}.wav`)
          if (!existsSync(wav)) continue
          if (existsSync(wav.replace(/\.wav$/, '.flac'))) {
            // finished before a restart cut the tidy-up short
            rmSync(wav, { force: true })
            touched = true
            continue
          }
          const { result, reason } = await compressStem(ffmpeg, wav, STEM_FORMAT)
          if (result === 'compressed') touched = true
          else if (reason) console.log(`[storage] ${videoId}/${name}: left as float WAV, ${reason}`)
        }
      }

      const mix = mixWavPath(videoId)
      const source = sourceFile(videoId)
      if (existsSync(mix) && source === mix) {
        if (await flacCopy(ffmpeg, mix, join(dir, 'source.flac'))) {
          rmSync(mix, { force: true })
          touched = true
        }
      }

      if (touched) {
        songs++
        freed += before - folderBytes(dir)
        console.log(`[storage] ${videoId}: ${(before / 1048576).toFixed(0)} MB to ${(folderBytes(dir) / 1048576).toFixed(0)} MB`)
      }
    }
  } finally {
    compacting = false
  }
  if (songs) console.log(`[storage] compacted ${songs} songs, ${(freed / 1073741824).toFixed(2)} GB freed`)
}

async function separate(job: ActiveJob, o: SplitOptions, steps: PlannedStep[], device: string): Promise<void> {
  const { videoId } = job
  const dir = songDir(videoId)
  const stems = stemsDir(videoId)
  const mix = mixWavPath(videoId)
  const instrumental = join(dir, 'instrumental.wav')
  const studioDir = join(dir, 'studio-vocals')
  const wantsVocals = o.stems.includes('vocals')
  const vocalsFirst = o.studioVocals && wantsVocals
  const total = steps.reduce((sum, s) => sum + s.seconds, 0) || 1
  let done = 0

  for (const { step, seconds } of steps) {
    if (!alive(job)) return
    const start = (done / total) * 100
    const span = (seconds / total) * 100
    done += seconds
    // each step reports 0-100; the bar only ever moves forward
    let last = start
    const onPct = (pct: number, message?: string): void => {
      const mapped = Math.max(last, Math.min(99, start + (pct / 100) * span))
      last = mapped
      progress(job, 'separate', Math.round(mapped), message)
    }

    if (step === 'vocals') {
      onPct(0, 'Separating vocals')
      const out = o.engine === 'quick' ? stems : studioDir
      await runPython(job, roformerScript(), [
        '--input',
        mix,
        '--out',
        out,
        '--ckpt-dir',
        modelsDir(),
        '--device',
        device,
        ...(o.secondPass ? ['--second-pass'] : []),
        ...(o.engine === 'quick' ? ['--instrumental', instrumental] : [])
      ], onPct)
    } else if (step === 'demucs' || step === 'demucs6') {
      const wanted = o.stems.filter((s) => !(vocalsFirst && s === 'vocals'))
      if (wanted.length === 0) continue
      onPct(0, `Separating ${wanted.join(', ')}`)
      await runPython(job, separateScript(), [
        '--input',
        vocalsFirst ? instrumental : mix,
        '--out',
        stems,
        '--model',
        step === 'demucs6' ? 'htdemucs_6s' : 'htdemucs',
        '--device',
        device,
        '--shifts',
        o.secondPass ? '2' : '1',
        '--only',
        wanted.join(',')
      ], onPct)
    } else if (step === 'sw') {
      onPct(0, `Separating ${o.stems.join(', ')}`)
      await runPython(job, msstScript(), [
        '--model',
        'bs_roformer_sw',
        '--input',
        mix,
        '--out',
        stems,
        '--ckpt-dir',
        modelsDir(),
        '--device',
        device,
        '--only',
        o.stems.join(','),
        ...(o.secondPass ? ['--second-pass'] : []),
        ...(vocalsFirst ? ['--average', `vocals=${join(studioDir, 'vocals.wav')}`] : [])
      ], onPct)
    } else if (step === 'chords') {
      onPct(0, 'Working out the key and chords')
      const { paths, source } = chordInputs(videoId)
      await runChords(videoId, paths, source, device, job, onPct)
    } else if (step === 'drumsep') {
      onPct(0, 'Splitting the drum kit')
      const drums = join(stems, 'drums.wav')
      if (!existsSync(drums)) throw new Error('The drums stem is missing, so the kit cannot be split')
      await runPython(job, msstScript(), [
        '--model',
        'drumsep',
        '--input',
        drums,
        '--out',
        stems,
        '--ckpt-dir',
        modelsDir(),
        '--device',
        device,
        ...(o.secondPass ? ['--second-pass'] : [])
      ], onPct)
      rmSync(drums, { force: true })
    }
  }
}

/* runs a separation script, forwarding its JSON progress lines */
function runPython(
  job: ActiveJob,
  script: string,
  args: string[],
  onPct: (pct: number, message?: string) => void
): Promise<void> {
  return runProcess(job, venvPython(), [script, ...args], {
    onLine: (line) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      if (parsed.type !== 'progress') return
      const pct = Number(parsed.pct ?? 0)
      const message = typeof parsed.message === 'string' ? parsed.message : undefined
      if (message && pct === 0) onPct(0, message)
      else onPct(pct, message)
    }
  })
}

function runProcess(
  job: ActiveJob,
  cmd: string,
  args: string[],
  opts: { onStdout?: (chunk: string) => void; onLine?: (line: string) => void } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!alive(job)) return reject(new Error('cancelled'))
    const child = spawn(cmd, args, { env: process.env })
    job.proc = child

    let stdoutTail = ''
    let stderrTail = ''
    // scripts print {"type": "error"} before exiting; that beats a stderr tail
    let scriptError: string | null = null

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdoutTail = (stdoutTail + text).slice(-2000)
      opts.onStdout?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })
    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        if (line.includes('"error"')) {
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === 'error') scriptError = String(parsed.message)
          } catch {}
        }
        opts.onLine?.(line)
      })
    }

    child.on('error', reject)
    child.on('close', (code) => {
      if (!alive(job)) return reject(new Error('cancelled'))
      if (code === 0 && !scriptError) return resolve()
      if (scriptError) return reject(new Error(`Separation failed: ${scriptError}`))
      const detail =
        stderrTail.split('\n').filter(Boolean).slice(-2).join(' / ') ||
        stdoutTail.split('\n').filter(Boolean).slice(-1).join('')
      const name = cmd.split(/[\\/]/).pop()
      reject(new Error(detail ? `${name} exited (${code}): ${detail}` : `${name} exited with code ${code}`))
    })
  })
}

export function cancelJob(videoId?: string): void {
  const targets = videoId ? ([jobs.get(videoId)].filter(Boolean) as ActiveJob[]) : Array.from(jobs.values())
  for (const job of targets) {
    job.cancelled = true
    try {
      job.proc?.kill('SIGKILL')
    } catch {}
    jobs.delete(job.videoId)
    rmSync(songDir(job.videoId), { recursive: true, force: true })
    send({ kind: 'failed', data: { videoId: job.videoId, message: 'Cancelled' } })
  }
}
