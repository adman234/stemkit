import type { StemId } from '../../../shared/types'

export type BufferMap = Partial<Record<StemId, AudioBuffer>>

/* One context for the whole app. Browsers only allow a handful at once, and
   opening a new one per song used to exhaust that on a phone after a few
   songs: decoding then failed and the player came up with no stems at all */
let shared: AudioContext | null = null

export function audioContext(): AudioContext {
  if (!shared) shared = new AudioContext()
  return shared
}

/* Decodes one stem at a time and lets go of each stem's bytes as it goes.
   Decoding a dozen stems at once needs every encoded and decoded copy in
   memory together, which is enough to lose the tab on a phone */
export async function decodePayload(
  payload: Record<string, Uint8Array>,
  onProgress?: (done: number, total: number) => void
): Promise<BufferMap> {
  const ctx = audioContext()
  const ids = Object.keys(payload)
  const out: BufferMap = {}
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    // decodeAudioData detaches the source buffer, which is what we want:
    // the encoded copy is throwaway once it is decoded
    out[id as StemId] = await ctx.decodeAudioData(payload[id].buffer as ArrayBuffer)
    delete payload[id]
    onProgress?.(i + 1, ids.length)
  }
  return out
}

export class StemEngine {
  private ctx: AudioContext | null = null
  private buffers: BufferMap = {}
  private gains: Partial<Record<StemId, GainNode>> = {}
  private master: GainNode | null = null
  private sources: AudioBufferSourceNode[] = []
  private playing = false
  private anchorYt = 0
  private anchorCtx = 0
  rate = 1

  private ensureCtx(): AudioContext {
    if (!this.ctx) {
      this.ctx = audioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.9
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }

  private getGain(id: StemId): GainNode {
    const ctx = this.ensureCtx()
    let g = this.gains[id]
    if (!g) {
      g = ctx.createGain()
      g.connect(this.master!)
      this.gains[id] = g
    }
    return g
  }

  resume(): void {
    void this.ensureCtx().resume()
  }

  async decode(payload: Record<string, Uint8Array>): Promise<void> {
    const buffers = await decodePayload(payload)
    this.buffers = buffers
  }

  setBuffers(buffers: BufferMap): void {
    this.stopAll()
    this.buffers = buffers
  }

  hasBuffers(): boolean {
    return Object.keys(this.buffers).length > 0
  }

  setPlaying(playing: boolean, time: number): void {
    if (playing) this.resume()
    this.playing = playing
    this.align(time)
  }

  align(time: number): void {
    this.stopSources()
    this.anchorYt = time
    if (!this.ctx || !this.playing || !this.hasBuffers()) return
    const ctx = this.ctx
    const startAt = ctx.currentTime + 0.04
    for (const id of Object.keys(this.buffers) as StemId[]) {
      const buf = this.buffers[id]
      if (!buf) continue
      const gain = this.getGain(id)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = this.rate
      src.connect(gain)
      src.start(startAt, Math.min(Math.max(0, time), Math.max(0, buf.duration - 0.01)))
      this.sources.push(src)
    }
    this.anchorCtx = startAt
  }

  expected(): number {
    if (!this.ctx || !this.playing) return this.anchorYt
    return this.anchorYt + (this.ctx.currentTime - this.anchorCtx) * this.rate
  }

  trackDuration(): number {
    let d = 0
    for (const buf of Object.values(this.buffers)) {
      if (buf && buf.duration > d) d = buf.duration
    }
    return d
  }

  applyMix(
    vols: Partial<Record<StemId, number>>,
    mutes: Set<StemId>,
    solos: Set<StemId>,
    masterVol: number
  ): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    for (const id of Object.keys(vols) as StemId[]) {
      const audible = !mutes.has(id) && (solos.size === 0 || solos.has(id))
      this.getGain(id).gain.setTargetAtTime(audible ? vols[id] ?? 1 : 0, now, 0.012)
    }
    this.master?.gain.setTargetAtTime(masterVol, now, 0.012)
  }

  stopAll(): void {
    this.playing = false
    this.stopSources()
  }

  private stopSources(): void {
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {}
      try {
        s.disconnect()
      } catch {}
    }
    this.sources = []
  }
}

export const engine = new StemEngine()
