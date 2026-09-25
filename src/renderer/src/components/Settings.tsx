import { useEffect, useState } from 'react'
import type { AppSettings, EngineStatus } from '../../../shared/types'
import { VIDEO_HEIGHTS } from '../../../shared/types'
import { XIcon } from './Icons'

interface Props {
  settings: AppSettings
  gpu?: boolean
  nvidiaGpu?: boolean
  onChange: (patch: Partial<AppSettings>) => void
  onClose: () => void
}

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button
      onClick={onClick}
      role="switch"
      aria-checked={on}
      className={`no-drag relative shrink-0 w-10 h-6 rounded-full transition-colors ${
        on ? 'bg-violet-500' : 'bg-white/10 hover:bg-white/15'
      }`}
    >
      <span
        className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
          on ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  )
}

function SectionHeader({ label }: { label: string }): React.ReactElement {
  return <h3 className="text-[11px] font-semibold uppercase tracking-widest text-white/30">{label}</h3>
}

function fmtSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

export function Settings({ settings, gpu, nvidiaGpu, onChange, onClose }: Props): React.ReactElement {
  const [engines, setEngines] = useState<EngineStatus | null>(null)
  const [requested, setRequested] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  // poll so download bars also cover fetches started by a split
  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void window.stemkit.enginesStatus().then((s) => {
        if (!alive) return
        setEngines(s)
        setRequested((prev) => {
          const next = new Set([...prev].filter((id) => !s.models?.find((m) => m.id === id && (m.downloading || m.ready))))
          return next.size === prev.size ? prev : next
        })
      })
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  useEffect(() => {
    return window.stemkit.onEnvEvent((e) => {
      const failed = e.message.match(/^(.+) download failed: (.*)$/)
      if (!failed || e.level !== 'error') return
      const model = engines?.models?.find((m) => failed[1].startsWith(m.name) || (m.id === 'vocals' && /vocals engine/i.test(failed[1])))
      if (model) setErrors((prev) => ({ ...prev, [model.id]: failed[2] }))
    })
  }, [engines])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const gpuLine =
    gpu === true
      ? settings.gpuSplit
        ? 'Splits run on your GPU.'
        : 'GPU acceleration is off, so splits run on the CPU.'
      : gpu === false
        ? 'No usable GPU found, so splits run on the CPU. Quick is the only engine that is fast there.'
        : null

  const download = (id: string): void => {
    setErrors((prev) => {
      const { [id]: _drop, ...rest } = prev
      return rest
    })
    setRequested((prev) => new Set(prev).add(id))
    void window.stemkit.fetchEngine(id)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="rounded-2xl w-full max-w-md mx-4 shadow-2xl rise-in bg-[#16151d] border border-white/[0.08]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/[0.07]">
          <h2 className="text-[14px] font-semibold tracking-tight">Settings</h2>
          <button
            onClick={onClose}
            title="Close"
            className="no-drag w-7 h-7 rounded-lg hover:bg-white/10 text-white/50 hover:text-white flex items-center justify-center transition-colors"
          >
            <XIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-6 max-h-[70vh] overflow-y-auto">
          <section className="space-y-4">
            <SectionHeader label="Separation" />
            <p className="text-[11.5px] text-white/40 leading-relaxed">
              The engine, instruments and quality options are picked for each song on the add song screen.
              {gpuLine ? ` ${gpuLine}` : ''}
            </p>
            {nvidiaGpu && (
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-[13px] font-medium">GPU acceleration</p>
                  <p className="text-[11.5px] text-white/40 leading-relaxed mt-0.5">
                    Split on the NVIDIA GPU. Turn off to force the CPU.
                  </p>
                </div>
                <Toggle on={settings.gpuSplit} onClick={() => onChange({ gpuSplit: !settings.gpuSplit })} />
              </div>
            )}
          </section>

          {engines?.models && (
            <section className="pt-5 border-t border-white/[0.06] space-y-3">
              <SectionHeader label="Models" />
              <p className="text-[11.5px] text-white/40 leading-relaxed">
                Downloaded automatically the first time a split needs them. Fetch them now to skip the wait later.
              </p>
              {engines.models.map((m) => {
                const busy = m.downloading || requested.has(m.id)
                return (
                  <div key={m.id}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium truncate">{m.name}</p>
                        <p className="text-[11px] text-white/35">{fmtSize(m.sizeMb)}</p>
                      </div>
                      {m.ready ? (
                        <span className="shrink-0 text-[11px] font-medium text-emerald-300">✓ Downloaded</span>
                      ) : busy ? (
                        <span className="shrink-0 text-[11px] font-mono text-white/45">
                          {typeof m.pct === 'number' ? `${m.pct}%` : 'starting…'}
                        </span>
                      ) : (
                        <button
                          onClick={() => download(m.id)}
                          className="no-drag shrink-0 px-3 py-1.5 rounded-lg bg-violet-500/90 hover:bg-violet-500 text-white text-[12px] font-semibold transition-colors"
                        >
                          Download
                        </button>
                      )}
                    </div>
                    {busy && !m.ready && (
                      <div className="mt-1.5 h-1 rounded-full bg-white/10 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-violet-400 to-emerald-300 transition-all"
                          style={{ width: `${m.pct ?? 0}%` }}
                        />
                      </div>
                    )}
                    {errors[m.id] && <p className="mt-1 text-[11px] text-rose-300">{errors[m.id]}</p>}
                  </div>
                )
              })}
            </section>
          )}

          <section className="pt-5 border-t border-white/[0.06] space-y-5">
            <SectionHeader label="Playback" />
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Pause when you switch away</p>
                <p className="text-[11.5px] text-white/40 leading-relaxed mt-0.5">
                  On a phone or tablet, playing stops when you leave for another app, instead of carrying on out
                  of sight. Desktop browsers are left alone.
                </p>
              </div>
              <Toggle
                on={settings.pauseWhenHidden}
                onClick={() => onChange({ pauseWhenHidden: !settings.pauseWhenHidden })}
              />
            </div>

            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">Video quality</p>
                <p className="text-[11.5px] text-white/40 leading-relaxed mt-0.5">
                  For songs split with Video picked on the add song screen. Taller looks better and takes more
                  disk space.
                </p>
              </div>
              <div className="flex shrink-0 rounded-lg bg-white/[0.06] p-0.5 border border-white/[0.08]">
                {VIDEO_HEIGHTS.map((h) => (
                  <button
                    key={h}
                    onClick={() => onChange({ videoHeight: h })}
                    className={`no-drag px-2.5 h-6 rounded-md text-[12px] font-semibold transition-colors ${
                      settings.videoHeight === h ? 'bg-white text-black' : 'text-white/45 hover:text-white/80'
                    }`}
                  >
                    {h}p
                  </button>
                ))}
              </div>
            </div>

          </section>
        </div>
      </div>
    </div>
  )
}
