/* Which compressed copy of a stem to ask the server for, best first.

   AAC suits most browsers and is what a split leaves ready. Firefox is the
   exception: it carries its own Opus decoder on every platform it runs on,
   while its AAC goes out to whatever the operating system provides, and a
   phone is where that is least dependable. Asking canPlayType does not
   separate the two, since Firefox says "probably" to both, so Gecko is
   picked out by name. Firefox on iOS is not Gecko and stays on AAC, because
   the WebKit underneath it may not take Opus.

   None of this is load-bearing: a format that will not decode is dropped for
   the next one, and the WAV at the end cannot be refused, because the app
   reads it itself rather than asking the browser to. */

export const PLAYBACK_FORMATS = [
  { format: 'm4a', type: 'audio/mp4; codecs="mp4a.40.2"' },
  { format: 'webm', type: 'audio/webm; codecs="opus"' }
]

/* Firefox goes one step further and is handed the ogg copy first, which the
   app decodes with its own WebAssembly Opus decoder rather than the
   browser's. Measured on the same Android phone, six stems took 2.4s that
   way against 4.2s for each single stem through Firefox's decoder, while
   Chrome's own decoder was quicker than either and so is left alone. */
export function playbackFormats(
  userAgent: string,
  canPlay: (type: string) => boolean,
  wasm = true
): string[] {
  const gecko = /Gecko\//.test(userAgent)
  const order = gecko ? ['webm', 'm4a'] : ['m4a', 'webm']
  const sorted = order.map((id) => PLAYBACK_FORMATS.find((f) => f.format === id)!)
  const usable = sorted.filter((f) => canPlay(f.type)).map((f) => f.format)
  const rest = sorted.map((f) => f.format).filter((f) => !usable.includes(f))
  return [...(gecko && wasm ? ['ogg'] : []), ...usable, ...rest, 'wav']
}
