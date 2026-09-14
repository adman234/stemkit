import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app, net } from 'electron'
import { userDataDir } from './env'

/* anonymous usage heartbeat: one small POST per install per day (first launch,
   then once every 24h). Payload is a random install id plus version/os/arch —
   nothing that identifies the machine or user. The endpoint is a Cloudflare
   Worker (telemetry-worker/ in this repo); STEMKIT_TELEMETRY_URL overrides it
   for testing without a rebuild. */
const TELEMETRY_URL =
  (process.env.STEMKIT_TELEMETRY_URL || 'https://stemkit-stats.danielravina.workers.dev') + '/ping'

const DAY_MS = 24 * 60 * 60 * 1000

interface TelemetryState {
  installId: string
  lastPing: number
}

function stateFile(): string {
  return join(userDataDir(), 'telemetry.json')
}

function loadState(): TelemetryState {
  try {
    const data = JSON.parse(readFileSync(stateFile(), 'utf8'))
    if (typeof data.installId === 'string' && data.installId) {
      return { installId: data.installId, lastPing: Number(data.lastPing) || 0 }
    }
  } catch {}
  return { installId: randomUUID(), lastPing: 0 }
}

function saveState(state: TelemetryState): void {
  try {
    mkdirSync(userDataDir(), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(state, null, 2))
  } catch {}
}

/* fire-and-forget: never let a ping slow startup or log errors */
export function maybePing(): void {
  if (!app.isPackaged) return
  const state = loadState()
  if (Date.now() - state.lastPing < DAY_MS) return

  const payload = JSON.stringify({
    id: state.installId,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    ts: Date.now()
  })

  const req = net.request({
    url: TELEMETRY_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
  // remember the ping only once the server confirmed it, so offline launches
  // retry on the next open instead of silently dropping
  req.on('response', (res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      saveState({ ...state, lastPing: Date.now() })
    }
  })
  req.on('error', () => {})
  req.write(payload)
  req.end()
}