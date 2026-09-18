import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { net, BrowserWindow } from 'electron'
import { userDataDir } from './env'

// mqdefault (320x180) covers every thumbnail slot in the app; library
// thumbnails come from this local cache instead of i.ytimg.com once the
// "hide video" setting is on
const YT_THUMB_URL = 'https://i.ytimg.com/vi/'

const memo = new Map<string, Promise<string | null>>()

function thumbsDir(): string {
  return join(userDataDir(), 'thumbs')
}

function thumbPath(videoId: string): string {
  return join(thumbsDir(), `${videoId}.jpg`)
}

const VALID_ID = /^[\w-]{11}$/

function toDataUrl(buf: Buffer): string {
  return `data:image/jpeg;base64,${buf.toString('base64')}`
}

// called from the split pipeline (metadata stage) so the cache is warm
// before the song ever shows up in the library
export async function cacheThumbnail(videoId: string, url?: string): Promise<void> {
  if (!VALID_ID.test(videoId)) return
  const file = thumbPath(videoId)
  if (existsSync(file)) return
  const source = typeof url === 'string' && /^https:\/\//.test(url) ? url : `${YT_THUMB_URL}${videoId}/mqdefault.jpg`
  try {
    const res = await net.fetch(source, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0) return
    mkdirSync(thumbsDir(), { recursive: true })
    writeFileSync(file, buf)
    memo.delete(videoId)
    // the renderer may have already resolved (and memoized) null for this id
    // before the cache was warm — tell it to look again
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('thumb:cached', videoId)
    }
  } catch {}
}

// resolves to a data URL from the local cache. When the "hide video" setting
// is on, nothing is fetched online — missing thumbs just stay placeholders
export function getThumb(videoId: string): Promise<string | null> {
  if (!VALID_ID.test(videoId)) return Promise.resolve(null)
  let p = memo.get(videoId)
  if (p) return p
  p = (async (): Promise<string | null> => {
    const file = thumbPath(videoId)
    if (existsSync(file)) {
      try {
        return toDataUrl(readFileSync(file))
      } catch {}
    }
    try {
      const res = await net.fetch(`${YT_THUMB_URL}${videoId}/mqdefault.jpg`, {
        signal: AbortSignal.timeout(10000)
      })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length === 0) return null
      mkdirSync(thumbsDir(), { recursive: true })
      writeFileSync(file, buf)
      return toDataUrl(buf)
    } catch {
      return null
    }
  })()
  memo.set(videoId, p)
  return p
}

// settings changed: a previously-returned null may now be servable and the
// other way around, so drop every cached resolution
export function clearThumbMemo(): void {
  memo.clear()
}