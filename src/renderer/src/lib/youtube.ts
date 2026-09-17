export type YTState =
  | 'unstarted'
  | 'ended'
  | 'playing'
  | 'paused'
  | 'buffering'
  | 'cued'

const STATE_MAP: Record<number, YTState> = {
  [-1]: 'unstarted',
  0: 'ended',
  1: 'playing',
  2: 'paused',
  3: 'buffering',
  5: 'cued'
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement,
        opts: Record<string, unknown>
      ) => YTPlayerLike
    }
    onYouTubeIframeAPIReady?: () => void
  }
}

interface YTPlayerLike {
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getDuration(): number
  getPlaybackRate(): number
  mute(): void
  destroy(): void
  loadVideoById(id: string): void
}

/* Correcting the embed means seeking it, and a seek makes YouTube rebuffer,
   so corrections are rare and only for drift that sticks around. Chasing
   every small drift puts the player in a loop of seek, buffer, fall behind,
   seek, which shows up as a spinner every second or two. */
const TOLERANCE = 1.0
const RESYNC_COOLDOWN = 6000
const DRIFT_PERSIST = 1500
// after this many corrections that did not help, leave the video alone
const GIVE_UP_AFTER = 3

let apiPromise: Promise<void> | null = null

export function loadYTApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve()
  if (apiPromise) return apiPromise
  apiPromise = new Promise((resolve) => {
    const prev = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      prev?.()
      resolve()
    }
    const tag = document.createElement('script')
    tag.src = 'https://www.youtube.com/iframe_api'
    document.head.appendChild(tag)
  })
  return apiPromise
}

export class YouTubeHost {
  private player: YTPlayerLike | null = null
  private stateCb: ((s: YTState) => void) | null = null
  private state: YTState = 'unstarted'
  private lastSeekAt = 0
  private driftSince = 0
  private corrections = 0

  async mount(
    container: HTMLElement,
    videoId: string,
    onState: (s: YTState) => void
  ): Promise<void> {
    this.stateCb = onState
    await loadYTApi()
    const inner = document.createElement('div')
    container.appendChild(inner)
    this.player = await new Promise<YTPlayerLike>((resolve) => {
      const p = new window.YT!.Player(inner, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: {
          controls: 0,
          disablekb: 1,
          rel: 0,
          playsinline: 1,
          origin: window.location.origin
        },
        events: {
          onReady: () => {
            p.mute()
            resolve(p)
          },
          onStateChange: (e: { data: number }) => {
            this.state = STATE_MAP[e.data] ?? 'paused'
            this.stateCb?.(this.state)
          }
        }
      })
    })
  }

  play(): void {
    this.player?.playVideo()
  }

  pause(): void {
    this.player?.pauseVideo()
  }

  seek(t: number): void {
    this.lastSeekAt = performance.now()
    this.driftSince = 0
    this.corrections = 0
    this.player?.seekTo(Math.max(0, t), true)
  }

  /* nudges the embed back towards the audio clock, rarely and only while it
     is actually playing */
  sync(target: number, playing: boolean): void {
    const player = this.player
    if (!player || !playing || this.state !== 'playing') return
    if (this.corrections >= GIVE_UP_AFTER) return
    const now = performance.now()
    if (now - this.lastSeekAt < RESYNC_COOLDOWN) return
    const drift = player.getCurrentTime() - target
    if (Math.abs(drift) <= TOLERANCE) {
      this.driftSince = 0
      this.corrections = 0
      return
    }
    // the embed reports a stale time for a moment after buffering; wait for
    // the drift to persist before paying the cost of a seek
    if (!this.driftSince) {
      this.driftSince = now
      return
    }
    if (now - this.driftSince < DRIFT_PERSIST) return
    this.driftSince = 0
    this.lastSeekAt = now
    this.corrections += 1
    player.seekTo(Math.max(0, target), true)
  }

  /* true once corrections stopped helping: the embed is streaming badly (an
     ad, a slow connection) and the app has stopped fighting it */
  desynced(): boolean {
    return this.corrections >= GIVE_UP_AFTER
  }

  time(): number {
    return this.player?.getCurrentTime() ?? 0
  }

  duration(): number {
    return this.player?.getDuration() ?? 0
  }

  rate(): number {
    return this.player?.getPlaybackRate() ?? 1
  }

  destroy(): void {
    try {
      this.player?.destroy()
    } catch {}
    this.player = null
    this.stateCb = null
    this.state = 'unstarted'
  }
}
