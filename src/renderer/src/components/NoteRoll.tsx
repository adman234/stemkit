import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteData, NoteEvent, StemId } from '../../../shared/types'
import { DownloadIcon, ZoomResetIcon } from './Icons'
import { STEM_INFO } from '../lib/stems'
import { fmtTime } from '../lib/format'
import { useFrameSeek } from '../lib/seek'
import { ZOOM_STEPS, defaultZoom, dragSeek, timelineFrame } from '../lib/timeline'
import { isBlackKey, noteName, notesAt, notesToMidi, pitchRange, topLine } from '../lib/notes'
import { bendMark, fingerTab, stringNames, tabToText, tuningsFor, type TabNote } from '../lib/tab'
import { NOTE_MODELS, noteModelInfo, type NoteModelId } from '../../../shared/engines'

interface Props {
  // the transcription on show, null while it loads or before there is one
  data: NoteData | null
  // stems of this song that can be transcribed, and the one picked
  stems: StemId[]
  stem: StemId
  onStem: (stem: StemId) => void
  // which note model reads the stem, and switching it
  model: NoteModelId
  onModel: (model: NoteModelId) => void
  // a transcription for this stem and model is running
  busy: boolean
  // a getNotes fetch for this stem and model is in flight
  loading: boolean
  error: string | null
  onTranscribe: (stem: StemId) => void
  duration: number
  getPosition: () => number
  onSeek: (seconds: number) => void
  // the chord pass's beat grid and tempo, when there is one
  beats?: number[]
  tempo?: number | null
  title: string
  // the tuning picked is kept per song
  videoId: string
}

// the stretch of song last zoomed to, so the next song opens the same way
const WINDOW_KEY = 'stemkit.notes.window'

function loadWindow(): number {
  try {
    const saved = Number(localStorage.getItem(WINDOW_KEY))
    return saved > 0 ? saved : NOTE_WINDOW_SECONDS
  } catch {
    return NOTE_WINDOW_SECONDS
  }
}

type View = 'roll' | 'tab'
const VIEW_KEY = 'stemkit.notes.view'

function loadView(): View {
  try {
    return localStorage.getItem(VIEW_KEY) === 'roll' ? 'roll' : 'tab'
  } catch {
    return 'tab'
  }
}

function tuningKey(videoId: string, kind: string): string {
  return `stemkit.tuning.${videoId}.${kind}`
}

function loadTuning(videoId: string, kind: string): string {
  try {
    return localStorage.getItem(tuningKey(videoId, kind)) ?? 'standard'
  } catch {
    return 'standard'
  }
}

// about this much of the song on screen at first: wide enough that notes
// scroll by slowly enough to read
const NOTE_WINDOW_SECONDS = 16
const GUTTER = 34
const HEIGHT = 168
// tab is taller, so the fret numbers can be bigger
const TAB_HEIGHT = 216

function download(content: Uint8Array<ArrayBuffer> | string, name: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function safeName(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, '').trim().slice(0, 80) || 'notes'
}

