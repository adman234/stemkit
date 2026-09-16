import type { ServerResponse } from 'http'
import type { JobEvent, JobProgress } from '../shared/types'

/* Server-sent events hub. Everything the Electron main process pushed to the
   window over IPC (job progress, env log lines, settings changes, thumbnail
   cache hits) is broadcast here to every open browser tab instead */

interface Envelope {
  channel: string
  data: unknown
}

const clients = new Set<ServerResponse>()

// latest progress per running job, replayed to tabs that connect mid-split
// so a page refresh does not lose the progress bars
const activeJobs = new Map<string, JobProgress>()

function write(res: ServerResponse, envelope: Envelope): void {
  res.write(`data: ${JSON.stringify(envelope)}\n\n`)
}

export function broadcast(channel: string, data: unknown): void {
  if (channel === 'job:event') {
    const ev = data as JobEvent
    if (ev.kind === 'progress') activeJobs.set(ev.data.videoId, ev.data)
    else activeJobs.delete(ev.data.videoId)
  }
  for (const res of clients) write(res, { channel, data })
}

export function attachClient(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // stops nginx style reverse proxies from buffering the stream
    'X-Accel-Buffering': 'no'
  })
  res.write('retry: 3000\n\n')
  for (const progress of activeJobs.values()) {
    write(res, { channel: 'job:event', data: { kind: 'progress', data: progress } })
  }
  clients.add(res)
  res.on('close', () => clients.delete(res))
}

// keeps idle connections alive through proxies that drop silent streams
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
}, 25000).unref()
