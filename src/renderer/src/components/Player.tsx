import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, ChordData, LyricsData, NoteData, Song, StemId } from '../../../shared/types'
import { DEFAULT_STEMS } from '../../../shared/types'
import { decodeStem, engine, decodePayload, type BufferMap } from '../lib/engine'
import { buildStemMeta } from '../lib/stems'
import { fmtTime } from '../lib/format'
import { SongThumb } from '../lib/thumbs'
import { YouTubeHost, type YTState } from '../lib/youtube'
import { LocalVideoHost, type VideoHost } from '../lib/video'
import { StemLane } from './StemLane'
import { ChordTimeline } from './ChordTimeline'
import { NoteRoll } from './NoteRoll'
import { LyricsPanel } from './LyricsPanel'
import { StageView } from './StageView'
import { Transport, type PresetId } from './Transport'
import { useWakeLock } from '../lib/wakeLock'
import { useMediaQuery } from '../lib/media'
import { isAudible, toggleAudible as flipAudible } from '../lib/mix'
import { DownloadIcon, GuitarIcon, MicIcon } from './Icons'
import { tuningsFor } from '../lib/tab'
import {
  DEFAULT_NOTE_MODEL,
  DRUM_KIT,
  NOTE_MODELS,
  TRANSCRIBABLE,
  splitLabel,
  type NoteModelId
} from '../../../shared/engines'

type BufferCacheMap = BufferMap

// the buttons under the song's details
const ACTION =
  'no-drag glass rounded-xl px-4 py-2.5 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-2'

