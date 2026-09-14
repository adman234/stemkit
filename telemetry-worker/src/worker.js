/* Anonymous usage heartbeat collector for StemKit.

   POST /ping  — the app pings once per install per day with a random install
                 id + version/os/arch. No PII, nothing linkable to a person.
   GET  /stats — aggregated counts, guarded by a Bearer token (STATS_TOKEN).

   KV layout (read-modify-write counters; races are acceptable at this scale):
     i:<id>            install record {firstSeen,lastSeen,version,platform,arch}
     d:<date>:<id>     dedupes the daily-active counter (48h TTL)
     c:total           unique installs ever
     c:os:<platform>   installs per platform
     c:ver:<version>   installs per app version
     c:new:<date>      new installs per day
     c:dau:<date>      daily active unique installs
*/

const DAY = 24 * 60 * 60 * 1000
const DAILY_TTL = 45 * 24 * 60 * 60
const DEDUPE_TTL = 48 * 60 * 60

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  })

function today(offset = 0) {
  return new Date(Date.now() - offset * DAY).toISOString().slice(0, 10)
}

export default {
  async fetch(request, env) {
    const { DB } = env
    const incr = async (key, ttl) => {
      const raw = await DB.get(key)
      const next = (parseInt(raw || '0', 10) || 0) + 1
      await DB.put(key, String(next), ttl ? { expirationTtl: ttl } : undefined)
      return next
    }

    const url = new URL(request.url)
    const { pathname } = url

    if (pathname === '/ping' && request.method === 'POST') {
      let body
      try {
        body = await request.json()
      } catch {
        return json({ error: 'bad json' }, 400)
      }
      const id = typeof body.id === 'string' ? body.id : null
      if (!id || id.length > 64) return json({ error: 'bad id' }, 400)

      const version = typeof body.version === 'string' ? body.version.slice(0, 32) : 'unknown'
      const platform = typeof body.platform === 'string' ? body.platform.slice(0, 16) : 'unknown'
      const arch = typeof body.arch === 'string' ? body.arch.slice(0, 16) : 'unknown'
      const now = Date.now()
      const date = today()

      const recKey = `i:${id}`
      const existing = await DB.get(recKey)

      if (!existing) {
        await DB.put(
          recKey,
          JSON.stringify({ firstSeen: now, lastSeen: now, version, platform, arch })
        )
        await incr('c:total')
        await incr(`c:os:${platform}`)
        await incr(`c:ver:${version}`)
        await incr(`c:new:${date}`, DAILY_TTL)
      } else {
        try {
          const rec = JSON.parse(existing)
          rec.lastSeen = now
          rec.version = version
          rec.platform = platform
          rec.arch = arch
          await DB.put(recKey, JSON.stringify(rec))
        } catch {
          await DB.put(
            recKey,
            JSON.stringify({ firstSeen: now, lastSeen: now, version, platform, arch })
          )
        }
      }

      // one daily-active credit per install per day
      const dedupeKey = `d:${date}:${id}`
      if (!(await DB.get(dedupeKey))) {
        await DB.put(dedupeKey, '1', { expirationTtl: DEDUPE_TTL })
        await incr(`c:dau:${date}`, DAILY_TTL)
      }

      return new Response(null, { status: 204 })
    }

    if (pathname === '/stats' && request.method === 'GET') {
      const auth = request.headers.get('Authorization') || ''
      if (auth !== `Bearer ${env.STATS_TOKEN}`) return json({ error: 'forbidden' }, 401)

      const total = parseInt((await DB.get('c:total')) || '0', 10)

      const os = {}
      const versions = {}
      for (const key of (await DB.list({ prefix: 'c:os:' })).keys) {
        os[key.name.slice(5)] = parseInt(await DB.get(key.name), 10)
      }
      for (const key of (await DB.list({ prefix: 'c:ver:' })).keys) {
        versions[key.name.slice(6)] = parseInt(await DB.get(key.name), 10)
      }

      const daily = []
      for (let i = 29; i >= 0; i--) {
        const date = today(i)
        const dau = parseInt((await DB.get(`c:dau:${date}`)) || '0', 10)
        const fresh = parseInt((await DB.get(`c:new:${date}`)) || '0', 10)
        daily.push({ date, active: dau, new: fresh })
      }

      return json({
        totalInstalls: total,
        os,
        versions,
        daily,
        updatedAt: new Date().toISOString()
      })
    }

    return json({ error: 'not found' }, 404)
  }
}