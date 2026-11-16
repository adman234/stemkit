import { createReadStream, createWriteStream, rmSync } from 'fs'
import type { IncomingMessage, ServerResponse } from 'http'
import { isIP } from 'net'
import { Transform } from 'stream'
import { pipeline } from 'stream/promises'

/* Request plumbing for the web server that needs no app state, kept apart
   from index.ts so it can be tested on its own (tests/server-http.test.mjs) */

// a plain field rather than a parameter property, so node can load this file
// with type stripping alone
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/* ---------- ranges ---------- */

export type RangeResult = { start: number; end: number } | 'unsatisfiable' | null

/* one "bytes=a-b" range against a file of the given size: null when there is
   no usable Range header (serve the whole file), 'unsatisfiable' for a 416 */
export function parseRange(header: string | undefined, size: number): RangeResult {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!m || (!m[1] && !m[2])) return null
  let start: number
  let end: number
  if (!m[1]) {
    // suffix range: the last n bytes
    const n = Number(m[2])
    if (n === 0) return 'unsatisfiable'
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/* ---------- streaming files out ---------- */

/* Pipes a file (or a slice of it) into a response. A read error, such as the
   file going away between the stat and the open because a prune or a delete
   got there first, ends the response instead of throwing an 'error' event
   nothing listens for, which would take the whole server down. */
export function streamFile(res: ServerResponse, file: string, range?: { start: number; end: number }): void {
  pipeline(createReadStream(file, range), res).catch((err: NodeJS.ErrnoException) => {
    // a client that hangs up mid-download is routine
    if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(`[http] streaming ${file}: ${err.message}`)
    res.destroy()
  })
}

/* ---------- streaming bodies in ---------- */

/* writes a request body to a file without holding it in memory; over the
   limit, the partial file is removed and a 413 thrown */
export async function readBodyToFile(req: IncomingMessage, file: string, limit: number): Promise<number> {
  const declared = Number(req.headers['content-length'] ?? NaN)
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'Request body too large')
  let size = 0
  const counter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      size += chunk.length
      if (size > limit) done(new HttpError(413, 'Request body too large'))
      else done(null, chunk)
    }
  })
  try {
    await pipeline(req, counter, createWriteStream(file))
  } catch (err) {
    rmSync(file, { force: true })
    throw err instanceof HttpError ? err : new HttpError(400, 'The upload was interrupted')
  }
  return size
}

/* ---------- JSON bodies ---------- */

/* JSON routes only take a JSON content type. A form or a text/plain fetch
   from another site is a "simple" request the browser sends without asking
   first; application/json is not, so this alone keeps other pages from
   driving the API through a visitor's browser */
export function isJsonRequest(req: IncomingMessage): boolean {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  return type === 'application/json' || type.endsWith('+json')
}

/* ---------- where a request comes from ---------- */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/* A state-changing request a browser sent on behalf of another site. Modern
   browsers say so in Sec-Fetch-Site; older ones only send Origin, which is
   then compared with the Host the request was addressed to. Requests with
   neither (curl, scripts) are not from a browser page and pass. */
export function isCrossSite(req: IncomingMessage): boolean {
  if (SAFE_METHODS.has(req.method ?? 'GET')) return false
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string') return site !== 'same-origin' && site !== 'none'
  const origin = req.headers.origin
  if (!origin) return false
  if (origin === 'null') return true
  try {
    return new URL(origin).host.toLowerCase() !== (req.headers.host ?? '').toLowerCase()
  } catch {
    return true
  }
}

/* Host names this server answers to, as a guard against DNS rebinding: a page
   on some other site points its own name at this server's address and is
   then "same-origin" with it. That only matters when there is no password
   (the browser does not hand the page a login it was never given), and only
   names that can be re-pointed by an outside DNS server are at risk, so by
   default IP addresses, localhost, bare host names (an Unraid server's
   "tower") and the usual home-network suffixes are let through. Anything
   else, such as a reverse proxy's public name, goes in STEMKIT_ALLOWED_HOSTS
   (comma separated; "*" turns the check off). */
const LAN_SUFFIXES = ['.local', '.lan', '.home', '.home.arpa', '.internal', '.localdomain', '.localhost']

export function parseAllowedHosts(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
}

export function hostName(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase()
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']') > 0 ? host.indexOf(']') : undefined)
  const colon = host.lastIndexOf(':')
  return colon >= 0 && host.indexOf(':') === colon ? host.slice(0, colon) : host
}

export function hostAllowed(hostHeader: string | undefined, allowed: string[]): boolean {
  if (allowed.includes('*')) return true
  // HTTP/1.1 requires a Host; a request without one did not come from a browser
  if (!hostHeader) return true
  const name = hostName(hostHeader).replace(/\.$/, '')
  if (!name) return false
  if (allowed.includes(name) || allowed.some((a) => a.startsWith('.') && name.endsWith(a))) return true
  if (isIP(name)) return true
  if (name === 'localhost' || !name.includes('.')) return true
  return LAN_SUFFIXES.some((suffix) => name.endsWith(suffix))
}

/* ---------- auth ---------- */

/* the user and password from a Basic Authorization header, or null */
export function basicCredentials(header: string | undefined): { user: string; pass: string } | null {
  if (!header?.startsWith('Basic ')) return null
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0) return null
  return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) }
}

/* ---------- routing ---------- */

export type Params = Record<string, string>

/* a path like /api/songs/:videoId/stems/:stem.m4a as a matcher: each :key
   takes one path segment, dots are literal */
export function compileRoute(path: string): { pattern: RegExp; keys: string[] } {
  const keys: string[] = []
  const pattern = new RegExp(
    '^' +
      path.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_m, key: string) => {
        keys.push(key)
        return '([^/]+)'
      }) +
      '$'
  )
  return { pattern, keys }
}

export function matchRoute(route: { pattern: RegExp; keys: string[] }, pathname: string): Params | null {
  const m = pathname.match(route.pattern)
  if (!m) return null
  const params: Params = {}
  route.keys.forEach((key, i) => {
    params[key] = m[i + 1]
  })
  return params
}
