import type { YTState } from './youtube'

/* The picture follows the stems: the Web Audio clock is the master, and a
   host keeps its video next to it. Two hosts exist, the YouTube embed and a
   video file downloaded to the server (see LocalVideoHost below), so the
   player does not care which one it is driving. */
export interface VideoHost {
  mount(container: HTMLElement, videoId: string, onState: (s: YTState) => void): Promise<void>
  play(): void
  pause(): void
  seek(seconds: number): void
  time(): number
  duration(): number
  destroy(): void
  /* called continuously while playing, with the audio clock's position */
  sync(target: number, playing: boolean): void
}

// past this the picture is visibly out of step and worth jumping
const HARD_SEEK = 0.35
// below this it is close enough to leave alone
const IN_SYNC = 0.03
// speed nudge per second of drift, and how far the speed may bend
const CORRECTION = 0.4
const MAX_RATE_SHIFT = 0.06
// a stalled video cannot be fixed by seeking it again and again, so the
// wait between corrections doubles until one of them sticks
const MIN_SEEK_GAP = 1500
const MAX_SEEK_GAP = 30000
// how often to ask a browser that is refusing to play (a background tab)
const PLAY_RETRY = 1000
// the video has to hold its place this long before corrections are cheap again
const SETTLED = 3000

export class LocalVideoHost implements VideoHost {
  private el: HTMLVideoElement | null = null
  private rate = 1
  // no correction has happened yet, so the first one must not be held back
  private lastSeekAt = -Infinity
  private seekGap = MIN_SEEK_GAP
  private lastPlayAt = -Infinity
  private inSyncSince = 0
  private stalled = false

  mount(container: HTMLElement, videoId: string, onState: (s: YTState) => void): Promise<void> {
    const el = document.createElement('video')
    el.src = `/api/songs/${encodeURIComponent(videoId)}/video.mp4`
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    el.className = 'w-full h-full object-contain bg-black'
    el.addEventListener('waiting', () => {
      this.stalled = true
      onState('buffering')
    })
    el.addEventListener('playing', () => {
      this.stalled = false
      onState('playing')
    })
    el.addEventListener('seeked', () => {
      this.stalled = false
    })
    el.addEventListener('pause', () => onState('paused'))
    el.addEventListener('ended', () => onState('ended'))
    container.appendChild(el)
    this.el = el
    return new Promise((resolve) => {
      if (el.readyState >= 1) return resolve()
      el.addEventListener('loadedmetadata', () => resolve(), { once: true })
      el.addEventListener('error', () => resolve(), { once: true })
    })
  }

  play(): void {
    void this.el?.play().catch(() => {})
  }

  pause(): void {
    this.el?.pause()
  }

  seek(seconds: number): void {
    if (!this.el) return
    this.lastSeekAt = performance.now()
    this.seekGap = MIN_SEEK_GAP
    this.inSyncSince = 0
    this.el.currentTime = Math.max(0, seconds)
  }

  time(): number {
    return this.el?.currentTime ?? 0
  }

  duration(): number {
    const d = this.el?.duration ?? 0
    return Number.isFinite(d) ? d : 0
  }

  /* A local file never has to rebuffer, so instead of jumping on every small
     drift the video runs a fraction faster or slower until it catches up,
     which is invisible on screen */
  sync(target: number, playing: boolean): void {
    const el = this.el
    if (!el) return
    if (!playing) {
      if (!el.paused) el.pause()
      if (Math.abs(el.currentTime - target) > HARD_SEEK) el.currentTime = Math.max(0, target)
      return
    }
    // nothing to correct until the picture is really running: a browser that
    // refuses to play (a background tab) or a stalled video would otherwise
    // be seeked over and over, which is what makes the embed stutter
    if (el.paused) {
      const now = performance.now()
      if (now - this.lastPlayAt > PLAY_RETRY) {
        this.lastPlayAt = now
        void el.play().catch(() => {})
      }
      return
    }
    if (el.readyState < 3 || el.seeking || this.stalled) return
    const now = performance.now()
    const drift = el.currentTime - target
    if (Math.abs(drift) > HARD_SEEK) {
      this.inSyncSince = 0
      if (now - this.lastSeekAt < this.seekGap) return
      this.lastSeekAt = now
      this.seekGap = Math.min(this.seekGap * 2, MAX_SEEK_GAP)
      el.currentTime = Math.max(0, target)
      this.setRate(1)
      return
    }
    // a seek leaves the drift at zero for a moment, so the backoff only
    // resets once the video has actually held its place for a while
    if (!this.inSyncSince) this.inSyncSince = now
    else if (now - this.inSyncSince > SETTLED) this.seekGap = MIN_SEEK_GAP
    this.setRate(Math.abs(drift) < IN_SYNC ? 1 : 1 - drift * CORRECTION)
  }

  private setRate(rate: number): void {
    const clamped = Math.min(1 + MAX_RATE_SHIFT, Math.max(1 - MAX_RATE_SHIFT, rate))
    if (!this.el || Math.abs(this.rate - clamped) < 0.005) return
    this.rate = clamped
    this.el.playbackRate = clamped
  }

  destroy(): void {
    const el = this.el
    this.el = null
    if (!el) return
    el.pause()
    el.removeAttribute('src')
    el.load()
    el.remove()
  }
}
