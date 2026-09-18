import { useEffect, useState } from 'react'
import type { ChordData } from '../../../shared/types'

interface Props {
  chords: ChordData
  duration: number
  getPosition: () => number
  onSeek: (seconds: number) => void
}

const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/* every chord on the same root gets the same hue, so a progression that
   keeps coming back is easy to spot along the timeline */
function hueOf(label: string): number | null {
  const root = ROOTS.indexOf(label.split(':')[0])
  return root < 0 ? null : root * 30
}

/* 'F#:min7' reads as 'F#m7' on a narrow block */
function chordText(label: string): string {
  if (label === 'N') return ''
  const [root, quality] = label.split(':')
  if (!quality) return root
  const short: Record<string, string> = {
    min: 'm',
    min7: 'm7',
    maj7: 'maj7',
    '7': '7',
    dim: '°',
    aug: '+',
    sus4: 'sus4'
  }
  return root + (short[quality] ?? quality)
}

export function ChordTimeline({ chords, duration, getPosition, onSeek }: Props): React.ReactElement {
  const [now, setNow] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setNow(getPosition()), 100)
    return () => clearInterval(id)
  }, [getPosition])

  const span = duration > 0 ? duration : chords.duration || 1
  const playedFraction = Math.min(1, Math.max(0, now / span))
  const current = chords.segments.find((s) => now >= s.start && now < s.end)
  const { key } = chords
  const unsure = key.confidence < 0.3

  return (
    <div className="glass rounded-2xl px-4 py-3 mt-4">
      <div className="flex items-baseline justify-between gap-4 mb-2">
        <div className="flex items-baseline gap-2.5 min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-white/30">Key</span>
          <span className="text-[14px] font-semibold">{key.name}</span>
          <span className="text-[11px] text-white/35 truncate" title={`Alternative reading: ${key.alternative}`}>
            {unsure ? `unsure, could be ${key.alternative}` : `or its relative, ${key.relative}`}
          </span>
        </div>
        <div className="flex items-baseline gap-3 shrink-0 text-[11px] text-white/35 font-mono">
          {chords.tempo ? <span>{Math.round(chords.tempo)} BPM</span> : null}
          <span>{chords.segments.filter((s) => s.label !== 'N').length} chords</span>
          {current && current.label !== 'N' && (
            <span className="text-[13px] font-sans font-semibold text-white tabular-nums">
              {chordText(current.label)}
            </span>
          )}
        </div>
      </div>

      <div className="relative h-11 rounded-lg overflow-hidden bg-white/[0.03]">
        {chords.segments.map((seg, i) => {
          const left = (seg.start / span) * 100
          const width = ((seg.end - seg.start) / span) * 100
          const hue = hueOf(seg.label)
          const isCurrent = seg === current
          return (
            <button
              key={`${seg.start}-${i}`}
              onClick={() => onSeek(seg.start)}
              title={`${chordText(seg.label) || 'no chord'} at ${Math.floor(seg.start / 60)}:${String(
                Math.floor(seg.start % 60)
              ).padStart(2, '0')}`}
              className="no-drag absolute top-0 bottom-0 flex items-center justify-center overflow-hidden border-r border-black/30 transition-colors"
              style={{
                left: `${left}%`,
                width: `${width}%`,
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
                {chordText(seg.label)}
              </span>
            </button>
          )
        })}
        <span
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-white/90"
          style={{ left: `${playedFraction * 100}%` }}
        />
      </div>
    </div>
  )
}
