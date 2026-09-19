/* The maths and naming behind the chord timeline, kept out of the component
   so it can be checked by scripts/chord-timeline-test.mjs */

export const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const ZOOM_STEPS = [1, 2, 4, 8, 16, 32, 64]

/* Chords open at roughly this much of the song on screen: close enough to
   read the changes, wide enough to see the next few coming. A long song
   needs a deeper zoom to get there, which is what the steps above allow. */
export const DEFAULT_WINDOW_SECONDS = 20

/* the step that puts the window nearest the target, so the opening view is
   about the same stretch of music whatever the song's length */
export function defaultZoom(span: number, target = DEFAULT_WINDOW_SECONDS): number {
  if (!(span > 0)) return 1
  return ZOOM_STEPS.reduce((best, step) =>
    Math.abs(span / step - target) < Math.abs(span / best - target) ? step : best
  )
}

/* Where a drag lands. The strip is dragged rather than the playhead, so the
   music follows the hand: pulling right brings earlier music into view. One
   screen width is one screenful of music, whatever the zoom. */
export function dragSeek(
  startPosition: number,
  dx: number,
  span: number,
  zoom: number,
  viewportWidth: number
): number {
  if (!(span > 0) || !(viewportWidth > 0)) return startPosition
  const moved = (dx * span) / (viewportWidth * zoom)
  return Math.max(0, Math.min(span, startPosition - moved))
}

/* A picker opened on a chord belongs to that chord, so it is put away once
   the music has played through it. Opening one seeks to its chord, and the
   playhead takes a frame to arrive, so it has to get there before leaving
   counts for anything: otherwise the seek that opened the picker closes it. */
export function pickerState(
  editing: number,
  currentIndex: number,
  reached: boolean
): { open: boolean; reached: boolean } {
  if (currentIndex === editing) return { open: true, reached: true }
  return { open: !reached, reached }
}

export interface TimelineFrame {
  // pixels the strip is shifted by, negative as the song plays on
  translateX: number
  // where the playhead sits, as a percentage of the visible strip
  markerLeft: number
}

/* Zoomed out, the whole song is on screen and the playhead travels across it.
   Zoomed in, the playhead is pinned to the middle and the music slides past,
   which keeps what you are hearing under your eyes. The ends are deliberately
   not clamped: the strip runs off centre rather than letting the playhead
   drift away from the middle. */
export function timelineFrame(
  position: number,
  span: number,
  zoom: number,
  viewportWidth: number
): TimelineFrame {
  const fraction = span > 0 ? Math.min(1, Math.max(0, position / span)) : 0
  if (zoom <= 1) return { translateX: 0, markerLeft: fraction * 100 }
  return {
    translateX: -(fraction * viewportWidth * zoom - viewportWidth / 2),
    markerLeft: 50
  }
}

/* every chord on the same root gets the same hue, so a progression that keeps
   coming back is easy to spot along the timeline */
export function hueOf(label: string): number | null {
  const root = ROOTS.indexOf(label.split(':')[0])
  return root < 0 ? null : root * 30
}

/* 'F#:min7' reads as 'F#m7' on a narrow block */
export function chordText(label: string): string {
  if (!label || label === 'N') return ''
  const [root, quality] = label.split(':')
  if (!quality) return root
  const short: Record<string, string> = {
    min: 'm',
    min7: 'm7',
    maj7: 'maj7',
    '7': '7',
    dim: '\u00b0',
    aug: '+',
    sus4: 'sus4'
  }
  return root + (short[quality] ?? quality)
}
