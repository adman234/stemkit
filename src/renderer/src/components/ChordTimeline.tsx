import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChordData, ChordSegment } from '../../../shared/types'
import { shapesFor } from '../lib/guitar'
import { ChordDiagram } from './ChordDiagram'
import { ZoomResetIcon } from './Icons'
import { fmtTime } from '../lib/format'
import {
  ROOTS,
  ZOOM_STEPS,
  chordText,
  defaultZoom,
  dragSeek,
  hueOf,
  pickerState,
  timelineFrame
} from '../lib/timeline'

interface Props {
  chords: ChordData
  duration: number
  getPosition: () => number
  onSeek: (seconds: number) => void
  // null puts the detected chord back
  onOverride?: (start: number, label: string | null) => void
}

const QUALITIES: { id: string; label: string }[] = [
  { id: 'maj', label: 'maj' },
  { id: 'min', label: 'min' },
  { id: '7', label: '7' },
  { id: 'maj7', label: 'maj7' },
  { id: 'min7', label: 'min7' },
  { id: 'sus4', label: 'sus4' },
  { id: 'dim', label: 'dim' },
  { id: 'aug', label: 'aug' }
]

function shown(seg: ChordSegment): string {
  return seg.user ?? seg.label
}

export function ChordTimeline({ chords, duration, getPosition, onSeek, onOverride }: Props): React.ReactElement {
  const rootRef = useRef<HTMLDivElement>(null)
  const viewportRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const markerRef = useRef<HTMLSpanElement>(null)
  const [zoom, setZoom] = useState(() => defaultZoom(duration > 0 ? duration : chords.duration || 0))
  // a zoom the listener chose is theirs to keep, even when the song's length
  // turns up late and moves the default
  const zoomTouched = useRef(false)
  const [currentIndex, setCurrentIndex] = useState(-1)
  const [editing, setEditing] = useState<number | null>(null)
  const [hover, setHover] = useState<{ label: string; x: number; y: number } | null>(null)
  // a drag in progress: where it started, and the position it started from
  const dragRef = useRef<{ x: number; at: number; active: boolean } | null>(null)
  const draggedRef = useRef(false)
  const seekRef = useRef<{ to: number | null; raf: number }>({ to: null, raf: 0 })
  // whether the chord being edited has been reached, so the picker is not
  // closed by the seek that opened it
  const reachedRef = useRef(false)

  const span = duration > 0 ? duration : chords.duration || 1
  const segments = chords.segments
  const following = zoom > 1

  // the playhead and the scroll position are written straight to the DOM:
  // re-rendering a few hundred chord blocks every frame would not keep up
  useEffect(() => {
    let raf = 0
    const frame = (): void => {
      const viewport = viewportRef.current
      const track = trackRef.current
      const marker = markerRef.current
      if (viewport && track && marker) {
        const position = getPosition()
        const { translateX, markerLeft } = timelineFrame(position, span, zoom, viewport.clientWidth)
        track.style.transform = `translateX(${translateX}px)`
        marker.style.left = `${markerLeft}%`
        const index = segments.findIndex((s) => position >= s.start && position < s.end)
        setCurrentIndex((prev) => (prev === index ? prev : index))
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [getPosition, span, zoom, segments])

  /* editing one chord should not outlast the moment: clicking anywhere
     outside the timeline, or pressing escape, puts the picker away */
  useEffect(() => {
    if (editing === null) return
    const onPointer = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setEditing(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setEditing(null)
    }
    document.addEventListener('mousedown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [editing])

  useEffect(() => {
    reachedRef.current = false
  }, [editing])

  // the picker goes when the music moves off the chord it was opened on
  useEffect(() => {
    if (editing === null) return
    const next = pickerState(editing, currentIndex, reachedRef.current)
    reachedRef.current = next.reached
    if (!next.open) setEditing(null)
  }, [currentIndex, editing])

  useEffect(() => {
    if (zoomTouched.current) return
    setZoom(defaultZoom(span))
  }, [span])

  // wheel zoom needs a non-passive listener to stop the page scrolling
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      setEditing(null)
      zoomTouched.current = true
      setZoom((z) => {
        const i = ZOOM_STEPS.indexOf(z)
        const next = e.deltaY < 0 ? i + 1 : i - 1
        return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, next))]
      })
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [])

  /* pointermove can fire several times a frame, and every seek restarts the
     stems, so the last position of each frame is the one that counts */
  const queueSeek = (to: number): void => {
    seekRef.current.to = to
    if (seekRef.current.raf) return
    seekRef.current.raf = requestAnimationFrame(() => {
      seekRef.current.raf = 0
      if (seekRef.current.to !== null) onSeek(seekRef.current.to)
      seekRef.current.to = null
    })
  }

  useEffect(() => () => cancelAnimationFrame(seekRef.current.raf), [])

  /* Dragging the strip pulls the music past the playhead, the way you would
     push a tape along: it is the only way to scrub on a phone, where there
     is no scroll wheel to zoom with and no room for a second scrub bar.
     A tap is left alone so it still opens the picker. */
  const onPointerDown = (e: React.PointerEvent): void => {
    // a fresh touch is a tap until it travels, whatever the last one did
    draggedRef.current = false
    dragRef.current = { x: e.clientX, at: getPosition(), active: false }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const drag = dragRef.current
    if (!drag) return
    // a touch reports no buttons on some engines; a mouse must be held
    if (e.pointerType === 'mouse' && e.buttons !== 1) return
    const dx = e.clientX - drag.x
    if (!drag.active) {
      if (Math.abs(dx) < (e.pointerType === 'mouse' ? 5 : 3)) return
      drag.active = true
      draggedRef.current = true
      setEditing(null)
      setHover(null)
      // from here it is a drag, not a tap, so follow the pointer even when it
      // leaves the strip. A pointer that has already been released throws
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {}
    }
    queueSeek(dragSeek(drag.at, dx, span, zoom, viewportRef.current?.clientWidth || 1))
  }

  const endDrag = (): void => {
    dragRef.current = null
  }

  const stepZoom = (direction: number): void => {
    setEditing(null)
    zoomTouched.current = true
    setZoom((z) => {
      const i = ZOOM_STEPS.indexOf(z)
      return ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, i + direction))]
    })
  }

  const { key } = chords
  const unsure = key.confidence < 0.3
  const current = currentIndex >= 0 ? segments[currentIndex] : undefined
  const editingSegment = editing !== null ? segments[editing] : undefined
  const windowSeconds = span / zoom

  const setChord = (label: string | null): void => {
    if (editingSegment && onOverride) onOverride(editingSegment.start, label)
  }

  return (
    <div ref={rootRef} className="glass rounded-2xl px-4 py-3 mt-4">
      <div className="flex items-baseline justify-between gap-4 mb-2 flex-wrap">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-white/30">Key</span>
          <span className="text-[14px] font-semibold">{key.name}</span>
          <span className="text-[11px] text-white/35 truncate" title={`Alternative reading: ${key.alternative}`}>
            {unsure ? `unsure, could be ${key.alternative}` : `or its relative, ${key.relative}`}
          </span>
        </div>
        <div className="flex items-center gap-2 md:gap-3 shrink-0 text-[11px] text-white/35 font-mono flex-wrap">
          {chords.tempo ? <span>{Math.round(chords.tempo)} BPM</span> : null}
          <span>{segments.filter((s) => shown(s) !== 'N').length} chords</span>
          <span className="w-16 text-center text-[13px] font-sans font-semibold text-white tabular-nums">
            {current && shown(current) !== 'N' ? chordText(shown(current)) : ''}
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
              {following ? fmtTime(windowSeconds) : 'whole song'}
            </span>
            <button
              onClick={() => stepZoom(1)}
              disabled={zoom === ZOOM_STEPS[ZOOM_STEPS.length - 1]}
              title="Zoom in (or scroll on the timeline)"
              className="no-drag w-6 h-6 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white disabled:opacity-30 transition-colors"
            >
              +
            </button>
            <button
              onClick={() => {
                setEditing(null)
                zoomTouched.current = true
                setZoom(1)
              }}
              disabled={!following}
              title="Fit the whole song"
              className="no-drag flex items-center justify-center w-6 h-6 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white disabled:opacity-30 transition-colors"
            >
              <ZoomResetIcon className="w-3.5 h-3.5" />
            </button>
          </span>
        </div>
      </div>

      <div
        ref={viewportRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        /* the strip owns the gesture: sharing it with the page meant a drag
           that started a few degrees off horizontal scrolled the page away
           instead of scrubbing */
        style={{ touchAction: 'none' }}
        className="relative h-11 rounded-lg overflow-hidden bg-white/[0.03] cursor-grab active:cursor-grabbing"
      >
        <div
          ref={trackRef}
          className="absolute top-0 bottom-0 left-0 will-change-transform"
          style={{ width: `${zoom * 100}%` }}
        >
          {segments.map((seg, i) => {
            const label = shown(seg)
            const hue = hueOf(label)
            const isCurrent = i === currentIndex
            const edited = !!seg.user
            return (
              <button
                key={`${seg.start}-${i}`}
                onClick={(e) => {
                  e.stopPropagation()
                  // the pointer was scrubbing, not picking a chord
                  if (draggedRef.current) return
                  onSeek(seg.start)
                  setEditing(i)
                  setHover(null)
                }}
                onMouseEnter={(e) =>
                  setHover({ label, x: e.clientX, y: e.currentTarget.getBoundingClientRect().top })
                }
                onMouseMove={(e) =>
                  setHover((h) => (h ? { ...h, x: e.clientX } : h))
                }
                onMouseLeave={() => setHover(null)}
                title={`${chordText(label) || 'no chord'} at ${fmtTime(seg.start)}`}
                className={`no-drag absolute top-0 bottom-0 flex items-center justify-center overflow-hidden border-r border-black/30 transition-colors ${
                  editing === i ? 'ring-2 ring-white/80 ring-inset z-10' : ''
                }`}
                style={{
                  left: `${(seg.start / span) * 100}%`,
                  width: `${((seg.end - seg.start) / span) * 100}%`,
                  background:
                    hue === null
                      ? 'rgba(255,255,255,0.04)'
                      : `hsl(${hue} 60% ${isCurrent ? '58%' : '42%'} / ${isCurrent ? 0.95 : 0.55})`
                }}
              >
                <span
                  className={`px-1 text-[10.5px] font-semibold tracking-tight whitespace-nowrap ${
                    isCurrent ? 'text-black' : 'text-white/90'
                  }`}
                >
                  {chordText(label)}
                  {edited && <span className="opacity-60">*</span>}
                </span>
              </button>
            )
          })}
        </div>
        <span ref={markerRef} className="pointer-events-none absolute top-0 bottom-0 w-px bg-white/90" />
      </div>

      {editingSegment && (
        <div className="mt-2.5 rounded-xl bg-black/30 border border-white/[0.07] px-3 py-2.5 rise-in">
          <div className="flex items-center justify-between gap-3 mb-2">
            <span className="text-[12px] text-white/70">
              Chord at <span className="font-mono">{fmtTime(editingSegment.start)}</span>
              {editingSegment.user && (
                <span className="text-white/35"> · detected {chordText(editingSegment.label) || 'no chord'}</span>
              )}
            </span>
            <span className="flex items-center gap-2">
              {editingSegment.user && (
                <button
                  onClick={() => setChord(null)}
                  className="no-drag text-[11px] text-violet-300 hover:text-violet-200 transition-colors"
                >
                  Reset to detected
                </button>
              )}
              <button
                onClick={() => setChord('N')}
                className="no-drag text-[11px] text-white/45 hover:text-white transition-colors"
              >
                No chord
              </button>
              <button
                onClick={() => setEditing(null)}
                className="no-drag text-[11px] text-white/45 hover:text-white transition-colors"
              >
                Done
              </button>
            </span>
          </div>
          <div className="flex flex-wrap gap-1 mb-1.5">
            {ROOTS.map((root) => {
              const quality = shown(editingSegment).split(':')[1] ?? 'maj'
              const on = shown(editingSegment).split(':')[0] === root
              return (
                <button
                  key={root}
                  onClick={() => setChord(quality === 'maj' ? root : `${root}:${quality}`)}
                  className={`no-drag w-9 h-7 rounded-md text-[11px] font-semibold transition-colors ${
                    on ? 'bg-white text-black' : 'bg-white/[0.06] text-white/60 hover:text-white hover:bg-white/10'
                  }`}
                >
                  {root}
                </button>
              )
            })}
          </div>
          <div className="flex flex-wrap gap-1">
            {QUALITIES.map((q) => {
              const root = shown(editingSegment).split(':')[0]
              const on = (shown(editingSegment).split(':')[1] ?? 'maj') === q.id
              const valid = ROOTS.includes(root)
              return (
                <button
                  key={q.id}
                  disabled={!valid}
                  onClick={() => setChord(q.id === 'maj' ? root : `${root}:${q.id}`)}
                  className={`no-drag px-2.5 h-7 rounded-md text-[11px] font-semibold transition-colors disabled:opacity-30 ${
                    on ? 'bg-white text-black' : 'bg-white/[0.06] text-white/60 hover:text-white hover:bg-white/10'
                  }`}
                >
                  {q.label}
                </button>
              )
            })}
          </div>
          {/* a phone cannot hover, so the shapes sit in the picker too */}
          {shapesFor(shown(editingSegment)).length > 0 && (
            <div className="flex gap-2 mt-2 pt-2 border-t border-white/[0.06] overflow-x-auto">
              {shapesFor(shown(editingSegment)).map((shape, i) => (
                <ChordDiagram
                  key={i}
                  shape={shape}
                  color={`hsl(${hueOf(shown(editingSegment)) ?? 0} 65% 62%)`}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {hover &&
        editing === null &&
        shapesFor(hover.label).length > 0 &&
        createPortal(
          <div
            className="fixed z-[100] pointer-events-none rounded-xl bg-[#16151d] border border-white/[0.1] shadow-2xl px-3 py-2"
            style={{ left: Math.max(8, hover.x - 120), top: Math.max(8, hover.y - 128) }}
          >
            <p className="text-[11px] font-semibold text-white/70 mb-1">{chordText(hover.label)} on guitar</p>
            <div className="flex gap-2">
              {shapesFor(hover.label).map((shape, i) => (
                <ChordDiagram key={i} shape={shape} color={`hsl(${hueOf(hover.label) ?? 0} 65% 62%)`} />
              ))}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}
