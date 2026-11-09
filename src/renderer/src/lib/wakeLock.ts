import { useEffect, useRef } from 'react'

// the DOM lib shipped with some TypeScript versions has no WakeLock types
interface Sentinel {
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}
interface WakeLockApi {
  request: (type: 'screen') => Promise<Sentinel>
}

function api(): WakeLockApi | null {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return null
  return (navigator as unknown as { wakeLock: WakeLockApi }).wakeLock
}

/* Playing through Web Audio does not keep a phone screen on, so the screen
   dims and locks mid song. The wake lock holds it awake while `active`. The
   API only exists in secure contexts, so it is absent on a plain http LAN
   address: `supported` says so. The browser drops the lock whenever the page
   is hidden, so it is asked for again when the page comes back. */
export function useWakeLock(active: boolean): { supported: boolean } {
  const sentinel = useRef<Sentinel | null>(null)
  const supported = api() !== null

  useEffect(() => {
    const wl = api()
    if (!wl || !active) return
    let stopped = false

    const acquire = (): void => {
      if (stopped || sentinel.current || document.visibilityState !== 'visible') return
      wl.request('screen')
        .then((s) => {
          // switched off while the request was in flight, or another request won
          if (stopped || sentinel.current) {
            void s.release().catch(() => {})
            return
          }
          sentinel.current = s
          s.addEventListener('release', () => {
            if (sentinel.current === s) sentinel.current = null
          })
        })
        .catch((err) => {
          // refused (low battery, say): the screen just dims as it would anyway
          console.debug('[stemkit] wake lock refused', err)
        })
    }

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisible)
      const s = sentinel.current
      sentinel.current = null
      if (s) void s.release().catch(() => {})
    }
  }, [active])

  return { supported }
}
