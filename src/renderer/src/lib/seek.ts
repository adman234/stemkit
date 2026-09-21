import { useCallback, useEffect, useRef } from 'react'

/* Seeking is expensive: it restarts every stem's source node and re-renders
   the player around it. A finger dragging across a timeline delivers pointer
   events faster than frames are drawn, especially on a phone, so seeking on
   each one saturates the main thread, the drag stutters and the browser
   eventually cancels the gesture outright.

   Coalescing to the last position of each frame keeps a drag smooth however
   fast the events arrive, and costs nothing at slower rates. */
export function useFrameSeek(onSeek: (seconds: number) => void): (seconds: number) => void {
  const pending = useRef<{ to: number | null; raf: number }>({ to: null, raf: 0 })

  useEffect(() => () => cancelAnimationFrame(pending.current.raf), [])

  return useCallback(
    (seconds: number): void => {
      pending.current.to = seconds
      if (pending.current.raf) return
      pending.current.raf = requestAnimationFrame(() => {
        pending.current.raf = 0
        const to = pending.current.to
        pending.current.to = null
        if (to !== null) onSeek(to)
      })
    },
    [onSeek]
  )
}
