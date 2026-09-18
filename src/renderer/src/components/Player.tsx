import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, ChordData, Song, StemId } from '../../../shared/types'
import { DEFAULT_STEMS } from '../../../shared/types'
import { audioContext, engine, decodePayload, type BufferMap } from '../lib/engine'
import { buildStemMeta } from '../lib/stems'
import { fmtTime } from '../lib/format'
import { Thumb } from '../lib/thumbs'
import { YouTubeHost, type YTState } from '../lib/youtube'
import { LocalVideoHost, type VideoHost } from '../lib/video'
import { StemLane } from './StemLane'
import { ChordTimeline } from './ChordTimeline'
import { Transport, type PresetId } from './Transport'
import { DownloadIcon } from './Icons'
import { DRUM_KIT, splitLabel } from '../../../shared/engines'

type BufferCacheMap = BufferMap

type Progress = (done: number, total: number, note?: string) => void

const bufferCache = new Map<string, Promise<BufferCacheMap>>()

/* Fetch and decode a stem, then the next one. Loading them all at once needs
   every encoded stem and every decoded stem in memory together, which a phone
   will not survive on a song split into a dozen parts */
async function loadBuffers(song: Song, onProgress: Progress): Promise<BufferCacheMap> {
  const stems = song.stems?.length ? song.stems : DEFAULT_STEMS
  const fetchStem = window.stemkit.getStemBuffer
  if (!fetchStem) {
    // the desktop app hands over every stem in one go
    return decodePayload(await window.stemkit.getBuffers(song.videoId), onProgress)
  }
  const ctx = audioContext()
  const out: BufferCacheMap = {}
  let warnedSlow = false
  for (let i = 0; i < stems.length; i++) {
    // the first stem can wait on the server making its playback copy, which
    // happens once per song: say so rather than looking stuck
    const slow = setTimeout(() => {
      warnedSlow = true
      onProgress(i, stems.length, 'the server is preparing this song for playback')
    }, 3000)
    let loadedStem
    try {
      loadedStem = await fetchStem(song.videoId, stems[i])
    } finally {
      clearTimeout(slow)
    }
    out[stems[i] as StemId] = await ctx.decodeAudioData(loadedStem.bytes.buffer as ArrayBuffer)
    onProgress(
      i + 1,
      stems.length,
      loadedStem.compressed ? (warnedSlow ? '' : undefined) : 'full quality audio, which is slower to load'
    )
  }
  return out
}

function getDecoded(song: Song, onProgress: Progress): Promise<BufferCacheMap> {
  let entry = bufferCache.get(song.videoId)
  if (!entry) {
    entry = loadBuffers(song, onProgress).catch((err) => {
      bufferCache.delete(song.videoId)
      throw err
    })
    bufferCache.set(song.videoId, entry)
  }
  return entry
}

interface Props {
  song: Song
  settings?: AppSettings
}

