import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { extname, join, normalize, sep } from 'path'
import { timingSafeEqual } from 'crypto'
import type { AppSettings, EnvStatus } from '../shared/types'
import {
  APP_DIR,
  appVersion,
  detectNvidiaGpu,
  detectTools,
  engineStatus,
  ensureFtWeights,
  ensureGpuEngine,
  ensureModel,
  getStatus,
  gpuAccelerationInfo,
  hasGpuAcceleration,
  nvidiaGpuInfo,
  updateYtDlp,
  userDataDir
} from './env'
import { attachClient } from './events'
import { writeZip, zipSize, type ZipEntry } from './zip'
// desktop main-process modules, reused as-is (see scripts/build-server.mjs)
import { loadSettings, saveSettings } from '../main/settings'
import { loadSongs, mixWavPath, removeSong, stemsDir, stemsFor } from '../main/library'
import {
  buildPreviews,
  cancelJob,
  chordsPath,
  detectChords,
  ensurePreview,
  fetchVideo,
  hasChords,
  hasVideo,
  previewPath,
  searchYouTube,
  startJob,
  videoPath
} from './pipeline'
import { MODELS } from '../shared/engines'
import { clearThumbMemo, getThumb } from '../main/thumbs'

const PORT = Number(process.env.PORT ?? 8080)
const HOST = process.env.HOST ?? '0.0.0.0'
const WEB_ROOT = normalize(join(APP_DIR, 'out', 'web'))
const USERNAME = process.env.STEMKIT_USERNAME ?? ''
const PASSWORD = process.env.STEMKIT_PASSWORD ?? ''

const VIDEO_ID = /^[\w-]{11}$/
const STEM_NAME = /^(vocals|drums|bass|other|piano|guitar|kick|snare|toms|hihat|ride|crash)$/

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

type Params = Record<string, string>
type Handler = (req: IncomingMessage, res: ServerResponse, params: Params, url: URL) => Promise<unknown>

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
}

const routes: Route[] = []

function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = []
  const pattern = new RegExp(
    '^' +
      path.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_m, key: string) => {
        keys.push(key)
        return '([^/]+)'
      }) +
      '$'
  )
  routes.push({ method, pattern, keys, handler })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body === undefined ? null : body)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new HttpError(413, 'Request body too large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new HttpError(400, 'Invalid JSON body')
  }
}

function videoIdParam(params: Params): string {
  const id = params.videoId
  if (!VIDEO_ID.test(id)) throw new HttpError(400, 'Invalid video id')
  return id
}

function sanitizeName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').trim()
  return clean.length > 0 ? clean.slice(0, 120) : 'stems'
}

function attachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}

function songTitle(videoId: string): string {
  return loadSongs().find((s) => s.videoId === videoId)?.title ?? videoId
}

/* serves a file with range requests, which media elements need in order to
   seek, plus an ETag so a reload does not fetch it again */
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, contentType: string): void {
  const st = statSync(file)
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, no-cache',
    ETag: etag
  }
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '')
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]))
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1
    if (start >= st.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Content-Length': end - start + 1
    })
    if (req.method !== 'HEAD') createReadStream(file, { start, end }).pipe(res)
    else res.end()
    return
  }
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size })
  if (req.method !== 'HEAD') createReadStream(file).pipe(res)
  else res.end()
}

/* ---------- API ---------- */

route('GET', '/healthz', async (_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' })
  res.end('ok')
})

route('GET', '/api/events', async (_req, res) => {
  attachClient(res)
})

route('GET', '/api/status', async () => {
  await detectTools()
  void detectNvidiaGpu()
  const s = getStatus()
  const status: EnvStatus = {
    python: s.python,
    ffmpeg: { found: s.ffmpeg.found, path: s.ffmpeg.path },
    ready: s.ready,
    bootstrapping: s.bootstrapping,
    updating: s.updating,
    gpu: gpuAccelerationInfo(),
    nvidiaGpu: nvidiaGpuInfo()
  }
  if (status.ready) void hasGpuAcceleration()
  return status
})

