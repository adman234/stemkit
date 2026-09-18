import type {
  AppSettings,
  EngineStatus,
  EnvEvent,
  EnvStatus,
  JobEvent,
  SearchResult,
  Song,
  StemKitApi,
  ChordData,
  ChordsEvent,
  UpdateEvent,
  VideoEvent
} from '../shared/types'

/* Browser implementation of the window.stemkit bridge. The desktop preload
   forwards these calls to the Electron main process over IPC; here they go
   to the StemKit server over HTTP, and main-process pushes arrive as
   server-sent events on /api/events */

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : ''
    throw new Error(message || `${method} ${path} failed (HTTP ${res.status})`)
  }
  return data as T
}

type Listener = (data: unknown) => void
const listeners = new Map<string, Set<Listener>>()

function connectEvents(): void {
  const source = new EventSource('/api/events')
  source.onmessage = (msg) => {
    let envelope: { channel: string; data: unknown }
    try {
      envelope = JSON.parse(msg.data)
    } catch {
      return
    }
    listeners.get(envelope.channel)?.forEach((cb) => cb(envelope.data))
  }
  // EventSource reconnects on its own after a dropped connection, and the
  // server replays the progress of any split still running
}

function subscribe<T>(channel: string, cb: (data: T) => void): () => void {
  let set = listeners.get(channel)
  if (!set) {
    set = new Set()
    listeners.set(channel, set)
  }
  const listener = cb as Listener
  set.add(listener)
  return () => {
    set.delete(listener)
  }
}

function download(href: string): void {
  const a = document.createElement('a')
  a.href = href
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

const api: StemKitApi = {
  envStatus: () => request<EnvStatus>('GET', '/api/status'),
  envBootstrap: () => request<boolean>('POST', '/api/env/bootstrap'),
  envUpdateYtDlp: () => request<boolean>('POST', '/api/env/update-ytdlp'),
  listSongs: () => request<Song[]>('GET', '/api/songs'),
  deleteSong: async (videoId) => {
    await request('DELETE', `/api/songs/${encodeURIComponent(videoId)}`)
  },
  getBuffers: async (videoId) => {
    const id = encodeURIComponent(videoId)
    const stems = await request<string[]>('GET', `/api/songs/${id}/stems`)
    const out: Record<string, Uint8Array> = {}
    await Promise.all(
      stems.map(async (stem) => {
        const res = await fetch(`/api/songs/${id}/stems/${encodeURIComponent(stem)}.wav`)
        if (!res.ok) throw new Error(`Missing stem ${stem} (HTTP ${res.status})`)
        out[stem] = new Uint8Array(await res.arrayBuffer())
      })
    )
    return out
  },
  getStemBuffer: async (videoId, stem) => {
    const res = await fetch(
      `/api/songs/${encodeURIComponent(videoId)}/stems/${encodeURIComponent(stem)}.wav`
    )
    if (!res.ok) throw new Error(`Could not load the ${stem} stem (HTTP ${res.status})`)
    return new Uint8Array(await res.arrayBuffer())
  },
  exportStem: async (videoId, stem) => {
    download(`/api/songs/${encodeURIComponent(videoId)}/stems/${encodeURIComponent(stem)}.wav?download=1`)
    return { saved: true }
  },
  exportAllStems: async (videoId) => {
    download(`/api/songs/${encodeURIComponent(videoId)}/export.zip`)
    return { saved: true }
  },
  searchYouTube: (query) => request<SearchResult[]>('GET', `/api/search?q=${encodeURIComponent(query)}`),
  startJob: (url, model, stems, options) =>
    request<{ started: boolean }>('POST', '/api/jobs', { url, model, stems, options }),
  cancelJob: async (videoId) => {
    await request('POST', '/api/jobs/cancel', { videoId })
  },
  openExternal: async (url) => {
    if (/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url)) {
      window.open(url, '_blank', 'noopener')
    }
  },
  getAppVersion: () => request<string>('GET', '/api/version'),
  // the container updates by pulling a new image, never in place
  installUpdate: () => undefined,
  getSettings: () => request<AppSettings>('GET', '/api/settings'),
  setSettings: (patch) => request<AppSettings>('PUT', '/api/settings', patch),
  getThumb: async (videoId) =>
    (await request<{ url: string | null }>('GET', `/api/thumbs/${encodeURIComponent(videoId)}`)).url,
  onThumbCached: (cb) => subscribe<string>('thumb:cached', cb),
  enginesStatus: () => request<EngineStatus>('GET', '/api/engines'),
  fetchEngine: async (which) => {
    await request('POST', `/api/engines/${which}`)
  },
  onUpdateEvent: (cb) => subscribe<UpdateEvent>('update:event', cb),
  onJobEvent: (cb) => subscribe<JobEvent>('job:event', cb),
  onEnvEvent: (cb) => subscribe<EnvEvent>('env:event', cb),
  onSettingsChange: (cb) => subscribe<AppSettings>('settings:changed', cb),
  fetchVideo: async (videoId) => {
    await request('POST', `/api/songs/${encodeURIComponent(videoId)}/video`)
  },
  onVideoEvent: (cb) => subscribe<VideoEvent>('video:event', cb),
  getChords: async (videoId) => {
    try {
      return await request<ChordData>('GET', `/api/songs/${encodeURIComponent(videoId)}/chords`)
    } catch {
      return null
    }
  },
  detectChords: async (videoId) => {
    await request('POST', `/api/songs/${encodeURIComponent(videoId)}/chords`)
  },
  onChordsEvent: (cb) => subscribe<ChordsEvent>('chords:event', cb),
  setChordLabel: (videoId, start, label) =>
    request<ChordData>('PUT', `/api/songs/${encodeURIComponent(videoId)}/chords/segment`, { start, label })
}

window.stemkit = api
connectEvents()
