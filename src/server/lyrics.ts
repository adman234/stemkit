/* Finding lyrics on LRCLIB (https://lrclib.net), a free, open lyrics
   database. We search by artist and track, score the results against the
   song's own length, and prefer a result that comes with line times. The
   record we pick is handed to python/lyrics_align.py, which times the words
   against the vocals stem. Nothing here times anything; it only finds text. */

const BASE = 'https://lrclib.net/api'
// LRCLIB asks clients to identify themselves and link back
const UA = 'StemKit (https://github.com/adman234/stemkit)'

export interface LrclibRecord {
  id: number
  trackName: string
  artistName: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

export interface LyricsHint {
  artist?: string
  track?: string
  // the song's length in seconds, to score candidates by
  duration?: number
}

/* strips the noise a YouTube title carries so it reads as "artist" and
   "track": bracketed tags, feat. credits, quality marks, and the "- Topic"
   auto-channel suffix. Best effort; the manual retry in the player is the
   backstop when it guesses wrong */
export function cleanTitle(title: string): { artist?: string; track: string } {
  let t = title
    .replace(/\((?:official|lyric|audio|video|music|hd|hq|4k|visualizer|mv)[^)]*\)/gi, '')
    .replace(/\[(?:official|lyric|audio|video|music|hd|hq|4k|visualizer|mv)[^\]]*\]/gi, '')
    .replace(/\b(?:official\s+)?(?:music\s+)?video\b/gi, '')
    .replace(/\b(?:official\s+)?(?:lyric|audio)s?\b/gi, '')
    .replace(/\s*[-–]\s*topic\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  // "Artist - Title" (or an en dash); take the first split as the artist
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  if (m) return { artist: m[1].trim(), track: m[2].replace(/\s*\(feat[^)]*\)/gi, '').trim() }
  return { track: t.replace(/\s*\(feat[^)]*\)/gi, '').trim() || title }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`)
  return res.json()
}

function asRecords(data: unknown): LrclibRecord[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (r): r is LrclibRecord => !!r && typeof r === 'object' && typeof (r as LrclibRecord).id === 'number'
  )
}

/* how good a candidate is for this song: closeness in length first, then a
   nudge toward records that carry lyrics (synced over plain). Lower is better */
function cost(rec: LrclibRecord, duration?: number): number {
  let c = 0
  if (duration && rec.duration) c += Math.abs(rec.duration - duration)
  else c += 20 // unknown length: worse than a close match, better than a far one
  if (rec.syncedLyrics) c -= 6
  else if (rec.plainLyrics) c -= 2
  if (rec.instrumental) c += 100
  return c
}

/* looks the song up on LRCLIB and returns the best record, or null. Tries the
   structured search first, then a plain-text query as a fallback */
export async function searchLrclib(hint: LyricsHint): Promise<LrclibRecord | null> {
  const track = (hint.track ?? '').trim()
  const artist = (hint.artist ?? '').trim()
  if (!track) return null

  const tries: string[] = []
  const params = new URLSearchParams({ track_name: track })
  if (artist) params.set('artist_name', artist)
  tries.push(`${BASE}/search?${params.toString()}`)
  // a looser query that lets LRCLIB do its own matching
  tries.push(`${BASE}/search?${new URLSearchParams({ q: [artist, track].filter(Boolean).join(' ') }).toString()}`)

  const seen = new Set<number>()
  const all: LrclibRecord[] = []
  for (const url of tries) {
    let recs: LrclibRecord[] = []
    try {
      recs = asRecords(await getJson(url))
    } catch {
      continue
    }
    for (const r of recs) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      all.push(r)
    }
    // the structured search usually nails it; only fall through when it was empty
    if (all.length) break
  }
  if (!all.length) return null

  // within a sensible length window, pick the cheapest; if the song's length
  // is known, drop candidates that are wildly off
  const pool = hint.duration
    ? all.filter((r) => !r.duration || Math.abs(r.duration - hint.duration!) <= 15)
    : all
  const pick = (pool.length ? pool : all).sort((a, b) => cost(a, hint.duration) - cost(b, hint.duration))[0]
  return pick ?? null
}
