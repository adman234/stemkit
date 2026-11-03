import { useEffect, useRef, useState } from 'react'
import type { LyricsData } from '../../../shared/types'

interface Props {
  data: LyricsData
  getPosition: () => number
  onSeek: (seconds: number) => void
}

/* Sing-along view: the lyrics scroll with the song, the line being sung is
   lit and, when the words were timed against the vocals, the current word
   inside it is brighter. Tapping a line jumps the song there. The heavy work
   (finding and timing the words) is done server side; this only follows the
   playhead. */
export function LyricsPanel({ data, getPosition, onSeek }: Props): React.ReactElement {
  const lines = data.lines
  const [current, setCurrent] = useState(-1)
  const [word, setWord] = useState(-1)
  const lineRefs = useRef<(HTMLButtonElement | null)[]>([])
  const scrollRef = useRef<HTMLDivElement>(null)

  // follow the playhead; find the line and word being sung now
  useEffect(() => {
    let raf = 0
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      const t = getPosition()
      let li = -1
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i].start
        if (s === undefined) continue
        if (s <= t + 0.08) li = i
        else break
      }
      // a line's own end can drop the highlight during a long gap
      if (li >= 0 && lines[li].end !== undefined && t > (lines[li].end as number) + 0.5) {
        const next = lines[li + 1]?.start
        if (next === undefined || t < next) li = -1
      }
      let wi = -1
      if (li >= 0) {
        const ws = lines[li].words
        for (let i = 0; i < ws.length; i++) {
          if (ws[i].start <= t + 0.05) wi = i
          else break
        }
      }
      setCurrent((c) => (c === li ? c : li))
      setWord((w) => (w === wi ? w : wi))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [lines, getPosition])

  // keep the sung line in view, without yanking the page around
  useEffect(() => {
    if (current < 0) return
    const el = lineRefs.current[current]
    const box = scrollRef.current
    if (!el || !box) return
    const top = el.offsetTop - box.offsetTop
    box.scrollTo({ top: top - box.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' })
  }, [current])

  const aligned = data.aligned

  return (
    <div
      ref={scrollRef}
      className="relative rounded-lg bg-white/[0.03] overflow-y-auto px-4 py-3 h-[220px] leading-relaxed text-center"
    >
      {lines.map((line, i) => {
        const on = i === current
        const seekable = line.start !== undefined
        return (
          <button
            key={i}
            ref={(el) => {
              lineRefs.current[i] = el
            }}
            onClick={() => seekable && onSeek(line.start as number)}
            className={`no-drag block w-full py-1 text-[15px] transition-colors ${
              seekable ? 'cursor-pointer' : 'cursor-default'
            } ${on ? 'text-white font-semibold' : 'text-white/35 hover:text-white/60'}`}
          >
            {on && aligned && line.words.length ? (
              <span>
                {line.words.map((w, k) => (
                  <span key={k} className={k <= word ? 'text-white' : 'text-white/45'}>
                    {w.text}{' '}
                  </span>
                ))}
              </span>
            ) : (
              line.text || '♪'
            )}
          </button>
        )
      })}
    </div>
  )
}