// which note model the roll shows and transcribes with, kept across songs
const NOTE_MODEL_KEY = 'stemkit.notes.model'
function loadNoteModel(): NoteModelId {
  try {
    const v = localStorage.getItem(NOTE_MODEL_KEY)
    return NOTE_MODELS.some((m) => m.id === v) ? (v as NoteModelId) : DEFAULT_NOTE_MODEL
  } catch {
    return DEFAULT_NOTE_MODEL
  }
}

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
  /* What a browser says it can decode and what it manages are not always the
     same thing, so each format is tried in turn and the first one that
     actually produces audio wins. The last of them is the WAV, which the app
     decodes itself and so cannot be refused. */
  const formats = window.stemkit.stemFormats?.() ?? ['wav']
  const out: BufferCacheMap = {}
  const failed: string[] = []
  let bytes = 0
  let used = ''
  const started = performance.now()
  for (let i = 0; i < stems.length; i++) {
    // the first stem can wait on the server making its playback copy, which
    // happens once per song: say so rather than looking stuck
    const slow = setTimeout(() => {
      onProgress(i, stems.length, 'the server is preparing this song for playback')
    }, 3000)
    const tried: string[] = []
    try {
      for (const format of formats) {
        let loadedStem
        // decoding detaches the bytes, so their size is counted first
        let size = 0
        try {
          loadedStem = await fetchStem(song.videoId, stems[i], format)
          size = loadedStem.bytes.byteLength
          out[stems[i] as StemId] = await decodeStem(loadedStem.bytes.buffer as ArrayBuffer)
        } catch (err) {
          const why = err instanceof Error ? err.message : String(err)
          tried.push(`${format}: ${why}`)
          if (loadedStem) console.warn(`[stemkit] ${stems[i]} would not decode as ${format} (${why})`)
          continue
        }
        bytes += size
        used = format
        break
      }
    } finally {
      clearTimeout(slow)
    }
    // a stem no format could play is worth naming; the rest still play
    if (!out[stems[i] as StemId]) failed.push(`${stems[i]} (${tried.join(', ')})`)
    const seconds = (performance.now() - started) / 1000
    const summary = `${(bytes / 1048576).toFixed(0)} MB in ${seconds.toFixed(0)}s · ${used || 'nothing'}${
      used === 'wav' ? ' · full quality audio, which is slower to load' : ''
    }`
    onProgress(i + 1, stems.length, failed.length ? `${summary} · ${failed.length} failed` : summary)
  }
  if (failed.length && !Object.keys(out).length) throw new Error(failed.join(' · '))
  if (failed.length) onProgress(stems.length, stems.length, `could not play ${failed.join(' · ')}`)
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
  // the stem shown in the note roll, which model reads it, and the result
  const [noteStem, setNoteStem] = useState<StemId | null>(null)
  const [noteModel, setNoteModel] = useState<NoteModelId>(loadNoteModel)
  const [notes, setNotes] = useState<NoteData | null>(null)
  // busy and reload are keyed by `${stem}:${model}`
  const [notesBusy, setNotesBusy] = useState<Set<string>>(new Set())
  const [notesLoading, setNotesLoading] = useState(false)
  const [notesReload, setNotesReload] = useState(0)
  const [notesError, setNotesError] = useState<string | null>(null)

  // lyrics found online and timed to the singing
  const [lyrics, setLyrics] = useState<LyricsData | null>(null)
  const [lyricsBusy, setLyricsBusy] = useState(false)
  const [lyricsError, setLyricsError] = useState<string | null>(null)
  const [lyricsNotFound, setLyricsNotFound] = useState(false)
  const [lyricsForm, setLyricsForm] = useState<{ artist: string; track: string } | null>(null)

  const [vols, setVols] = useState<Partial<Record<StemId, number>>>({})
  const [mutes, setMutes] = useState<Set<StemId>>(new Set())
  const [solos, setSolos] = useState<Set<StemId>>(new Set())
  const [master, setMaster] = useState(0.9)
  const [preset, setPreset] = useState<PresetId | 'custom'>('all')

  const stemMeta = useMemo(() => buildStemMeta(Object.keys(buffers) as StemId[]), [buffers])

  // a phone dims and locks mid song unless told to stay awake
  useWakeLock(playing)

  // a touch device held sideways gets the stage view; "Full view" turns it off
  // until the phone is turned upright and sideways again
  const landscapePhone = useMediaQuery('(orientation: landscape) and (max-height: 500px) and (pointer: coarse)')
  const [stageOff, setStageOff] = useState(false)
  useEffect(() => {
    if (!landscapePhone) setStageOff(false)
  }, [landscapePhone])
  const stage = landscapePhone && !stageOff

  // local files have no video: the cover slot shows a placeholder instead
  const isLocal = song.source === 'local'
  const youtubeUrl = isLocal ? null : `https://www.youtube.com/watch?v=${song.videoId}`
  // split with Thumbnail picked and no video fetched since: the cover image
  // stands in, rather than streaming the video from YouTube
  const thumbnailOnly = isLocal || (song.options?.picture === 'thumbnail' && !song.video)
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
    if (thumbnailOnly) {
      hostRef.current?.destroy()
      hostRef.current = null
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
  }, [song.videoId, song.video, decoding, decodeError, thumbnailOnly])

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

  /* Stems that can be turned into notes, the likeliest home of a guitar
     part first: the guitar stem, or "other" on a four stem split */
  const noteStems = useMemo(
    () =>
      (['guitar', 'other', 'piano', 'bass', 'vocals'] as StemId[]).filter(
        (s) => TRANSCRIBABLE.includes(s) && (song.stems ?? DEFAULT_STEMS).includes(s)
      ),
    [song.stems]
  )
  const notesDone = song.notes ?? []
  const shownNoteStem = noteStem ?? noteStems.find((s) => notesDone.includes(s)) ?? null
  // nothing transcribed yet: the first stem worth it gets a button by the exports
  const offerTranscribe = notesDone.length === 0 && !shownNoteStem && noteStems.length > 0 && !!window.stemkit.transcribe

  useEffect(() => {
    setNoteStem(null)
    setNotesBusy(new Set())
    setNotesError(null)
  }, [song.videoId])

  useEffect(() => {
    setNotes(null)
    if (!shownNoteStem || !window.stemkit.getNotes) return
    let alive = true
    setNotesLoading(true)
    void window.stemkit.getNotes(song.videoId, shownNoteStem, noteModel).then((data) => {
      if (!alive) return
      setNotes(data)
      setNotesLoading(false)
    })
    return () => {
      alive = false
    }
  }, [song.videoId, shownNoteStem, noteModel, notesReload])

  useEffect(() => {
    if (!window.stemkit.onNotesEvent) return
    return window.stemkit.onNotesEvent((ev) => {
      if (ev.videoId !== song.videoId) return
      const key = `${ev.stem}:${ev.model ?? DEFAULT_NOTE_MODEL}`
      setNotesBusy((prev) => {
        const next = new Set(prev)
        if (ev.running) next.add(key)
        else next.delete(key)
        return next
      })
      if (ev.error) setNotesError(ev.error)
      else if (ev.running) setNotesError(null)
      // reload the roll when the model it is showing finishes
      else if (ev.ready && ev.stem === shownNoteStem && (ev.model ?? DEFAULT_NOTE_MODEL) === noteModel) {
        setNotesReload((n) => n + 1)
      }
    })
  }, [song.videoId, shownNoteStem, noteModel])

  const startTranscribe = (stem: StemId, model: NoteModelId = noteModel): void => {
    setNoteStem(stem)
    setNoteModel(model)
    setNotesError(null)
    setNotesBusy((prev) => new Set(prev).add(`${stem}:${model}`))
    void window.stemkit.transcribe?.(song.videoId, stem, model)
  }

  const chooseNoteModel = (model: NoteModelId): void => {
    setNoteModel(model)
    try {
      localStorage.setItem(NOTE_MODEL_KEY, model)
    } catch {}
  }

  // lyrics only make sense with a vocals stem to sing over
  const canLyrics = (song.stems ?? DEFAULT_STEMS).includes('vocals') && !!window.stemkit.getLyrics

  useEffect(() => {
    setLyrics(null)
    setLyricsNotFound(false)
    setLyricsError(null)
    setLyricsForm(null)
    if (!song.lyrics || !window.stemkit.getLyrics) return
    let alive = true
    void window.stemkit.getLyrics(song.videoId).then((data) => {
      if (alive) setLyrics(data)
    })
    return () => {
      alive = false
    }
  }, [song.videoId, song.lyrics])

  useEffect(() => {
    if (!window.stemkit.onLyricsEvent) return
    return window.stemkit.onLyricsEvent((ev) => {
      if (ev.videoId !== song.videoId) return
      if (ev.error) {
        setLyricsBusy(false)
        setLyricsError(ev.error)
      } else if (ev.notFound) {
        setLyricsBusy(false)
        setLyricsNotFound(true)
      } else if (ev.ready) {
        setLyricsBusy(false)
        setLyricsError(null)
        setLyricsNotFound(false)
        void window.stemkit.getLyrics?.(song.videoId).then(setLyrics)
      } else if (ev.running) {
        setLyricsBusy(true)
        setLyricsError(null)
        setLyricsNotFound(false)
      }
    })
  }, [song.videoId])

  const findLyrics = (hint?: { artist?: string; track?: string }): void => {
    setLyricsBusy(true)
    setLyricsError(null)
    setLyricsNotFound(false)
    void window.stemkit.findLyrics?.(song.videoId, hint)
  }

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
  }, [decoding, decodeError])

  /* A phone that switches to another app should stop, not carry on playing
     into whatever comes next. A desktop tab in the background is a different
     thing: people leave music running there on purpose. */
  useEffect(() => {
    if (settings?.pauseWhenHidden === false) return
    if (!window.matchMedia('(pointer: coarse)').matches) return
    const onHidden = (): void => {
      if (document.visibilityState !== 'hidden' || !playingRef.current) return
      playingRef.current = false
      engine.setPlaying(false, posRef.current)
      hostRef.current?.pause()
      setPlaying(false)
    }
    document.addEventListener('visibilitychange', onHidden)
    return () => document.removeEventListener('visibilitychange', onHidden)
  }, [settings?.pauseWhenHidden])

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

  // the stage view's chips: flip what is heard, whatever set the solos
  const toggleAudible = (id: StemId): void => {
    setPreset('custom')
    const next = flipAudible(
      stemMeta.map((s) => s.id),
      mutes,
      solos,
      id
    )
    setMutes(next.mutes)
    setSolos(next.solos)
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
    <>
    {stage && (
      <StageView
        title={song.title}
        playing={playing}
        duration={duration}
        getPosition={getPosition}
        onTogglePlay={togglePlay}
        onSeek={seekTo}
        chords={chords}
        lyrics={lyrics}
        lyricsBusy={lyricsBusy}
        canLyrics={canLyrics}
        onFindLyrics={() => findLyrics()}
        stems={stemMeta}
        audible={(id) => isAudible(id, mutes, solos)}
        onToggleStem={toggleAudible}
        onExit={() => setStageOff(true)}
      />
    )}
    {/* kept mounted behind the stage view: the video host lives in it */}
    <div className={`h-full flex flex-col ${stage ? 'hidden' : ''}`}>
      <header className="drag-region h-12 md:h-14 shrink-0 flex items-center justify-between gap-3 px-4 md:px-6">
        <h2 className="text-sm font-semibold truncate">{song.title}</h2>
        {landscapePhone && stageOff && (
          <button
            onClick={() => setStageOff(false)}
            className="no-drag shrink-0 text-[12px] font-semibold text-violet-300 hover:text-violet-200 transition-colors"
          >
            Stage view
          </button>
        )}
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto px-3 md:px-6 pb-4 md:pb-6">
        <div className="w-full">
          <div className="flex flex-col md:flex-row md:items-start gap-3 md:gap-4">
            <div className="relative w-full md:w-auto md:h-[220px] 2xl:h-[300px] aspect-video shrink-0">
              <div className="absolute -inset-4 bg-violet-500/10 blur-3xl rounded-full pointer-events-none" />
              <div className="absolute inset-0 rounded-xl overflow-hidden ring-1 ring-white/10 bg-black shadow-2xl shadow-black/60">
                <div ref={containerRef} className="absolute inset-0 [&_iframe]:w-full [&_iframe]:h-full" />
                {thumbnailOnly && (
                  <SongThumb
                    videoId={song.videoId}
                    className="absolute inset-0 w-full h-full object-cover"
                    iconClassName="w-10 h-10 text-white/25"
                  />
                )}
                {!ytReady && !thumbnailOnly && (
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

            <aside className="flex-1 min-w-0 self-stretch md:min-h-[220px] 2xl:min-h-[300px] glass rounded-2xl px-4 md:px-6 py-4 md:py-5 rise-in flex flex-col justify-between gap-3">
              <div className="flex items-center gap-4">
                <SongThumb
                  videoId={song.videoId}
                  className="hidden sm:flex w-24 lg:w-32 h-[54px] lg:h-[72px] rounded-lg object-cover bg-white/5 shrink-0"
                  iconClassName="w-7 h-7 text-white/25"
                />
                <div className="min-w-0 flex-1">
                  <h3 className="text-base md:text-xl font-semibold leading-snug truncate">{song.title}</h3>
                  <p className="text-xs text-white/45 mt-1.5 font-mono truncate">
                    {fmtTime(song.duration)} · added {addedLabel}
                    {song.took ? ` · split in ${fmtTime(song.took)}` : ''}
                    {song.options ? ` · ${splitLabel(song.options)}` : ''}
                    {chords ? ` · ${chords.key.name}` : ''}
                  </p>
                  {loaded?.note && <p className="text-[11px] text-white/45 mt-1">{loaded.note}</p>}
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

              <div className="flex flex-wrap items-center gap-2">
                {!song.chords && window.stemkit.detectChords && (
                  <button
                    onClick={() => {
                      setChordsError(null)
                      setChordsBusy(true)
                      void window.stemkit.detectChords?.(song.videoId)
                    }}
                    disabled={chordsBusy}
                    className={`${ACTION} disabled:opacity-60`}
                  >
                    {chordsBusy ? 'Working out the chords…' : 'Detect key and chords'}
                  </button>
                )}
                {offerTranscribe && (
                  <button
                    onClick={() => startTranscribe(noteStems[0])}
                    disabled={notesBusy.has(`${noteStems[0]}:${noteModel}`)}
                    className={`${ACTION} disabled:opacity-60`}
                  >
                    <GuitarIcon className="w-4 h-4" />
                    {notesBusy.has(`${noteStems[0]}:${noteModel}`)
                      ? `Transcribing the ${noteStems[0]}…`
                      : tuningsFor(noteStems[0]).length
                        ? `Transcribe ${noteStems[0] === 'other' ? 'the other stem' : `the ${noteStems[0]}`} to tab`
                        : `Transcribe the ${noteStems[0]} to notes`}
                  </button>
                )}
                {!song.video && window.stemkit.fetchVideo && (
                  <button
                    onClick={() => {
                      setVideoError(null)
                      setVideoPct(0)
                      void window.stemkit.fetchVideo?.(song.videoId)
                    }}
                    disabled={videoPct !== null}
                    title={thumbnailOnly ? 'Download the video to play beside the stems' : 'Download the video for smooth sync'}
                    className={`${ACTION} disabled:opacity-60`}
                  >
                    <DownloadIcon className="w-4 h-4" />
                    {videoPct !== null ? (
                      <span className="font-mono">Downloading video… {videoPct}%</span>
                    ) : (
                      'Download video'
                    )}
                  </button>
                )}
                {canLyrics && !lyrics && (
                  <button
                    onClick={() => findLyrics()}
                    disabled={lyricsBusy}
                    title="Find the lyrics online and time them to the singing"
                    className={`${ACTION} disabled:opacity-60`}
                  >
                    <MicIcon className="w-4 h-4" />
                    {lyricsBusy ? 'Finding lyrics…' : 'Find lyrics'}
                  </button>
                )}
                <button
                  onClick={exportAllStems}
                  disabled={decoding || !!decodeError}
                  className={`${ACTION} disabled:opacity-40`}
                >
                  <DownloadIcon className="w-4 h-4" />
                  Export everything
                </button>
                {youtubeUrl && (
                  <button onClick={() => window.stemkit.openExternal(youtubeUrl)} className={ACTION}>
                    Open on YouTube
                  </button>
                )}
              </div>
              {!song.video && videoStuck && videoPct === null && (
                <p className="text-[11.5px] text-white/45 leading-snug">
                  The YouTube player keeps falling behind. Download the video for smooth sync.
                </p>
              )}
              {!song.chords && chordsError && <p className="text-[11.5px] text-rose-300">{chordsError}</p>}
              {offerTranscribe && notesError && <p className="text-[11.5px] text-rose-300">{notesError}</p>}
              {!song.video && videoError && <p className="text-[11.5px] text-rose-300">{videoError}</p>}
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
            youtubeUrl={youtubeUrl ?? undefined}
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

          {shownNoteStem && window.stemkit.getNotes && (
            <NoteRoll
              data={notes && notes.stem === shownNoteStem ? notes : null}
              stems={noteStems}
              stem={shownNoteStem}
              onStem={setNoteStem}
              model={noteModel}
              onModel={chooseNoteModel}
              busy={notesBusy.has(`${shownNoteStem}:${noteModel}`)}
              loading={notesLoading}
              error={notesError}
              onTranscribe={(s) => startTranscribe(s)}
              duration={duration}
              getPosition={getPosition}
              onSeek={seekTo}
              beats={chords?.beats}
              tempo={chords?.tempo}
              title={song.title}
              videoId={song.videoId}
            />
          )}

          {canLyrics && (lyrics || lyricsBusy || lyricsNotFound || lyricsError || lyricsForm) && (
            <div className="glass rounded-2xl px-4 py-3 mt-4">
              <div className="flex items-baseline justify-between gap-4 mb-2 flex-wrap">
                <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
                  <span className="text-[11px] font-semibold uppercase tracking-widest text-white/30">Lyrics</span>
                  {lyrics && (lyrics.artist || lyrics.track) && (
                    <span className="text-[11px] text-white/40 truncate">
                      {[lyrics.artist, lyrics.track].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
                {lyrics && !lyricsForm && (
                  <button
                    onClick={() => setLyricsForm({ artist: song.artist ?? '', track: song.track ?? song.title })}
                    className="no-drag text-[11px] font-semibold text-white/45 hover:text-white transition-colors"
                  >
                    Wrong song? Search again
                  </button>
                )}
              </div>

              {lyricsForm ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    findLyrics({ artist: lyricsForm.artist.trim(), track: lyricsForm.track.trim() })
                    setLyricsForm(null)
                  }}
                  className="flex flex-wrap items-end gap-2 py-1"
                >
                  <label className="flex flex-col gap-1 text-[10.5px] text-white/40">
                    Artist
                    <input
                      value={lyricsForm.artist}
                      onChange={(e) => setLyricsForm((f) => ({ ...f!, artist: e.target.value }))}
                      className="no-drag h-8 w-44 rounded-md bg-white/[0.06] px-2 text-[13px] text-white outline-none border border-white/10 focus:border-white/30"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[10.5px] text-white/40">
                    Title
                    <input
                      value={lyricsForm.track}
                      onChange={(e) => setLyricsForm((f) => ({ ...f!, track: e.target.value }))}
                      className="no-drag h-8 w-56 rounded-md bg-white/[0.06] px-2 text-[13px] text-white outline-none border border-white/10 focus:border-white/30"
                    />
                  </label>
                  <button
                    type="submit"
                    disabled={!lyricsForm.track.trim()}
                    className="no-drag h-8 px-3 rounded-md bg-white text-black text-[12px] font-semibold disabled:opacity-40"
                  >
                    Search
                  </button>
                  <button
                    type="button"
                    onClick={() => setLyricsForm(null)}
                    className="no-drag h-8 px-3 rounded-md bg-white/[0.06] text-white/60 hover:text-white text-[12px] font-semibold"
                  >
                    Cancel
                  </button>
                </form>
              ) : lyrics ? (
                lyrics.lines.length ? (
                  <LyricsPanel data={lyrics} getPosition={getPosition} onSeek={seekTo} />
                ) : (
                  <p className="text-[12px] text-white/45 px-1 py-3">These lyrics came through empty.</p>
                )
              ) : (
                <p className="text-[12px] text-white/45 px-1 py-3">
                  {lyricsBusy
                    ? 'Finding the lyrics and timing them to the singing…'
                    : lyricsNotFound
                      ? 'No lyrics found for this song. Try searching with the right artist and title.'
                      : (lyricsError ?? '')}
                </p>
              )}

              {lyrics && !lyricsForm && (
                <p className="text-[10.5px] text-white/30 mt-1.5">
                  From LRCLIB.{' '}
                  {lyrics.aligned
                    ? 'Words timed to the vocals stem; a mumbled or non-English line keeps its own rough timing.'
                    : lyrics.synced
                      ? 'Line times from LRCLIB; the words were not timed to the vocals.'
                      : 'No line times were available, so the words are shown untimed.'}
                </p>
              )}
              {lyricsNotFound && !lyricsForm && (
                <button
                  onClick={() => setLyricsForm({ artist: song.artist ?? '', track: song.track ?? song.title })}
                  className="no-drag text-[11.5px] font-semibold text-violet-300 hover:text-violet-200"
                >
                  Search by artist and title →
                </button>
              )}
              {lyricsError && !lyricsForm && <p className="text-[11.5px] text-rose-300 mt-1">{lyricsError}</p>}
            </div>
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
                audible={isAudible(meta.id, mutes, solos)}
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
    </>
  )
}