export function Player({ song, settings }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<VideoHost | null>(null)
  const posRef = useRef(0)
  const playingRef = useRef(false)

  const [ytReady, setYtReady] = useState(false)
  const [decoding, setDecoding] = useState(true)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState<{ done: number; total: number; note?: string } | null>(null)
  const [reloads, setReloads] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(song.duration || 0)
  const [bump, setBump] = useState(0)
  const [buffers, setBuffers] = useState<BufferMap>({})
  const [videoPct, setVideoPct] = useState<number | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [videoStuck, setVideoStuck] = useState(false)
  const [chords, setChords] = useState<ChordData | null>(null)
  const [chordsBusy, setChordsBusy] = useState(false)
  const [chordsError, setChordsError] = useState<string | null>(null)

  const [vols, setVols] = useState<Partial<Record<StemId, number>>>({})
  const [mutes, setMutes] = useState<Set<StemId>>(new Set())
  const [solos, setSolos] = useState<Set<StemId>>(new Set())
  const [master, setMaster] = useState(0.9)
  const [preset, setPreset] = useState<PresetId | 'custom'>('all')

  const stemMeta = useMemo(() => buildStemMeta(Object.keys(buffers) as StemId[]), [buffers])

  const youtubeUrl = `https://www.youtube.com/watch?v=${song.videoId}`
  // stems always play locally from the library; hiding the video just stops
  // streaming it from YouTube (and switches thumbnails to the local cache)
  const hideVideo = settings?.hideVideo ?? false
  const addedLabel = new Date(song.addedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })

  useEffect(() => {
    posRef.current = 0
    setPlaying(false)
    playingRef.current = false
    setYtReady(false)
    setVideoPct(null)
    setVideoError(null)
    setDecodeError(null)
    setBuffers({})
    setDuration(song.duration || 0)
    setVols({})
    setMutes(new Set())
    setSolos(new Set())
    setPreset('all')
    engine.stopAll()

    let cancelled = false
    setDecoding(true)
    setLoaded(null)
    getDecoded(song, (done, total, note) => {
      if (!cancelled) setLoaded((prev) => ({ done, total, note: note === undefined ? prev?.note : note || undefined }))
    })
      .then((decoded) => {
        if (cancelled) return
        setBuffers(decoded)
        engine.setBuffers(decoded)
        setVols(Object.fromEntries(Object.keys(decoded).map((id) => [id, 1])))
        const d = engine.trackDuration()
        if (d > 0) setDuration(d)
        setDecoding(false)
      })
      .catch((err) => {
        if (cancelled) return
        setDecoding(false)
        setDecodeError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      engine.stopAll()
      hostRef.current?.destroy()
      hostRef.current = null
    }
  }, [song.videoId, reloads])

  useEffect(() => {
    if (hideVideo) {
      hostRef.current?.destroy()
      hostRef.current = null
      setYtReady(false)
      return
    }
    if (decoding || decodeError) return
    const wantsLocal = !!song.video
    if (hostRef.current) {
      // already running the right source
      if (hostRef.current instanceof LocalVideoHost === wantsLocal) return
      hostRef.current.destroy()
      hostRef.current = null
      setYtReady(false)
    }
    let disposed = false
    const container = containerRef.current
    if (!container) return

    const host: VideoHost = wantsLocal ? new LocalVideoHost() : new YouTubeHost()
    hostRef.current = host
    setVideoStuck(false)
    void host
      .mount(container, song.videoId, (state: YTState) => {
        if (disposed || !engine.hasBuffers()) return
        if (state === 'playing' && !playingRef.current) host.pause()
      })
      .then(() => {
        if (disposed) return
        setYtReady(true)
        // the source can change mid-song (the video finished downloading):
        // pick the picture up where the stems already are
        if (playingRef.current) {
          host.seek(posRef.current)
          host.play()
        }
      })

    return () => {
      disposed = true
    }
  }, [song.videoId, song.video, decoding, decodeError, hideVideo])

  useEffect(() => {
    setChords(null)
    setChordsError(null)
    if (!song.chords || !window.stemkit.getChords) return
    let alive = true
    void window.stemkit.getChords(song.videoId).then((data) => {
      if (alive) setChords(data)
    })
    return () => {
      alive = false
    }
  }, [song.videoId, song.chords])

  useEffect(() => {
    if (!window.stemkit.onChordsEvent) return
    return window.stemkit.onChordsEvent((ev) => {
      if (ev.videoId !== song.videoId) return
      if (ev.error) {
        setChordsError(ev.error)
        setChordsBusy(false)
      } else if (ev.ready) {
        setChordsBusy(false)
        setChordsError(null)
        void window.stemkit.getChords?.(song.videoId).then(setChords)
      } else if (ev.running) {
        setChordsBusy(true)
        setChordsError(null)
      }
    })
  }, [song.videoId])

  useEffect(() => {
    if (!window.stemkit.onVideoEvent) return
    return window.stemkit.onVideoEvent((ev) => {
      if (ev.videoId !== song.videoId) return
      if (ev.error) {
        setVideoError(ev.error)
        setVideoPct(null)
      } else if (ev.ready) {
        setVideoPct(null)
        setVideoError(null)
      } else if (typeof ev.pct === 'number') {
        setVideoPct(ev.pct)
        setVideoError(null)
      }
    })
  }, [song.videoId])

  useEffect(() => {
    engine.applyMix(vols, mutes, solos, master)
  }, [vols, mutes, solos, master])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = (): void => {
      posRef.current = engine.expected()

      const dur = engine.trackDuration()
      if (dur > 0 && posRef.current >= dur - 0.03) {
        posRef.current = dur
        engine.stopAll()
        playingRef.current = false
        setPlaying(false)
        hostRef.current?.pause()
        setBump((n) => n + 1)
        return
      }

      hostRef.current?.sync(posRef.current, playingRef.current)
    }
    const loop = (): void => {
      tick()
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    const backup = setInterval(tick, 400)
    return () => {
      cancelAnimationFrame(raf)
      clearInterval(backup)
    }
  }, [playing])

  useEffect(() => {
    const id = setInterval(() => {
      const host = hostRef.current
      const d = host?.duration() ?? 0
      if (d > 0) {
        setDuration((prev) => (Math.abs(prev - d) > 0.5 ? d : prev))
      }
      setVideoStuck(host instanceof YouTubeHost && host.desynced())
    }, 600)
    return () => clearInterval(id)
  }, [])

  const togglePlay = useCallback((): void => {
    if (decoding || decodeError) return
    if (playingRef.current) {
      playingRef.current = false
      engine.setPlaying(false, posRef.current)
      hostRef.current?.pause()
      setPlaying(false)
    } else {
      playingRef.current = true
      engine.resume()
      engine.setPlaying(true, posRef.current)
      hostRef.current?.play()
      setPlaying(true)
    }
  }, [decoding, decodeError, hideVideo])

  const seekTo = useCallback(
    (t: number): void => {
      const clamped = Math.max(0, Math.min(duration > 0 ? duration - 0.05 : t, t))
      posRef.current = clamped
      engine.setPlaying(playingRef.current, clamped)
      hostRef.current?.seek(clamped)
      setBump((n) => n + 1)
    },
    [duration]
  )

  const getPosition = useCallback((): number => {
    void bump
    return posRef.current
  }, [bump])

  const exportStem = useCallback(
    (stem: string): void => {
      void window.stemkit.exportStem(song.videoId, stem)
    },
    [song.videoId]
  )

  const exportAllStems = useCallback((): void => {
    void window.stemkit.exportAllStems(song.videoId)
  }, [song.videoId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault()
        togglePlay()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay])

  const applyPreset = (p: PresetId): void => {
    setPreset(p)
    setMutes(new Set())
    if (p === 'all') setSolos(new Set())
    else if (p === 'karaoke')
      setSolos(new Set<StemId>(stemMeta.filter((s) => s.id !== 'vocals').map((s) => s.id)))
    else if (p === 'acapella') setSolos(new Set<StemId>(['vocals']))
    else if (p === 'drumnbass')
      setSolos(new Set<StemId>((['drums', ...DRUM_KIT, 'bass'] as StemId[]).filter((id) => stemMeta.some((s) => s.id === id))))
  }

  const toggleMute = (id: StemId): void => {
    setPreset('custom')
    const turningOn = !mutes.has(id)
    if (turningOn && solos.has(id)) {
      setSolos((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
    setMutes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleSolo = (id: StemId): void => {
    setPreset('custom')
    const turningOn = !solos.has(id)
    if (turningOn && mutes.has(id)) {
      setMutes((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
    setSolos((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="h-full flex flex-col">
      <header className="drag-region h-12 md:h-14 shrink-0 flex items-center justify-between px-4 md:px-6">
        <h2 className="text-sm font-semibold truncate">{song.title}</h2>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 md:px-6 pb-4 md:pb-6">
        <div className="w-full">
          <div className="flex flex-col md:flex-row md:items-stretch gap-3 md:gap-4 md:h-[220px] 2xl:h-[300px]">
            {!hideVideo && (
              <div className="relative w-full md:w-auto md:h-full aspect-video shrink-0">
                <div className="absolute -inset-4 bg-violet-500/10 blur-3xl rounded-full pointer-events-none" />
                <div className="absolute inset-0 rounded-xl overflow-hidden ring-1 ring-white/10 bg-black shadow-2xl shadow-black/60">
                  <div ref={containerRef} className="absolute inset-0 [&_iframe]:w-full [&_iframe]:h-full" />
                  {!ytReady && (
                    <div className="absolute inset-0 flex items-center justify-center animate-pulse">
                      <span className="text-[10px] text-white/40 tracking-widest uppercase">loading…</span>
                    </div>
                  )}
                  {decodeError && (
                    <div className="absolute inset-x-3 bottom-3 flex justify-center rise-in">
                      <div className="glass rounded-lg px-3 py-1.5 text-xs text-rose-300 break-words">
                        {decodeError}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            <aside className="flex-1 min-w-0 glass rounded-2xl px-4 md:px-6 py-4 md:py-5 rise-in flex flex-col justify-between gap-3">
              <div className="flex items-center gap-4">
                <Thumb
                  videoId={song.videoId}
                  className="hidden sm:block w-24 lg:w-32 h-[54px] lg:h-[72px] rounded-lg object-cover bg-white/5 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <h3 className="text-base md:text-xl font-semibold leading-snug truncate">{song.title}</h3>
                  <p className="text-xs text-white/45 mt-1.5 font-mono truncate">
                    {fmtTime(song.duration)} · added {addedLabel}
                    {song.took ? ` · split in ${fmtTime(song.took)}` : ''}
                    {song.options ? ` · ${splitLabel(song.options)}` : ''}
                    {chords ? ` · ${chords.key.name}` : ''}
                  </p>
                  {decoding && loaded?.note && (
                    <p className="text-[11px] text-white/45 mt-1">{loaded.note}</p>
                  )}
                </div>
                <span className="shrink-0 text-xs px-3 py-1.5 rounded-full bg-white/5 text-white/50 font-medium">
                  {decoding && loaded
                    ? `loading ${loaded.done} of ${loaded.total}`
                    : `${stemMeta.length || song.stems?.length || 0} stems`}
                </span>
              </div>

              {decodeError && (
                <div className="rounded-xl bg-rose-500/10 border border-rose-400/20 px-3 py-2 text-xs text-rose-200 break-words">
                  {decodeError}
                  <button
                    onClick={() => {
                      bufferCache.delete(song.videoId)
                      setDecodeError(null)
                      setReloads((n) => n + 1)
                    }}
                    className="no-drag ml-2 underline hover:text-white"
                  >
                    Try again
                  </button>
                </div>
              )}

              <div className="flex items-center gap-x-6 gap-y-2 flex-wrap">
                {stemMeta.length <= 6 && stemMeta.map((meta) => (
                  <span key={meta.id} className="flex items-center gap-2 text-[14px] text-white/75">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: meta.color }} />
                    <span className="capitalize">{meta.label}</span>
                  </span>
                ))}
              </div>

              {!song.chords && window.stemkit.detectChords && (
                <div className="text-[11.5px] leading-snug">
                  {chordsBusy ? (
                    <span className="text-white/45">Working out the key and chords…</span>
                  ) : (
                    <button
                      onClick={() => {
                        setChordsError(null)
                        setChordsBusy(true)
                        void window.stemkit.detectChords?.(song.videoId)
                      }}
                      className="no-drag text-violet-300 hover:text-violet-200 transition-colors"
                    >
                      Detect the key and chords →
                    </button>
                  )}
                  {chordsError && <span className="block text-rose-300 mt-0.5">{chordsError}</span>}
                </div>
              )}

              {!hideVideo && !song.video && (
                <div className="text-[11.5px] leading-snug">
                  {videoPct !== null ? (
                    <span className="text-white/45 font-mono">Downloading video… {videoPct}%</span>
                  ) : (
                    <button
                      onClick={() => {
                        setVideoError(null)
                        setVideoPct(0)
                        void window.stemkit.fetchVideo?.(song.videoId)
                      }}
                      className="no-drag text-violet-300 hover:text-violet-200 transition-colors"
                    >
                      {videoStuck
                        ? 'The YouTube player keeps falling behind. Download the video for smooth sync →'
                        : 'Download the video for smooth sync →'}
                    </button>
                  )}
                  {videoError && <span className="block text-rose-300 mt-0.5">{videoError}</span>}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 md:gap-3">
                <button
                  onClick={exportAllStems}
                  disabled={decoding || !!decodeError}
                  className="no-drag glass rounded-xl px-5 py-3 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-2 disabled:opacity-40"
                >
                  <DownloadIcon className="w-4 h-4" />
                  Export everything
                </button>
                <button
                  onClick={() => window.stemkit.openExternal(youtubeUrl)}
                  className="no-drag glass rounded-xl px-5 py-3 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                >
                  Open on YouTube
                </button>
              </div>
            </aside>
          </div>

          <Transport
            playing={playing}
            duration={duration}
            getPosition={getPosition}
            onTogglePlay={togglePlay}
            onSeek={seekTo}
            preset={preset === 'custom' ? 'all' : preset}
            onPreset={applyPreset}
            master={master}
            onMaster={setMaster}
            youtubeUrl={youtubeUrl}
          />

          {chords && chords.segments.length > 0 && (
            <ChordTimeline
              chords={chords}
              duration={duration}
              getPosition={getPosition}
              onSeek={seekTo}
              onOverride={(start, label) => {
                void window.stemkit
                  .setChordLabel?.(song.videoId, start, label)
                  .then(setChords)
                  .catch((err) => setChordsError(err instanceof Error ? err.message : String(err)))
              }}
            />
          )}

          <div className="mt-4 space-y-2">
            {decoding
              ? [...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="glass rounded-xl h-16 animate-pulse"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))
              : stemMeta.map((meta) => (
              <StemLane
                key={meta.id}
                meta={meta}
                buffer={buffers[meta.id] ?? null}
                duration={duration}
                getPosition={getPosition}
                audible={!mutes.has(meta.id) && (solos.size === 0 || solos.has(meta.id))}
                volume={vols[meta.id] ?? 1}
                muted={mutes.has(meta.id)}
                soloed={solos.has(meta.id)}
                onToggleMute={() => toggleMute(meta.id)}
                onToggleSolo={() => toggleSolo(meta.id)}
                onVolume={(v) => setVols((prev) => ({ ...prev, [meta.id]: v }))}
                onSeek={seekTo}
                onExport={() => exportStem(meta.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
