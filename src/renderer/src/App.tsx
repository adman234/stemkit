import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AppSettings, EnvStatus, JobProgress, JobStage, Song, SplitOptions, UpdateEvent } from '../../shared/types'
import { DEFAULT_SPLIT, splitTag } from '../../shared/engines'
import { parseVideoId } from '../../shared/url'
import { Sidebar } from './components/Sidebar'
import { Home } from './components/Home'
import { Processing } from './components/Processing'
import { Player } from './components/Player'
import { Setup } from './components/Setup'
import { Settings } from './components/Settings'
import { LogoMark } from './components/Icons'

interface EnvLog {
  message: string
  level: string
}

function stageLabel(stage: JobStage, pct: number): string {
  switch (stage) {
    case 'metadata':
      return 'reading info…'
    case 'download':
      return `downloading ${Math.round(pct)}%`
    case 'convert':
      return 'converting…'
    case 'separate':
      return `separating ${Math.round(pct)}%`
    case 'finalize':
      return 'finishing…'
  }
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _drop, ...rest } = map
  return rest
}

export default function App(): React.ReactElement {
  const [status, setStatus] = useState<EnvStatus | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Record<string, JobProgress>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [lastUrl, setLastUrl] = useState('')
  const [lastOptions, setLastOptions] = useState<SplitOptions>(DEFAULT_SPLIT)
  const [envLogs, setEnvLogs] = useState<EnvLog[]>([])
  const [update, setUpdate] = useState<UpdateEvent | null>(null)
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void window.stemkit.envStatus().then(setStatus)
    void window.stemkit.listSongs().then(setSongs)
    void window.stemkit.getSettings().then(setSettings)
    const offSettings = window.stemkit.onSettingsChange(setSettings)
    const offJob = window.stemkit.onJobEvent((ev) => {
      if (ev.kind === 'progress') {
        setJobs((prev) => ({ ...prev, [ev.data.videoId]: ev.data }))
        setErrors((prev) => (prev[ev.data.videoId] ? withoutKey(prev, ev.data.videoId) : prev))
      } else if (ev.kind === 'done') {
        setJobs((prev) => withoutKey(prev, ev.data.videoId))
        setErrors((prev) => withoutKey(prev, ev.data.videoId))
        void window.stemkit.listSongs().then(setSongs)
      } else if (ev.data.message === 'Cancelled') {
        setJobs((prev) => withoutKey(prev, ev.data.videoId))
      } else {
        setJobs((prev) => withoutKey(prev, ev.data.videoId))
        setErrors((prev) => ({ ...prev, [ev.data.videoId]: ev.data.message }))
      }
    })
    const offEnv = window.stemkit.onEnvEvent((e) =>
      setEnvLogs((l) => [...l.slice(-300), { message: e.message, level: e.level }])
    )
    const offUpdate = window.stemkit.onUpdateEvent((e) => setUpdate(e))
    // a finished video download changes the song, so the player can switch
    // from the YouTube embed to the local file
    const offVideo = window.stemkit.onVideoEvent?.((ev) => {
      if (ev.ready) void window.stemkit.listSongs().then(setSongs)
    })
    void window.stemkit.getAppVersion().then(setAppVersion)
    return () => {
      offJob()
      offEnv()
      offUpdate()
      offSettings()
      offVideo?.()
    }
  }, [])

  useEffect(() => {
    if (status?.ready && envLogs.length > 0) {
      void window.stemkit.envStatus().then(setStatus)
    }
  }, [status?.ready])

  const startUrl = useCallback(
    async (url: string, options: SplitOptions): Promise<void> => {
      const vid = parseVideoId(url)
      if (!vid) return
      setActiveId(vid)
      setLastUrl(url)
      setLastOptions(options)
      setErrors((prev) => withoutKey(prev, vid))
      setJobs((prev) =>
        prev[vid]
          ? prev
          : {
              ...prev,
              [vid]: { videoId: vid, stage: 'metadata', pct: 0, message: 'Starting…', model: splitTag(options) }
            }
      )
      await window.stemkit.startJob(url, undefined, options.stems, options)
    },
    []
  )

  const cancelSelectedJob = useCallback(
    (videoId: string): void => {
      void window.stemkit.cancelJob(videoId)
      setJobs((prev) => withoutKey(prev, videoId))
    },
    []
  )

  const retryJob = useCallback((): void => {
    if (lastUrl) void startUrl(lastUrl, lastOptions)
  }, [lastUrl, lastOptions, startUrl])

  const updateYtDlp = useCallback(async (): Promise<void> => {
    await window.stemkit.envUpdateYtDlp()
    if (lastUrl) void startUrl(lastUrl, lastOptions)
  }, [lastUrl, lastOptions, startUrl])

  const deleteSong = useCallback(
    async (videoId: string): Promise<void> => {
      if (jobs[videoId]) return
      setErrors((prev) => withoutKey(prev, videoId))
      await window.stemkit.deleteSong(videoId)
      setSongs(await window.stemkit.listSongs())
      setActiveId((cur) => (cur === videoId ? null : cur))
    },
    [jobs]
  )

  const activeSong = useMemo(
    () => songs.find((s) => s.videoId === activeId) ?? null,
    [songs, activeId]
  )

  const selectedJob = useMemo(
    () => (activeId ? jobs[activeId] ?? null : null),
    [jobs, activeId]
  )
  const selectedError = useMemo(
    () => (activeId ? errors[activeId] ?? null : null),
    [errors, activeId]
  )

  const pendingMap = useMemo(() => {
    const map: Record<string, { label: string; error?: boolean }> = {}
    for (const j of Object.values(jobs)) {
      map[j.videoId] = { label: stageLabel(j.stage, j.pct) }
    }
    for (const [id, message] of Object.entries(errors)) {
      if (!map[id]) {
        map[id] = { label: /already being processed/.test(message) ? 'queued' : 'failed', error: true }
      }
    }
    return map
  }, [jobs, errors])

  const displaySongs = useMemo(() => {
    const known = new Set(songs.map((s) => s.videoId))
    const top: Song[] = []
    for (const j of Object.values(jobs)) {
      if (!known.has(j.videoId)) {
        top.push({
          videoId: j.videoId,
          title: j.title ?? '',
          duration: 0,
          addedAt: 0,
          model: j.model
        })
        known.add(j.videoId)
      }
    }
    for (const id of Object.keys(errors)) {
      if (!known.has(id)) {
        top.push({ videoId: id, title: '', duration: 0, addedAt: 0 })
        known.add(id)
      }
    }
    return [...top, ...songs]
  }, [songs, jobs, errors])

  if (!status) {
    return (
      <div className="h-full flex items-center justify-center">
        <LogoMark className="w-12 h-12 animate-pulse" />
      </div>
    )
  }

  if (!status.ready) {
    return (
      <Setup
        status={status}
        logs={envLogs}
        onInstall={() => {
          void window.stemkit.envBootstrap().then(() => window.stemkit.envStatus().then(setStatus))
        }}
      />
    )
  }

  const selectedIsBusy = !!(selectedJob || selectedError)

  let main: React.ReactElement
  if (selectedIsBusy) {
    main = (
      <Processing
        job={selectedJob}
        error={selectedError}
        botSuspected={
          !!selectedError && /sign in|bot|confirm|unavailable|private/i.test(selectedError)
        }
        onCancel={() => activeId && cancelSelectedJob(activeId)}
        onRetry={retryJob}
        onUpdateYtDlp={() => void updateYtDlp()}
      />
    )
  } else if (activeSong) {
    main = <Player key={activeSong.videoId} song={activeSong} settings={settings ?? undefined} />
  } else {
    main = (
      <Home
        songs={displaySongs}
        pending={pendingMap}
        gpu={!!status.gpu && !!settings?.gpuSplit}
        onStart={(u, o) => void startUrl(u, o)}
        onSelect={(id) => setActiveId(id)}
        onOpenSettings={() => {
          void window.stemkit.envStatus().then(setStatus)
          setSettingsOpen(true)
        }}
      />
    )
  }

  return (
    <div className="h-full flex">
      <Sidebar
        songs={displaySongs}
        activeId={activeId}
        pending={pendingMap}
        update={update ?? undefined}
        appVersion={appVersion}
        onSelect={(id) => setActiveId(id)}
        onDelete={(id) => void deleteSong(id)}
        onAdd={() => setActiveId(null)}
        onInstallUpdate={() => window.stemkit.installUpdate()}
        onOpenSettings={() => {
          void window.stemkit.envStatus().then(setStatus)
          setSettingsOpen(true)
        }}
      />
      <main className="flex-1 min-w-0">{main}</main>
      {settings && settingsOpen && (
        <Settings
          settings={settings}
          gpu={status.gpu}
          nvidiaGpu={status.nvidiaGpu}
          onChange={(patch) => void window.stemkit.setSettings(patch)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
