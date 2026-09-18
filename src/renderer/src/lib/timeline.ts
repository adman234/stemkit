/* The maths and naming behind the chord timeline, kept out of the component
   so it can be checked by scripts/chord-timeline-test.mjs */

export const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export const ZOOM_STEPS = [1, 2, 4, 8, 16, 32]

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
