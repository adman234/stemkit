// Checks the chord timeline's scrolling: zoomed out the playhead travels
// across a still strip, zoomed in the playhead is pinned to the middle and the
// strip slides, and in both cases the moment being played lines up with the
// playhead. Run with: npm run web:test
import { build } from 'esbuild'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

const bundle = join(mkdtempSync(join(tmpdir(), 'stemkit-')), 'timeline.mjs')
await build({
  entryPoints: [new URL('../src/renderer/src/lib/timeline.ts', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  logLevel: 'error'
})
const { timelineFrame, defaultZoom, dragSeek, pickerState, ZOOM_STEPS, DEFAULT_WINDOW_SECONDS } =
  await import(pathToFileURL(bundle).href)

const SPAN = 240 // a 4 minute song
const WIDTH = 1000 // pixels of visible strip

/* where a given moment of the song ends up on screen, in pixels */
function screenX(moment, zoom, frame) {
  return (moment / SPAN) * WIDTH * zoom + frame.translateX
}

const checks = []
const near = (a, b, tolerance = 0.001) => Math.abs(a - b) < tolerance

// zoomed out: the strip does not move and the playhead crosses it
{
  const start = timelineFrame(0, SPAN, 1, WIDTH)
  const middle = timelineFrame(120, SPAN, 1, WIDTH)
  const end = timelineFrame(240, SPAN, 1, WIDTH)
  checks.push(['zoomed out, strip stays put', [start, middle, end].every((f) => f.translateX === 0)])
  checks.push([
    'zoomed out, playhead runs 0 to 100 percent',
    near(start.markerLeft, 0) && near(middle.markerLeft, 50) && near(end.markerLeft, 100)
  ])
}

// zoomed in: the playhead is pinned and the strip slides instead
{
  const frames = [0, 30, 120, 239].map((t) => timelineFrame(t, SPAN, 8, WIDTH))
  checks.push(['zoomed in, playhead stays in the middle', frames.every((f) => f.markerLeft === 50)])
  checks.push([
    'zoomed in, strip slides right to left',
    frames[0].translateX > frames[1].translateX &&
      frames[1].translateX > frames[2].translateX &&
      frames[2].translateX > frames[3].translateX
  ])
}

// the point of the whole thing: what you hear is what sits under the playhead
for (const zoom of [1, 2, 8, 32]) {
  const moments = [0, 12.5, 60, 119, 200, 240]
  const ok = moments.every((t) => {
    const frame = timelineFrame(t, SPAN, zoom, WIDTH)
    const playheadX = (frame.markerLeft / 100) * WIDTH
    return near(screenX(t, zoom, frame), playheadX, 0.01)
  })
  checks.push([`at ${zoom}x the moment playing sits under the playhead`, ok])
}

// before the song starts there is blank strip rather than a drifting playhead
{
  const frame = timelineFrame(0, SPAN, 4, WIDTH)
  checks.push(['zoomed in, the song starts at the middle', near(frame.translateX, WIDTH / 2)])
}

// a position past the end is clamped instead of running away
{
  const frame = timelineFrame(SPAN * 2, SPAN, 1, WIDTH)
  checks.push(['past the end, the playhead stops at 100 percent', near(frame.markerLeft, 100)])
}

// chords open on a window of about twenty seconds, whatever the song's length
for (const [label, seconds] of [
  ['a minute and a half', 95],
  ['five and a half minutes', 349],
  ['eighteen minutes', 1097]
]) {
  const zoom = defaultZoom(seconds)
  const window = seconds / zoom
  checks.push([
    `${label} opens on ${window.toFixed(0)}s of music`,
    ZOOM_STEPS.includes(zoom) && Math.abs(window - DEFAULT_WINDOW_SECONDS) <= DEFAULT_WINDOW_SECONDS / 2
  ])
}

// a song shorter than the window, or one whose length is not known yet, just
// shows itself whole
checks.push(['a twenty second song is not zoomed', defaultZoom(20) === 1])
checks.push(['an unknown length is not zoomed', defaultZoom(0) === 1])

// dragging the strip pulls the music past the playhead
{
  const middle = SPAN / 2
  checks.push([
    'dragging right goes back in time',
    dragSeek(middle, 100, SPAN, 1, WIDTH) < middle && dragSeek(middle, -100, SPAN, 1, WIDTH) > middle
  ])
  checks.push([
    'zoomed out, a full width drag covers the whole song',
    near(dragSeek(SPAN, WIDTH, SPAN, 1, WIDTH), 0, 0.001)
  ])
  checks.push([
    'zoomed in four times, the same drag covers a quarter of it',
    near(dragSeek(SPAN, WIDTH, SPAN, 4, WIDTH), SPAN * 0.75, 0.001)
  ])
  checks.push([
    'a drag cannot run off either end',
    dragSeek(1, WIDTH * 5, SPAN, 1, WIDTH) === 0 && dragSeek(SPAN - 1, -WIDTH * 5, SPAN, 1, WIDTH) === SPAN
  ])
  checks.push(['a song with no length does not move', dragSeek(0, 250, 0, 1, WIDTH) === 0])
}

// the chord picker lives as long as the chord it was opened on
{
  // opening one seeks to its chord, so the playhead is still elsewhere
  const opened = pickerState(5, 2, false)
  checks.push(['the seek that opens a picker does not close it', opened.open && !opened.reached])

  const playing = pickerState(5, 5, false)
  checks.push(['it stays while its own chord plays', playing.open && playing.reached])

  checks.push(['it goes when that chord ends', pickerState(5, 6, true).open === false])
  checks.push(['and when the music runs into a gap', pickerState(5, -1, true).open === false])

  // a chord picked ahead of the playhead waits for the music to reach it
  checks.push(['a chord not reached yet keeps its picker', pickerState(5, 6, false).open === true])
}

let ok = true
for (const [label, pass] of checks) {
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
  if (!pass) ok = false
}
process.exit(ok ? 0 : 1)