export function NoteRoll(props: Props): React.ReactElement {
  const { data, stems, stem, onStem, model, onModel, busy, loading, error, onTranscribe, duration, getPosition, onSeek } =
    props
  const modelName = noteModelInfo(model).name
  const viewportRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const span = duration > 0 ? duration : data?.duration || 1
  const [zoom, setZoom] = useState(() => defaultZoom(span, loadWindow()))
  const zoomTouched = useRef(false)
  const [lead, setLead] = useState(true)
  const [view, setView] = useState<View>(loadView)
  const tunings = tuningsFor(stem)
  // guitar and the "other" stem share one choice, bass has its own
  const tuningKind = stem === 'bass' ? 'bass' : 'guitar'
  const [tuningIds, setTuningIds] = useState<Record<string, string>>(() => ({
    guitar: loadTuning(props.videoId, 'guitar'),
    bass: loadTuning(props.videoId, 'bass')
  }))
  const tuning = tunings.find((t) => t.id === tuningIds[tuningKind]) ?? tunings[0]
  const tabView = view === 'tab' && !!tuning
  const [nowText, setNowText] = useState('')
  const queueSeek = useFrameSeek(onSeek)
  const dragRef = useRef<{ x: number; at: number; active: boolean } | null>(null)

  const all = data?.notes ?? []
  const line = useMemo(() => topLine(all), [all])
  const shown = lead ? line : all
  const tab = useMemo<TabNote[]>(() => (tuning ? fingerTab(shown, tuning) : []), [shown, tuning])
  const color = STEM_INFO[stem]?.color ?? '#F472B6'
  const { low, high } = useMemo(() => {
    const r = pitchRange(all)
    // at least two octaves tall, so a narrow part does not turn into slabs
    const pad = Math.max(1, Math.ceil((24 - (r.high - r.low)) / 2))
    return { low: r.low - pad, high: r.high + pad }
  }, [all])
  // the longest note, to know how far back a note can start and still show
  const longest = useMemo(() => all.reduce((m, n) => Math.max(m, n.end - n.start), 0), [all])

  // a zoom picked by hand is remembered as seconds on screen
  useEffect(() => {
    if (!zoomTouched.current || zoom === 1) return
    try {
      localStorage.setItem(WINDOW_KEY, String(span / zoom))
    } catch {}
  }, [zoom, span])

  useEffect(() => {
    if (zoomTouched.current) return
    setZoom(defaultZoom(span, loadWindow()))
  }, [span])

  // the roll is drawn every frame straight onto a canvas: a few thousand
  // notes as DOM nodes would not keep up with the playhead
  useEffect(() => {
    let raf = 0
    let lastText = ''
    const frame = (): void => {
      raf = requestAnimationFrame(frame)
      const viewport = viewportRef.current
      const canvas = canvasRef.current
      if (!viewport || !canvas) return
      const dpr = window.devicePixelRatio || 1
      const cssW = viewport.clientWidth
      const cssH = viewport.clientHeight
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr)
        canvas.height = Math.round(cssH * dpr)
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      const position = getPosition()
      const plotW = cssW - GUTTER
      const { translateX, markerLeft } = timelineFrame(position, span, zoom, plotW)
      const xOf = (t: number): number => GUTTER + (t / span) * plotW * zoom + translateX
      const rows = high - low + 1
      const rowH = cssH / rows
      const yOf = (pitch: number): number => cssH - (pitch - low + 1) * rowH

      // key lanes: black keys a shade darker, a line under every C
      for (let p = low; p <= high && !tabView; p++) {
        if (isBlackKey(p)) {
          ctx.fillStyle = 'rgba(0,0,0,0.22)'
          ctx.fillRect(GUTTER, yOf(p), plotW, rowH)
        }
        if (p % 12 === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.08)'
          ctx.fillRect(GUTTER, yOf(p) + rowH - 1, plotW, 1)
        }
      }

      // the stretch of the song on screen
      const t0 = (-translateX / (plotW * zoom)) * span
      const t1 = t0 + span / zoom

      // the beat grid, when the chord pass found one
      if (props.beats && props.beats.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
        for (const b of props.beats) {
          if (b < t0 || b > t1) continue
          ctx.fillRect(Math.round(xOf(b)), 0, 1, cssH)
        }
      }

      const sounding = new Set<NoteEvent>()

      if (tabView && tuning) {
        const lines = tuning.strings.length
        const lineH = cssH / lines
        // high string on top
        const yString = (s: number): number => Math.round((lines - 1 - s + 0.5) * lineH)
        ctx.fillStyle = 'rgba(255,255,255,0.16)'
        for (let s = 0; s < lines; s++) ctx.fillRect(GUTTER, yString(s), plotW, 1)
        ctx.font = '700 13px ui-monospace, monospace'
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'center'
        const pillH = Math.min(20, lineH - 6)
        const playing = new Set<number>()
        for (const n of tab) {
          if (n.end < t0 || n.start > t1) continue
          if (n.start < t0 - longest) continue
          const x0 = xOf(n.start)
          const x1 = Math.max(x0 + 2, xOf(n.end))
          const y = yString(n.string)
          const on = n.start <= position && position < n.end
          if (on) {
            sounding.add(n)
            playing.add(n.string)
          }
          // how long it rings, along the string
          ctx.globalAlpha = on ? 0.9 : 0.35
          ctx.fillStyle = color
          ctx.fillRect(x0, y - 1, x1 - x0, 3)
          const label = `${n.fret}${bendMark(n)}`
          const w = Math.max(pillH, ctx.measureText(label).width + 9)
          // solid, with a dark edge so notes that crowd together stay apart
          ctx.globalAlpha = on ? 1 : 0.75 + (0.25 * n.velocity) / 127
          ctx.fillStyle = on ? '#ffffff' : color
          ctx.strokeStyle = '#0b0a10'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.roundRect(x0 - 2, y - pillH / 2, w, pillH, 5)
          ctx.stroke()
          ctx.fill()
          ctx.globalAlpha = 1
          ctx.fillStyle = '#0b0a10'
          ctx.fillText(label, x0 - 2 + w / 2, y + 0.5)
        }
        ctx.textAlign = 'left'
        ctx.globalAlpha = 1

        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.fillRect(Math.round(GUTTER + (markerLeft / 100) * plotW), 0, 1, cssH)

        // string names on the left
        ctx.fillStyle = '#121118'
        ctx.fillRect(0, 0, GUTTER, cssH)
        ctx.font = '600 11px ui-monospace, monospace'
        stringNames(tuning).forEach((name, s) => {
          ctx.fillStyle = playing.has(s) ? color : 'rgba(255,255,255,0.45)'
          ctx.fillText(name, 8, yString(s) + 0.5)
        })
      } else {
      const drawNotes = (notes: NoteEvent[], ghost: boolean): void => {
        for (const n of notes) {
          if (n.end < t0 || n.start > t1) continue
          if (n.start < t0 - longest) continue
          const x0 = xOf(n.start)
          const w = Math.max(2, xOf(n.end) - x0)
          const y = yOf(n.pitch)
          const on = !ghost && n.start <= position && position < n.end
          if (on) sounding.add(n)
          const level = 0.35 + (0.65 * n.velocity) / 127
          ctx.globalAlpha = ghost ? 0.14 : on ? 1 : level * 0.8
          ctx.fillStyle = on ? '#ffffff' : color
          const h = Math.max(2, rowH - 1)
          ctx.fillRect(x0, y + (rowH - h) / 2, w, h)
          if (n.bend && !ghost) {
            // the bend as a line through the note: a third of a semitone per step
            ctx.globalAlpha = on ? 1 : 0.9
            ctx.strokeStyle = on ? color : '#ffffff'
            ctx.lineWidth = 1.5
            ctx.beginPath()
            n.bend.forEach((b, k) => {
              const x = x0 + (w * k) / Math.max(1, n.bend!.length - 1)
              const yy = y + rowH / 2 - (b * rowH) / 3
              if (k === 0) ctx.moveTo(x, yy)
              else ctx.lineTo(x, yy)
            })
            ctx.stroke()
          }
        }
        ctx.globalAlpha = 1
      }
      if (lead) drawNotes(all, true)
      drawNotes(shown, false)

      // the playhead
      ctx.fillStyle = 'rgba(255,255,255,0.9)'
      ctx.fillRect(Math.round(GUTTER + (markerLeft / 100) * plotW), 0, 1, cssH)

      // pitch labels on the left, over a solid strip so notes slide under it
      ctx.fillStyle = '#121118'
      ctx.fillRect(0, 0, GUTTER, cssH)
      ctx.font = '600 9.5px ui-monospace, monospace'
      ctx.textBaseline = 'middle'
      for (let p = low; p <= high; p++) {
        const playing = [...sounding].some((n) => n.pitch === p)
        if (p % 12 !== 0 && !playing && !(rowH >= 11 && p % 12 === 7)) continue
        ctx.fillStyle = playing ? color : 'rgba(255,255,255,0.4)'
        ctx.fillText(noteName(p), 3, yOf(p) + rowH / 2)
      }
      }

      const text = notesAt(shown, position)
        .map((n) => noteName(n.pitch))
        .join(' ')
      if (text !== lastText) {
        lastText = text
        setNowText(text)
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [getPosition, span, zoom, all, shown, lead, low, high, longest, color, props.beats, tabView, tuning, tab])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      zoomTouched.current = true
      setZoom((z) => {
        const i = ZOOM_STEPS.indexOf(z)
        const next = e.deltaY < 0 ? i + 1 : i - 1
        return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, next))]
      })
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [data])

  const stepZoom = (direction: number): void => {
    zoomTouched.current = true
    setZoom((z) => {
      const i = ZOOM_STEPS.indexOf(z)
      return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + direction))]
    })
  }

  /* drag to scrub, as on the chord strip; a tap seeks to where it lands */
  const onPointerDown = (e: React.PointerEvent): void => {
    dragRef.current = { x: e.clientX, at: getPosition(), active: false }
  }
  const onPointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    if (e.pointerType === 'mouse' && e.buttons !== 1) return
    const dx = e.clientX - drag.x
    if (!drag.active) {
      if (Math.abs(dx) < (e.pointerType === 'mouse' ? 5 : 3)) return
      drag.active = true
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {}
    }
    const plotW = (viewportRef.current?.clientWidth || 1) - GUTTER
    queueSeek(dragSeek(drag.at, dx, span, zoom, plotW))
  }
  const onPointerUp = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.active) return
    const viewport = viewportRef.current
    if (!viewport) return
    const x = e.clientX - viewport.getBoundingClientRect().left - GUTTER
    const plotW = viewport.clientWidth - GUTTER
    if (x < 0) return
    const { translateX } = timelineFrame(getPosition(), span, zoom, plotW)
    onSeek(Math.max(0, Math.min(span, ((x - translateX) / (plotW * zoom)) * span)))
  }

  const following = zoom > 1
  const label = STEM_INFO[stem]?.label ?? stem

  return (
    <div className="glass rounded-2xl px-4 py-3 mt-4">
      <div className="flex items-baseline justify-between gap-4 mb-2 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0 flex-wrap">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-white/30">Notes</span>
          <span className="flex gap-1">
            {stems.map((s) => (
              <button
                key={s}
                onClick={() => onStem(s)}
                className={`no-drag px-2 h-6 rounded-md text-[11px] font-semibold capitalize transition-colors ${
                  s === stem ? 'bg-white text-black' : 'bg-white/[0.06] text-white/55 hover:text-white hover:bg-white/10'
                }`}
              >
                {STEM_INFO[s]?.label ?? s}
              </button>
            ))}
          </span>
          <span className="flex rounded-md bg-white/[0.06] p-0.5" title="Which model reads the notes out">
            {NOTE_MODELS.map((m) => (
              <button
                key={m.id}
                onClick={() => onModel(m.id)}
                title={m.blurb}
                className={`no-drag px-2 h-5 rounded text-[11px] font-semibold transition-colors ${
                  m.id === model ? 'bg-white text-black' : 'text-white/55 hover:text-white'
                }`}
              >
                {m.name}
              </button>
            ))}
          </span>
          {data && tunings.length > 0 && (
            <span className="flex rounded-md bg-white/[0.06] p-0.5">
              {(['tab', 'roll'] as const).map((v) => (
                <button
                  key={v}
                  onClick={() => {
                    setView(v)
                    try {
                      localStorage.setItem(VIEW_KEY, v)
                    } catch {}
                  }}
                  className={`no-drag px-2 h-5 rounded text-[11px] font-semibold transition-colors ${
                    (v === 'tab') === tabView ? 'bg-white text-black' : 'text-white/55 hover:text-white'
                  }`}
                >
                  {v === 'tab' ? 'Tab' : 'Roll'}
                </button>
              ))}
            </span>
          )}
          {data && tabView && (
            <select
              value={tuning.id}
              onChange={(e) => {
                const id = e.target.value
                setTuningIds((prev) => ({ ...prev, [tuningKind]: id }))
                try {
                  localStorage.setItem(tuningKey(props.videoId, tuningKind), id)
                } catch {}
              }}
              title="The tuning the part is played in: frets are worked out for it"
              className="no-drag h-6 rounded-md bg-white/[0.06] text-white/70 text-[11px] font-semibold px-1.5 border-0 outline-none"
            >
              {tunings.map((t) => (
                <option key={t.id} value={t.id} className="bg-[#18161f]">
                  {t.name}
                </option>
              ))}
            </select>
          )}
          {data && (
            <button
              onClick={() => setLead((v) => !v)}
              title="Keep only the highest note at each moment: on a guitar stem with rhythm and lead together, that is mostly the lead"
              className={`no-drag px-2 h-6 rounded-md text-[11px] font-semibold transition-colors ${
                lead ? 'bg-violet-400/90 text-black' : 'bg-white/[0.06] text-white/55 hover:text-white hover:bg-white/10'
              }`}
            >
              {lead ? 'Top line' : 'All notes'}
            </button>
          )}
        </div>
        {data && (
          <div className="flex items-center gap-2 md:gap-3 shrink-0 text-[11px] text-white/35 font-mono flex-wrap">
            <span>{shown.length} notes</span>
            <span className="min-w-16 text-center text-[13px] font-sans font-semibold text-white tabular-nums">
              {nowText}
            </span>
            <span className="flex items-center gap-1 ml-1">
              <button
                onClick={() => stepZoom(-1)}
                disabled={zoom === ZOOM_STEPS[0]}
                title="Zoom out"
                className="no-drag w-6 h-6 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white disabled:opacity-30 transition-colors"
              >
                −
              </button>
              <span className="w-14 text-center tabular-nums" title="How much of the song is on screen">
                {following ? fmtTime(span / zoom) : 'whole song'}
              </span>
              <button
                onClick={() => stepZoom(1)}
                disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
                title="Zoom in (or scroll on the roll)"
                className="no-drag w-6 h-6 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white disabled:opacity-30 transition-colors"
              >
                +
              </button>
              <button
                onClick={() => {
                  zoomTouched.current = true
                  setZoom(1)
                }}
                disabled={!following}
                title="Fit the whole song"
                className="no-drag flex items-center justify-center w-6 h-6 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white disabled:opacity-30 transition-colors"
              >
                <ZoomResetIcon className="w-3.5 h-3.5" />
              </button>
              {tabView && (
                <button
                  onClick={() =>
                    download(
                      tabToText(tab, tuning, {
                        beats: props.beats,
                        tempo: props.tempo,
                        title: `${props.title} - ${label}${lead ? ' (top line)' : ''}`,
                        source: `Transcribed by StemKit with ${data.model}`
                      }),
                      `${safeName(props.title)} - ${label}${lead ? ' top line' : ''} tab.txt`,
                      'text/plain;charset=utf-8'
                    )
                  }
                  title="Download the tab as a text file, in bars on the song's beat"
                  className="no-drag flex items-center gap-1 h-6 px-2 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white font-sans font-semibold transition-colors"
                >
                  <DownloadIcon className="w-3.5 h-3.5" />
                  Tab
                </button>
              )}
              <button
                onClick={() =>
                  download(
                    notesToMidi(shown, { tempo: props.tempo, stem, name: `${props.title} (${label})` }),
                    `${safeName(props.title)} - ${label}${lead ? ' top line' : ''}.mid`,
                    'audio/midi'
                  )
                }
                title={lead ? 'Download the top line as a MIDI file' : 'Download every note as a MIDI file'}
                className="no-drag flex items-center gap-1 h-6 px-2 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white font-sans font-semibold transition-colors"
              >
                <DownloadIcon className="w-3.5 h-3.5" />
                MIDI
              </button>
            </span>
          </div>
        )}
      </div>

      {data ? (
        <div
          ref={viewportRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => (dragRef.current = null)}
          style={{ touchAction: 'none', height: tabView ? TAB_HEIGHT : HEIGHT }}
          className="relative rounded-lg overflow-hidden bg-white/[0.03] cursor-grab active:cursor-grabbing"
        >
          <canvas ref={canvasRef} className="absolute inset-0 w-full h-full" />
        </div>
      ) : (
        <div className="rounded-lg bg-white/[0.03] px-3 py-4 text-[12px] leading-snug">
          {busy ? (
            <span className="text-white/45">Transcribing the {label} with {modelName}…</span>
          ) : loading ? (
            <span className="text-white/45">Loading the notes…</span>
          ) : (
            <button
              onClick={() => onTranscribe(stem)}
              className="no-drag text-violet-300 hover:text-violet-200 transition-colors"
            >
              Transcribe the {label} with {modelName} →
            </button>
          )}
        </div>
      )}
      {error && <p className="text-[11.5px] text-rose-300 mt-1.5">{error}</p>}
      {data && (
        <p className="text-[10.5px] text-white/30 mt-1.5">
          {data.model}, from the {label} stem. Separation leftovers and overtones can show up as extra notes.
          {tabView && ' Frets are a best guess at where a player would play each note.'}
        </p>
      )}
    </div>
  )
}
