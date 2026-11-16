import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

// the web server's request plumbing (src/server/http.ts): only node built-ins,
// so it loads without the module hooks the other server tests need
const http = await import(new URL('../src/server/http.ts', import.meta.url).href)

const root = mkdtempSync(join(tmpdir(), 'stemkit-server-http-'))
after(() => rmSync(root, { recursive: true, force: true }))

const req = (headers, method = 'POST') => ({ method, headers })

test('parseRange covers open, closed, suffix and impossible ranges', () => {
  assert.equal(http.parseRange(undefined, 100), null)
  assert.equal(http.parseRange('bytes=-', 100), null)
  assert.equal(http.parseRange('items=0-1', 100), null)
  assert.deepEqual(http.parseRange('bytes=0-', 100), { start: 0, end: 99 })
  assert.deepEqual(http.parseRange('bytes=10-19', 100), { start: 10, end: 19 })
  assert.deepEqual(http.parseRange('bytes=90-500', 100), { start: 90, end: 99 }, 'end clamps to the file')
  assert.deepEqual(http.parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(http.parseRange('bytes=-500', 100), { start: 0, end: 99 })
  assert.equal(http.parseRange('bytes=-0', 100), 'unsatisfiable')
  assert.equal(http.parseRange('bytes=100-', 100), 'unsatisfiable')
  assert.equal(http.parseRange('bytes=20-10', 100), 'unsatisfiable')
})

test('isJsonRequest takes json and +json types only', () => {
  assert.equal(http.isJsonRequest(req({ 'content-type': 'application/json' })), true)
  assert.equal(http.isJsonRequest(req({ 'content-type': 'Application/JSON; charset=utf-8' })), true)
  assert.equal(http.isJsonRequest(req({ 'content-type': 'application/merge-patch+json' })), true)
  assert.equal(http.isJsonRequest(req({ 'content-type': 'text/plain' })), false)
  assert.equal(http.isJsonRequest(req({ 'content-type': 'application/x-www-form-urlencoded' })), false)
  assert.equal(http.isJsonRequest(req({})), false)
})

test('isCrossSite refuses other sites and lets the page itself and scripts through', () => {
  // reads are never refused
  assert.equal(http.isCrossSite(req({ 'sec-fetch-site': 'cross-site' }, 'GET')), false)
  // Sec-Fetch-Site decides when present
  assert.equal(http.isCrossSite(req({ 'sec-fetch-site': 'same-origin' })), false)
  assert.equal(http.isCrossSite(req({ 'sec-fetch-site': 'none' })), false)
  assert.equal(http.isCrossSite(req({ 'sec-fetch-site': 'same-site' })), true)
  assert.equal(http.isCrossSite(req({ 'sec-fetch-site': 'cross-site', origin: 'http://tower:8080', host: 'tower:8080' })), true)
  // otherwise Origin against Host
  assert.equal(http.isCrossSite(req({ origin: 'http://tower:8080', host: 'tower:8080' })), false)
  assert.equal(http.isCrossSite(req({ origin: 'http://TOWER:8080', host: 'tower:8080' })), false)
  assert.equal(http.isCrossSite(req({ origin: 'https://evil.example', host: 'tower:8080' })), true)
  assert.equal(http.isCrossSite(req({ origin: 'null', host: 'tower:8080' })), true)
  assert.equal(http.isCrossSite(req({ origin: 'not a url', host: 'tower:8080' })), true)
  // curl and scripts send neither
  assert.equal(http.isCrossSite(req({ host: 'tower:8080' }, 'DELETE')), false)
})

test('hostAllowed lets LAN names through and stops names an outside DNS server controls', () => {
  const none = []
  for (const host of [
    'localhost:8080',
    '127.0.0.1:8080',
    '192.168.1.20',
    '[::1]:8080',
    '[fe80::1]',
    'tower:8080',
    'tower.local',
    'nas.lan:8080',
    'box.home.arpa',
    'stemkit.internal',
    'tower.local.'
  ]) {
    assert.equal(http.hostAllowed(host, none), true, host)
  }
  for (const host of ['evil.example', 'rebind.attacker.com:8080', 'stemkit.example.org', ':8080']) {
    assert.equal(http.hostAllowed(host, none), false, host)
  }
  assert.equal(http.hostAllowed(undefined, none), true, 'no Host is not a browser')

  const allowed = http.parseAllowedHosts(' Stemkit.Example.org , .mydomain.net,,')
  assert.deepEqual(allowed, ['stemkit.example.org', '.mydomain.net'])
  assert.equal(http.hostAllowed('stemkit.example.org', allowed), true)
  assert.equal(http.hostAllowed('STEMKIT.example.org:443', allowed), true)
  assert.equal(http.hostAllowed('music.mydomain.net', allowed), true)
  assert.equal(http.hostAllowed('other.example.org', allowed), false)
  assert.equal(http.hostAllowed('anything.example', http.parseAllowedHosts('*')), true)
})

test('basicCredentials splits on the first colon only', () => {
  const basic = (s) => 'Basic ' + Buffer.from(s).toString('base64')
  assert.deepEqual(http.basicCredentials(basic('me:pa:ss')), { user: 'me', pass: 'pa:ss' })
  assert.deepEqual(http.basicCredentials(basic(':secret')), { user: '', pass: 'secret' })
  assert.equal(http.basicCredentials(basic('nocolon')), null)
  assert.equal(http.basicCredentials('Bearer abc'), null)
  assert.equal(http.basicCredentials(undefined), null)
})

test('compiled routes take one segment per key and treat dots literally', () => {
  const route = http.compileRoute('/api/songs/:videoId/stems/:stem.m4a')
  assert.deepEqual(http.matchRoute(route, '/api/songs/abc123/stems/vocals.m4a'), { videoId: 'abc123', stem: 'vocals' })
  assert.equal(http.matchRoute(route, '/api/songs/abc123/stems/vocalsxm4a'), null)
  assert.equal(http.matchRoute(route, '/api/songs/a/b/stems/vocals.m4a'), null)
  assert.deepEqual(http.matchRoute(http.compileRoute('/healthz'), '/healthz'), {})
})

const body = (chunks, headers = {}) => Object.assign(Readable.from(chunks), { headers })

test('readBodyToFile streams a body to disk', async () => {
  const file = join(root, 'body.bin')
  const size = await http.readBodyToFile(body([Buffer.from('abc'), Buffer.from('def')]), file, 100)
  assert.equal(size, 6)
  assert.equal(readFileSync(file, 'utf8'), 'abcdef')
})

test('readBodyToFile refuses an oversized body and leaves no file behind', async () => {
  const declared = join(root, 'declared.bin')
  await assert.rejects(
    http.readBodyToFile(body([Buffer.alloc(10)], { 'content-length': '1000' }), declared, 100),
    (err) => err instanceof http.HttpError && err.status === 413
  )
  assert.equal(existsSync(declared), false)

  const streamed = join(root, 'streamed.bin')
  await assert.rejects(
    http.readBodyToFile(body([Buffer.alloc(60), Buffer.alloc(60)]), streamed, 100),
    (err) => err instanceof http.HttpError && err.status === 413
  )
  assert.equal(existsSync(streamed), false)
})

test('readBodyToFile turns a dropped upload into a 400 and removes the partial file', async () => {
  const file = join(root, 'dropped.bin')
  const dropped = new Readable({ read() {} })
  dropped.headers = {}
  dropped.push(Buffer.from('partial'))
  setImmediate(() => dropped.destroy(new Error('socket hang up')))
  await assert.rejects(
    http.readBodyToFile(dropped, file, 100),
    (err) => err instanceof http.HttpError && err.status === 400
  )
  assert.equal(existsSync(file), false)
})

test('streamFile serves a range, and a file that vanished ends the response instead of the server', async () => {
  const file = join(root, 'served.txt')
  writeFileSync(file, '0123456789')
  const server = createServer((rq, res) => {
    res.writeHead(200)
    if (rq.url === '/range') http.streamFile(res, file, { start: 2, end: 5 })
    else http.streamFile(res, join(root, 'gone.txt'))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const fetchText = (path) =>
    new Promise((resolve) => {
      const r = request({ host: '127.0.0.1', port, path }, (res) => {
        let text = ''
        res.on('data', (c) => (text += c))
        res.on('end', () => resolve({ text }))
        res.on('error', () => resolve({ aborted: true }))
        res.on('aborted', () => resolve({ aborted: true }))
      })
      r.on('error', () => resolve({ aborted: true }))
      r.end()
    })
  const errors = console.error
  console.error = () => {}
  try {
    assert.deepEqual(await fetchText('/range'), { text: '2345' })
    const gone = await fetchText('/gone')
    assert.ok(gone.aborted || gone.text === '', 'the broken response is cut off')
    // still serving afterwards
    assert.deepEqual(await fetchText('/range'), { text: '2345' })
  } finally {
    console.error = errors
    await new Promise((resolve) => server.close(resolve))
  }
})