// the desktop app installs its engine here; in the container the engine is
// baked in, so "bootstrap" just re-checks the tools and reports why not
route('POST', '/api/env/bootstrap', async () => {
  await detectTools(true)
  return getStatus().ready
})

route('POST', '/api/env/update-ytdlp', async () => updateYtDlp())

route('GET', '/api/version', async () => appVersion())

route('GET', '/api/songs', async () =>
  loadSongs().map((song) => ({
    ...song,
    ...(hasVideo(song.videoId) ? { video: true } : {}),
    ...(hasChords(song.videoId) ? { chords: true } : {})
  }))
)

route('GET', '/api/songs/:videoId/chords', async (_req, _res, params) => {
  const file = chordsPath(videoIdParam(params))
  if (!existsSync(file)) throw new HttpError(404, 'No chords worked out for this song')
  return JSON.parse(readFileSync(file, 'utf8'))
})

route('POST', '/api/songs/:videoId/chords', async (_req, _res, params) => {
  void detectChords(videoIdParam(params))
  return null
})

const CHORD_LABEL = /^(N|[A-G]#?(:(maj|min|7|maj7|min7|sus4|dim|aug))?)$/

/* corrects one chord by hand; the detected label is kept underneath so it
   can be put back */
route('PUT', '/api/songs/:videoId/chords/segment', async (req, _res, params) => {
  const videoId = videoIdParam(params)
  const file = chordsPath(videoId)
  if (!existsSync(file)) throw new HttpError(404, 'No chords worked out for this song')
  const body = await readJson(req)
  if (typeof body.start !== 'number') throw new HttpError(400, 'Missing segment start')
  const label = body.label === null ? null : String(body.label)
  if (label !== null && !CHORD_LABEL.test(label)) throw new HttpError(400, `Not a chord: ${label}`)

  const data = JSON.parse(readFileSync(file, 'utf8')) as {
    segments: { start: number; label: string; user?: string }[]
  }
  const segment = data.segments.find((s) => Math.abs(s.start - (body.start as number)) < 0.01)
  if (!segment) throw new HttpError(404, 'No chord starts there')
  if (label === null || label === segment.label) delete segment.user
  else segment.user = label
  writeFileSync(file, JSON.stringify(data))
  return data
})

route('POST', '/api/songs/:videoId/video', async (_req, _res, params) => {
  void fetchVideo(videoIdParam(params))
  return null
})

/* the <video> element needs range requests to seek */
route('GET', '/api/songs/:videoId/video.mp4', async (req, res, params) => {
  const videoId = videoIdParam(params)
  const file = videoPath(videoId)
  if (!existsSync(file)) throw new HttpError(404, 'No video downloaded for this song')
  sendFile(req, res, file, 'video/mp4')
})

route('DELETE', '/api/songs/:videoId', async (_req, _res, params) => {
  return removeSong(videoIdParam(params))
})

route('GET', '/api/songs/:videoId/stems', async (_req, _res, params) => {
  const videoId = videoIdParam(params)
  return stemsFor(loadSongs().find((s) => s.videoId === videoId))
})

/* the compressed copy the player listens to, made on the spot for songs that
   were split before playback copies existed */
route('GET', '/api/songs/:videoId/stems/:stem.m4a', async (req, res, params) => {
  const videoId = videoIdParam(params)
  const stem = params.stem
  if (!STEM_NAME.test(stem)) throw new HttpError(400, 'Invalid stem name')
  if (!(await ensurePreview(videoId, stem))) throw new HttpError(404, `No playback copy for ${stem}`)
  // get the rest ready while this one plays, so the wait happens once
  const song = loadSongs().find((s) => s.videoId === videoId)
  const rest = (song?.stems ?? []).filter((name) => name !== stem)
  if (rest.length) void buildPreviews(videoId, rest)
  sendFile(req, res, previewPath(videoId, stem), 'audio/mp4')
})

route('GET', '/api/songs/:videoId/stems/:stem', async (req, res, params, url) => {
  const videoId = videoIdParam(params)
  const stem = params.stem.replace(/\.wav$/, '')
  if (!STEM_NAME.test(stem)) throw new HttpError(400, 'Invalid stem name')
  const file = join(stemsDir(videoId), `${stem}.wav`)
  if (!existsSync(file)) throw new HttpError(404, `Missing stem ${stem}`)
  if (!url.searchParams.has('download')) {
    // playback should be using the compressed copy; if it is not, the reason
    // is in the [preview] line above this one
    console.log(`[stem] ${videoId}/${stem}: serving the full WAV for playback`)
  }
  const st = statSync(file)
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`
  const headers: Record<string, string | number> = {
    'Content-Type': 'audio/wav',
    'Cache-Control': 'private, no-cache',
    ETag: etag
  }
  if (url.searchParams.has('download')) {
    headers['Content-Disposition'] = attachment(`${sanitizeName(songTitle(videoId))} - ${stem}.wav`)
  } else if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers)
    res.end()
    return
  }
  headers['Content-Length'] = st.size
  res.writeHead(200, headers)
  createReadStream(file).pipe(res)
})

route('GET', '/api/songs/:videoId/export.zip', async (_req, res, params) => {
  const videoId = videoIdParam(params)
  const song = loadSongs().find((s) => s.videoId === videoId)
  const title = sanitizeName(song?.title ?? videoId)
  const entries: ZipEntry[] = []
  for (const name of stemsFor(song)) {
    const path = join(stemsDir(videoId), `${name}.wav`)
    if (!existsSync(path)) throw new HttpError(404, `Missing stem ${name}`)
    entries.push({ name: `${title}/${name}.wav`, path })
  }
  if (existsSync(mixWavPath(videoId))) {
    entries.push({ name: `${title}/${title}.wav`, path: mixWavPath(videoId) })
  }
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zipSize(entries),
    'Content-Disposition': attachment(`${title}.zip`),
    'Cache-Control': 'no-store'
  })
  try {
    await writeZip(res, entries)
    res.end()
  } catch (err) {
    console.error(`[export] ${videoId}: ${err instanceof Error ? err.message : String(err)}`)
    res.destroy()
  }
})

route('POST', '/api/jobs', async (req) => {
  const body = await readJson(req)
  if (typeof body.url !== 'string' || !body.url.trim()) throw new HttpError(400, 'Missing url')
  const model = typeof body.model === 'string' ? body.model : undefined
  let stems: string[] | undefined
  if (Array.isArray(body.stems)) {
    stems = body.stems.filter((s): s is string => typeof s === 'string' && STEM_NAME.test(s))
  }
  void startJob(body.url, model, stems, body.options && typeof body.options === 'object' ? body.options : undefined)
  return { started: true }
})

route('POST', '/api/jobs/cancel', async (req) => {
  const body = await readJson(req)
  const videoId = typeof body.videoId === 'string' && VIDEO_ID.test(body.videoId) ? body.videoId : undefined
  // an empty body would cancel every job; the UI always names one
  if (!videoId) throw new HttpError(400, 'Missing video id')
  cancelJob(videoId)
  return null
})

route('GET', '/api/search', async (_req, _res, _params, url) => {
  return searchYouTube(url.searchParams.get('q') ?? '')
})

route('GET', '/api/settings', async () => loadSettings())

route('PUT', '/api/settings', async (req) => {
  const patch = (await readJson(req)) as Partial<AppSettings>
  const next = saveSettings(patch)
  // hideVideo flips the thumbnail source, so cached lookups must retry
  clearThumbMemo()
  return next
})

route('GET', '/api/thumbs/:videoId', async (_req, _res, params) => {
  return { url: await getThumb(params.videoId) }
})

route('GET', '/api/engines', async () => {
  if (getStatus().ready) void hasGpuAcceleration()
  return engineStatus()
})

route('POST', '/api/engines/:which', async (_req, _res, params) => {
  if (Object.hasOwn(MODELS, params.which)) void ensureModel(params.which as keyof typeof MODELS)
  else if (params.which === 'ft') void ensureFtWeights()
  else if (params.which === 'gpu') void ensureGpuEngine()
  else throw new HttpError(404, 'Unknown engine')
  return null
})

/* ---------- static web UI ---------- */

function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
  let file = normalize(join(WEB_ROOT, pathname === '/' ? 'index.html' : pathname))
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (pathname.startsWith('/assets/')) {
      res.writeHead(404)
      res.end()
      return
    }
    file = join(WEB_ROOT, 'index.html')
  }
  if (!existsSync(file)) {
    res.writeHead(503, { 'Content-Type': 'text/plain' })
    res.end('Web UI is not built. Run npm run web:build.')
    return
  }
  const hashed = pathname.startsWith('/assets/')
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache'
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  createReadStream(file).pipe(res)
}

/* ---------- auth + dispatch ---------- */

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

function authorized(req: IncomingMessage): boolean {
  if (!PASSWORD) return true
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Basic ')) return false
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) return false
  const user = decoded.slice(0, colon)
  const pass = decoded.slice(colon + 1)
  return (!USERNAME || safeEqual(user, USERNAME)) && safeEqual(pass, PASSWORD)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    res.writeHead(400)
    res.end()
    return
  }

  if (pathname !== '/healthz' && !authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="StemKit", charset="UTF-8"' })
    res.end('Authentication required')
    return
  }

  if (!pathname.startsWith('/api/') && pathname !== '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    serveStatic(req, res, pathname)
    return
  }

  for (const r of routes) {
    if (r.method !== req.method) continue
    const m = pathname.match(r.pattern)
    if (!m) continue
    const params: Params = {}
    r.keys.forEach((key, i) => {
      params[key] = m[i + 1]
    })
    r.handler(req, res, params, url)
      .then((result) => {
        if (!res.headersSent) sendJson(res, 200, result)
      })
      .catch((err: unknown) => {
        const status = err instanceof HttpError ? err.status : 500
        const message = err instanceof Error ? err.message : String(err)
        if (status >= 500) console.error(`[api] ${req.method} ${pathname}: ${message}`)
        if (!res.headersSent) sendJson(res, status, { error: message })
        else res.destroy()
      })
    return
  }
  sendJson(res, 404, { error: 'Not found' })
})

async function startup(): Promise<void> {
  mkdirSync(userDataDir(), { recursive: true })
  console.log(`[stemkit] ${appVersion()}, data in ${userDataDir()}`)

  server.listen(PORT, HOST, () => {
    console.log(`[stemkit] web UI on http://${HOST}:${PORT}${PASSWORD ? ' (password protected)' : ''}`)
  })

  await detectTools()
  if (!getStatus().ready) return
  const gpu = await hasGpuAcceleration()
  void detectNvidiaGpu()

  // first run: split on the GPU whenever one is visible, instead of the
  // desktop default of CPU until the user opts in
  if (!existsSync(join(userDataDir(), 'settings.json'))) saveSettings({ gpuSplit: gpu })

  // pre-fetch the optional checkpoints the user already opted into
  const settings = loadSettings()
  if (settings.roformerVocals) void ensureModel('vocals')
  if (settings.htdemucsFt) void ensureFtWeights()

  if (/^(1|true|yes)$/i.test(process.env.YTDLP_AUTO_UPDATE ?? '')) void updateYtDlp()
}

function shutdown(signal: string): void {
  console.log(`[stemkit] ${signal}, stopping`)
  cancelJob()
  server.close()
  setTimeout(() => process.exit(0), 500).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

void startup()
