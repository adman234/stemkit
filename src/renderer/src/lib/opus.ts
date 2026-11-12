/* Ogg Opus decoded with WebAssembly in a worker of its own, instead of the
   browser's decodeAudioData. Firefox on Android takes around 4s a stem
   through its own decoder and runs them one after another; this takes about
   a second a stem and several stems decode side by side on separate cores.
   The library is only fetched the first time an ogg copy turns up. */

export interface DecodedPcm {
  channels: Float32Array[]
  sampleRate: number
}

export function isOgg(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < 4) return false
  const h = new Uint8Array(bytes, 0, 4)
  return h[0] === 0x4f && h[1] === 0x67 && h[2] === 0x67 && h[3] === 0x53 // "OggS"
}

export async function decodeOggOpus(bytes: ArrayBuffer): Promise<DecodedPcm> {
  const { OggOpusDecoderWebWorker } = await import('ogg-opus-decoder')
  const decoder = new OggOpusDecoderWebWorker()
  try {
    await decoder.ready
    const out = await decoder.decodeFile(new Uint8Array(bytes))
    if (!out.samplesDecoded || !out.channelData.length) {
      throw new Error(out.errors[0]?.message ?? 'no audio in the ogg copy')
    }
    return {
      channels: out.channelData.map((c) => c.subarray(0, out.samplesDecoded)),
      sampleRate: out.sampleRate
    }
  } finally {
    void decoder.free()
  }
}
