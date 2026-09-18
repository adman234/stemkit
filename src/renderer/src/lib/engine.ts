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

interface Pcm {
  channels: Float32Array[]
  sampleRate: number
}

/* The splitter writes 32-bit float WAVs, which Firefox will not decode at all
   ("the buffer passed to decodeAudioData contains invalid content"), so they
   are read here instead of being handed to the browser. It is also the
   cheaper path: no copy of a hundred-megabyte buffer, and the samples can be
   thinned on the way in rather than after the whole thing is in memory. */
function readWav(bytes: ArrayBuffer): Pcm {
  const view = new DataView(bytes)
  const tag = (at: number): string =>
    String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))
  if (view.byteLength < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file')

  let format = 1
  let count = 2
  let sampleRate = 44100
  let bits = 32
  let dataAt = -1
  let dataLength = 0
  for (let at = 12; at + 8 <= view.byteLength; ) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      count = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bits = view.getUint16(body + 14, true)
      // WAVE_FORMAT_EXTENSIBLE keeps the real format at the front of its GUID
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true)
    } else if (id === 'data') {
      dataAt = body
      dataLength = Math.min(size, view.byteLength - body)
      break
    }
    at = body + size + (size % 2)
  }
  if (dataAt < 0 || !count || !sampleRate) throw new Error('WAV file has no audio')

  const width = bits >> 3
  const frames = Math.floor(dataLength / (width * count))
  const channels = Array.from({ length: count }, () => new Float32Array(frames))

  if (format === 3 && bits === 32 && dataAt % 4 === 0) {
    // the common case, and a typed array beats a DataView call per sample
    const flat = new Float32Array(bytes, dataAt, frames * count)
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < count; c++) channels[c][f] = flat[f * count + c]
    }
    return { channels, sampleRate }
  }

  const sample = (at: number): number => {
    if (format === 3) return bits === 64 ? view.getFloat64(at, true) : view.getFloat32(at, true)
    if (bits === 16) return view.getInt16(at, true) / 32768
    if (bits === 24) {
      return (view.getUint8(at) | (view.getUint8(at + 1) << 8) | (view.getInt8(at + 2) << 16)) / 8388608
    }
    if (bits === 32) return view.getInt32(at, true) / 2147483648
    if (bits === 8) return view.getUint8(at) / 128 - 1
    throw new Error(`unsupported WAV depth (${bits}-bit)`)
  }
  if (format !== 1 && format !== 3) throw new Error(`unsupported WAV format (${format})`)
  for (let f = 0; f < frames; f++) {
    for (let c = 0; c < count; c++) channels[c][f] = sample(dataAt + (f * count + c) * width)
  }
  return { channels, sampleRate }
}

function toAudioBuffer(ctx: AudioContext, pcm: Pcm): AudioBuffer {
  const buffer = ctx.createBuffer(pcm.channels.length, pcm.channels[0].length, pcm.sampleRate)
  for (let c = 0; c < pcm.channels.length; c++) buffer.getChannelData(c).set(pcm.channels[c])
  return buffer
}

/* decodes one stem */
export async function decodeStem(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const ctx = audioContext()
  const head = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength))
  const riff = head.length === 4 && head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
  // reading it ourselves leaves the bytes intact, so decodeAudioData (which
  // detaches them) stays available as the fallback, not the other way round
  if (riff) {
    try {
      return toAudioBuffer(ctx, readWav(bytes))
    } catch {}
  }
  return ctx.decodeAudioData(bytes)
}

/* Decodes one stem at a time and lets go of each stem's bytes as it goes.
   Decoding a dozen stems at once needs every encoded and decoded copy in
   memory together, which is enough to lose the tab on a phone */
export async function decodePayload(
  payload: Record<string, Uint8Array>,
  onProgress?: (done: number, total: number) => void
): Promise<BufferMap> {
  const ids = Object.keys(payload)
  const out: BufferMap = {}
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    // decodeAudioData detaches the source buffer, which is what we want:
    // the encoded copy is throwaway once it is decoded
    out[id as StemId] = await decodeStem(payload[id].buffer as ArrayBuffer)
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
