import { broadcast } from './events'

/* Stand-in for the 'electron' module when the desktop main-process modules
   (library, settings, thumbs, pipeline) are bundled into the web server.
   scripts/build-server.mjs aliases 'electron' to this file, so those modules
   run unchanged: a "window" send becomes a server-sent event to every tab */

const webWindow = {
  webContents: {
    send: (channel: string, data: unknown): void => broadcast(channel, data)
  }
}

export const BrowserWindow = {
  getAllWindows: (): (typeof webWindow)[] => [webWindow]
}

export const net = {
  fetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    fetch(input, init)
}
