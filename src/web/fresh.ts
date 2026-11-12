import { isPlaying } from '../renderer/src/lib/engine'

/* Phones keep the page alive in memory for days, so after the container
   updates the open tab goes on running the old app: switching back to the
   browser does not fetch the page again, and nothing in the proxy log shows
   it. Each time the page comes back to the foreground it asks the server
   which build is current and reloads if that differs, unless audio is
   playing. A reload that lands on the same stale build is not repeated. */

const TRIED = 'stemkit.reloadedFor'

function currentBuild(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')
  return el ? new URL(el.src).pathname : null
}

async function serverBuild(): Promise<string | null> {
  const res = await fetch('/', { cache: 'no-store', redirect: 'error' })
  if (!res.ok) return null
  return (await res.text()).match(/src="\.?(\/assets\/[^"]+\.js)"/)?.[1] ?? null
}

let checking = false
async function check(): Promise<void> {
  const mine = currentBuild()
  if (!mine || checking || document.visibilityState !== 'visible') return
  checking = true
  try {
    const latest = await serverBuild()
    if (!latest || latest === mine || isPlaying()) return
    let tried: string | null = null
    try {
      tried = sessionStorage.getItem(TRIED)
      sessionStorage.setItem(TRIED, latest)
    } catch {
      // without storage there is no loop guard, so leave the page alone
      return
    }
    if (tried === latest) return
    location.reload()
  } catch {
    // offline, or the proxy wants a sign-in: carry on with what is loaded
  } finally {
    checking = false
  }
}

document.addEventListener('visibilitychange', () => void check())
window.addEventListener('pageshow', (e) => {
  if (e.persisted) void check()
})
void check()
