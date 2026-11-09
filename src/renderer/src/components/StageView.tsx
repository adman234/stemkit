import { useEffect, useState } from 'react'
import type { ChordData, LyricsData, StemId } from '../../../shared/types'
import { LyricsPanel } from './LyricsPanel'
import { ChordTimeline } from './ChordTimeline'
import { SeekBar } from './Transport'
import { PlayIcon, PauseIcon } from './Icons'

interface Props {
  title: string
  playing: boolean
  duration: number
  getPosition: () => number
  onTogglePlay: () => void
  onSeek: (seconds: number) => void
  chords: ChordData | null
  lyrics: LyricsData | null
  lyricsBusy: boolean
  canLyrics: boolean
  onFindLyrics: () => void
  stems: { id: StemId; label: string; color: string }[]
  audible: (id: StemId) => boolean
  onToggleStem: (id: StemId) => void
  onExit: () => void
}

const SAFE = {
  paddingTop: 'max(8px, env(safe-area-inset-top))',
  paddingBottom: 'max(8px, env(safe-area-inset-bottom))',
  paddingLeft: 'max(12px, env(safe-area-inset-left))',
  paddingRight: 'max(12px, env(safe-area-inset-right))'
}

/* The view for playing along with friends, a phone held sideways on a music
   stand or a table: the lyrics big enough to read from a distance, the chords
   coming up under them, and a row of chips that mute a stem with one tap. It
   covers the normal player, which stays mounted underneath because the video
   lives in it. */
export function StageView({
  title,
  playing,
  duration,
  getPosition,
  onTogglePlay,
  onSeek,
  chords,
  lyrics,
  lyricsBusy,
  canLyrics,
  onFindLyrics,
  stems,
  audible,
  onToggleStem,
  onExit
}: Props): React.ReactElement {
  const [fullscreen, setFullscreen] = useState(() => !!document.fullscreenElement)

  useEffect(() => {
    const onChange = (): void => setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void document.documentElement.requestFullscreen().catch(() => {})
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col gap-2 bg-[var(--bg)]" style={SAFE}>
      <div className="shrink-0 h-12 flex items-center gap-3">
        <button
          onClick={onTogglePlay}
          disabled={duration === 0}
          className="no-drag w-10 h-10 shrink-0 rounded-full bg-white text-black flex items-center justify-center active:scale-95 transition-transform disabled:opacity-40"
        >
          {playing ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5 -translate-x-px" />}
        </button>
        <div className="flex-1 min-w-0">
          <SeekBar duration={duration} getPosition={getPosition} onSeek={onSeek} playing={playing} />
        </div>
        <span className="hidden min-[700px]:block max-w-[30%] truncate text-[12px] text-white/45">{title}</span>
        {document.fullscreenEnabled && (
          <button
            onClick={toggleFullscreen}
            className="no-drag shrink-0 h-9 px-3 rounded-full bg-white/[0.06] text-[12px] font-medium text-white/60 hover:text-white transition-colors"
          >
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
        )}
        <button
          onClick={onExit}
          className="no-drag shrink-0 h-9 px-3 rounded-full bg-white/[0.06] text-[12px] font-medium text-white/60 hover:text-white transition-colors"
        >
          Full view
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {lyrics?.lines.length ? (
          <LyricsPanel variant="stage" data={lyrics} getPosition={getPosition} onSeek={onSeek} />
        ) : (
          <div className="h-full flex items-center justify-center rounded-lg bg-white/[0.03] text-[14px] text-white/40">
            {lyricsBusy ? (
              'Finding the lyrics…'
            ) : canLyrics ? (
              <button
                onClick={onFindLyrics}
                className="no-drag px-4 h-10 rounded-full bg-white/[0.08] text-white/70 hover:text-white font-medium transition-colors"
              >
                Find lyrics
              </button>
            ) : (
              'No lyrics for this song'
            )}
          </div>
        )}
      </div>

      {chords && chords.segments.length > 0 && (
        <div className="shrink-0">
          <ChordTimeline
            variant="stage"
            chords={chords}
            duration={duration}
            getPosition={getPosition}
            onSeek={onSeek}
          />
        </div>
      )}

      <div className="shrink-0 h-[52px] flex items-center gap-2 overflow-x-auto">
        {stems.map((s) => {
          const on = audible(s.id)
          return (
            <button
              key={s.id}
              onClick={() => onToggleStem(s.id)}
              className={`no-drag shrink-0 min-h-[40px] px-4 rounded-full flex items-center gap-2 text-[13px] font-medium capitalize whitespace-nowrap transition-colors ${
                on ? '' : 'bg-white/[0.04] text-white/30'
              }`}
              style={on ? { background: `${s.color}1f`, color: s.color, boxShadow: `inset 0 0 0 1px ${s.color}55` } : undefined}
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color, opacity: on ? 1 : 0.3 }} />
              <span className={on ? '' : 'line-through'}>{s.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
