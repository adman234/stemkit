import { useEffect, useRef, useState } from 'react'
import type { ModelStatus, SearchResult, Song, SplitOptions, StemId } from '../../../shared/types'
import { DEFAULT_SPLIT, engineInfo, ENGINES, estimateSeconds, fmtEstimate, INSTRUMENTS, MODELS, modelsFor, normalizeSplit, optionBlurb, OPTIONS, type OptionId } from '../../../shared/engines'
import { parseVideoId } from '../../../shared/url'
import { STEM_INFO } from '../lib/stems'
import { fmtTime } from '../lib/format'
import { GearIcon } from './Icons'

interface Props {
  songs: Song[]
  pending?: Record<string, { label: string; error?: boolean }>
  // splits run on the GPU (drives the time estimates)
  gpu: boolean
  onStart: (url: string, options: SplitOptions) => void
  onSelect: (videoId: string) => void
  onOpenSettings: () => void
}

// the suffix moves with the defaults: an older stored choice is dropped
// rather than quietly keeping instruments and chords turned off
const SPLIT_KEY = 'stemkit.split.v2'

// pointer: fine means a mouse, where focusing the search box on arrival helps
const AUTOFOCUS =
  typeof window !== 'undefined' && window.matchMedia('(min-width: 768px) and (pointer: fine)').matches

/* the panel keeps option flags even while their instrument is deselected, so
   they come back with it; normalizeSplit applies the rules when splitting */
function loadSplit(): SplitOptions {
  try {
    const stored = localStorage.getItem(SPLIT_KEY)
    // nothing chosen yet: normalizeSplit validates, it does not fill in the
    // optional extras, so the defaults have to come from the defaults
    if (!stored) return { ...DEFAULT_SPLIT, stems: [...DEFAULT_SPLIT.stems] }
    const saved = JSON.parse(stored)
    const split = normalizeSplit(saved)
    return {
      ...split,
      studioVocals: saved?.studioVocals === true,
      drumKit: saved?.drumKit === true
    }
  } catch {
    return normalizeSplit(null)
  }
}

function saveSplit(split: SplitOptions): void {
  try {
    localStorage.setItem(SPLIT_KEY, JSON.stringify(split))
  } catch {}
}

function fmtSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`
}

function Meter({ label, value }: { label: string; value: number }): React.ReactElement {
  return (
    <span className="flex items-center gap-1.5 text-[10.5px] text-white/35">
      <span className="w-[42px]">{label}</span>
      <span className="flex gap-[3px]">
        {[1, 2, 3, 4, 5].map((i) => (
          <span key={i} className={`w-[7px] h-[7px] rounded-full ${i <= value ? 'bg-white/70' : 'bg-white/10'}`} />
        ))}
      </span>
    </span>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.ReactElement {
  return <span className="text-[11px] font-semibold uppercase tracking-widest text-white/30">{children}</span>
}

export function Home({ songs, pending = {}, gpu, onStart, onSelect, onOpenSettings }: Props): React.ReactElement {
  const [query, setQuery] = useState('')
  const [split, setSplitState] = useState<SplitOptions>(loadSplit)
  const [models, setModels] = useState<ModelStatus[]>([])
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchedFor, setSearchedFor] = useState('')
  const seqRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void window.stemkit
      .enginesStatus()
      .then((s) => setModels(s.models ?? []))
      .catch(() => {})
  }, [])

  const updateSplit = (patch: Partial<SplitOptions>): void => {
    setSplitState((prev) => {
      const next = { ...prev, ...patch }
      saveSplit(next)
      return next
    })
  }

  // what a split would actually run with
  const effective = normalizeSplit(split)
  const engine = engineInfo(effective.engine)
  const selected = new Set<StemId>(effective.stems)
  const hasStems = split.stems.length > 0
  const notDownloaded = (ids: string[]): number =>
    ids
      .filter((id) => !models.find((m) => m.id === id)?.ready)
      .reduce((sum, id) => sum + MODELS[id as keyof typeof MODELS].sizeMb, 0)
  const pendingDownloadMb = notDownloaded(modelsFor(effective))

  const toggleStem = (id: StemId): void => {
    updateSplit({ stems: split.stems.includes(id) ? split.stems.filter((s) => s !== id) : [...split.stems, id] })
  }

  const toggleOption = (id: OptionId): void => {
    updateSplit({ [id]: !effective[id] })
  }

  const startWithSelection = (videoIdOrUrl: string): void => {
    if (!hasStems) return
    onStart(
      videoIdOrUrl.startsWith('http') ? videoIdOrUrl : `https://www.youtube.com/watch?v=${videoIdOrUrl}`,
      effective
    )
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  const runSearch = async (q: string): Promise<void> => {
    const seq = ++seqRef.current
    setSearching(true)
    setSearchError(null)
    try {
      const res = await window.stemkit.searchYouTube(q)
      if (seqRef.current === seq) {
        setResults(res)
        setSearchedFor(q)
      }
    } catch (err) {
      if (seqRef.current === seq) {
        setSearchError(err instanceof Error ? err.message : String(err))
        setResults([])
      }
    } finally {
      if (seqRef.current === seq) setSearching(false)
    }
  }

  const handleInput = (value: string): void => {
    setQuery(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    const trimmed = value.trim()
    if (!trimmed || parseVideoId(trimmed)) {
      setResults([])
      setSearchError(null)
      setSearching(false)
      return
    }
    debounceRef.current = setTimeout(() => void runSearch(trimmed), 450)
  }

  const submit = (): void => {
    const trimmed = query.trim()
    if (!trimmed || !hasStems) return
    if (parseVideoId(trimmed)) {
      startWithSelection(trimmed)
      setQuery('')
      setResults([])
      return
    }
    if (searching) return
    void runSearch(trimmed)
  }

  return (
    <div className="h-full flex flex-col items-center px-3 md:px-8 pt-6 md:pt-[6vh] pb-6 overflow-y-auto">
      <div className="w-full max-w-2xl xl:max-w-4xl">
        <h1 className="text-center text-[22px] md:text-[30px] font-bold tracking-tight leading-tight bg-gradient-to-r from-violet-300 via-white to-emerald-200 bg-clip-text text-transparent">
          Turn any YouTube track into stems.
        </h1>
        <p className="text-center text-white/45 mt-2.5 text-[14px]">
          Search YouTube or paste a link, then pick an engine and the instruments you want.
        </p>

        <div className="mt-6 flex gap-2">
          {/* autofocus on a phone takes the field without opening the keyboard,
              so the first tap on it then does nothing */}
          <input
            autoFocus={AUTOFOCUS}
            value={query}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Search YouTube or paste a link…"
            spellCheck={false}
            className="no-drag flex-1 glass rounded-xl px-4 py-3 text-sm outline-none placeholder:text-white/25 focus:ring-2 focus:ring-violet-400/60 transition-shadow"
          />
          <button
            onClick={submit}
            disabled={!query.trim() || !hasStems}
            className="no-drag px-5 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 active:scale-[0.98] transition-all disabled:opacity-40 disabled:hover:bg-white disabled:active:scale-100"
          >
            {parseVideoId(query) ? 'Split' : 'Search'}
          </button>
        </div>

        <div className="mt-3.5 glass rounded-2xl px-4 py-3.5 space-y-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <SectionLabel>Engine</SectionLabel>
              <button
                onClick={onOpenSettings}
                title="Settings"
                className="no-drag w-5 h-5 rounded-md hover:bg-white/10 text-white/35 hover:text-white flex items-center justify-center transition-colors"
              >
                <GearIcon className="w-3 h-3" />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ENGINES.map((e) => {
                const on = e.id === effective.engine
                const downloadMb = e.id === 'best' ? notDownloaded(['sw']) : 0
                return (
                  <button
                    key={e.id}
                    onClick={() => updateSplit({ engine: e.id })}
                    className={`no-drag text-left rounded-xl px-3.5 py-3 border transition-colors ${
                      on ? 'border-violet-400/60 bg-violet-500/[0.12]' : 'border-white/[0.07] bg-white/[0.02] hover:border-white/20'
                    }`}
                  >
                    <span className="flex items-baseline justify-between gap-2">
                      <span className={`text-[14px] font-semibold ${on ? 'text-white' : 'text-white/75'}`}>{e.name}</span>
                      <span className="text-[10.5px] text-white/35 font-mono truncate">{e.model}</span>
                    </span>
                    <span className="mt-2 flex flex-col gap-1">
                      <Meter label="Quality" value={e.quality} />
                      <Meter label="Speed" value={e.speed} />
                    </span>
                    <span className="block mt-2 text-[11.5px] leading-snug text-white/45">{e.blurb}</span>
                    <span
                      className="block mt-1.5 text-[10.5px] text-white/30 font-mono"
                      title="Median SDR on the 50 MUSDB18 test clips, averaged over vocals, drums, bass and other. Higher is cleaner."
                    >
                      score {e.score.toFixed(1)} dB
                      {downloadMb > 0 ? ` · ${fmtSize(downloadMb)} download` : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <SectionLabel>Instruments</SectionLabel>
              <span className="text-[11px] text-white/30 font-medium">
                {hasStems ? `${split.stems.length} selected` : 'select at least one'}
              </span>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {INSTRUMENTS.map((id) => {
                const info = STEM_INFO[id]
                const on = selected.has(id)
                const rough = engine.roughStems.includes(id)
                return (
                  <button
                    key={id}
                    onClick={() => toggleStem(id)}
                    title={rough ? `${engine.name} makes a rough ${info.label} stem; Best is much cleaner` : undefined}
                    className={`no-drag flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium capitalize border transition-all ${
                      on
                        ? 'border-transparent'
                        : 'border-white/[0.08] bg-white/[0.03] text-white/35 hover:text-white/60 hover:border-white/20'
                    }`}
                    style={
                      on
                        ? { background: `${info.color}1f`, color: info.color, boxShadow: `inset 0 0 0 1px ${info.color}55` }
                        : undefined
                    }
                  >
                    <span
                      className="w-1.5 h-1.5 rounded-full transition-opacity"
                      style={{ background: info.color, opacity: on ? 1 : 0.3 }}
                    />
                    {info.label}
                    {rough && <span className="normal-case text-[10px] opacity-60">rough</span>}
                  </button>
                )
              })}
            </div>
          </div>

          <div>
            <SectionLabel>Options</SectionLabel>
            <div className="mt-1.5 space-y-0.5">
              {OPTIONS.map((opt) => {
                const unavailable = !!opt.needs && !selected.has(opt.needs)
                const on = effective[opt.id]
                const downloadMb = notDownloaded(opt.models)
                return (
                  <button
                    key={opt.id}
                    onClick={() => !unavailable && toggleOption(opt.id)}
                    disabled={unavailable}
                    className="no-drag w-full flex items-start gap-3 rounded-lg px-1.5 py-1.5 text-left hover:bg-white/[0.04] transition-colors disabled:hover:bg-transparent disabled:cursor-not-allowed"
                  >
                    <span
                      className={`mt-0.5 w-4 h-4 shrink-0 rounded-[5px] border flex items-center justify-center transition-colors ${
                        on ? 'bg-violet-500 border-violet-400' : 'border-white/20 bg-white/[0.03]'
                      } ${unavailable ? 'opacity-40' : ''}`}
                    >
                      {on && (
                        <svg viewBox="0 0 12 12" className="w-2.5 h-2.5" fill="none" stroke="white" strokeWidth="2">
                          <path d="M2.5 6.2 5 8.5l4.5-5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                    <span className={`min-w-0 flex-1 ${unavailable ? 'opacity-40' : ''}`}>
                      <span className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-[13px] font-medium text-white/85">{opt.name}</span>
                        {unavailable && opt.needs && (
                          <span className="text-[10.5px] text-white/40">needs {STEM_INFO[opt.needs].label}</span>
                        )}
                        {!unavailable && downloadMb > 0 && (
                          <span className="text-[10.5px] text-white/30">{fmtSize(downloadMb)} download on first use</span>
                        )}
                      </span>
                      <span className="block text-[11.5px] leading-snug text-white/40 mt-0.5">
                        {optionBlurb(opt.id, effective.engine)}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          <p className="pt-3 border-t border-white/[0.06] text-[11.5px] text-white/45">
            About <span className="text-white/80 font-medium">{fmtEstimate(estimateSeconds(effective, 4, gpu))}</span> to
            split a 4-minute song on the {gpu ? 'GPU' : 'CPU'}
            {pendingDownloadMb > 0 ? `, plus a one-time ${fmtSize(pendingDownloadMb)} model download` : ''}.
            {!gpu && estimateSeconds(effective, 4, gpu) > 600 && (
              <span className="text-amber-300/80"> That is slow; the Quick engine is much faster on a CPU.</span>
            )}
          </p>
        </div>

        {(searching || searchError || results.length > 0) && (
          <div className="mt-6">
            {searching && (
              <div className="space-y-2">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="glass rounded-xl h-[52px] animate-pulse" style={{ animationDelay: `${i * 120}ms` }} />
                ))}
              </div>
            )}
            {!searching && searchError && (
              <div className="rounded-xl bg-rose-500/10 border border-rose-400/20 px-4 py-3 text-[13px] text-rose-200">
                Search failed: {searchError}
              </div>
            )}
            {!searching && !searchError && results.length > 0 && (
              <div className="space-y-1 rise-in">
                <p className="text-[11px] uppercase tracking-widest text-white/30 font-semibold mb-2">
                  Results for “{searchedFor}”
                </p>
                {results.map((r) => {
                  const p = pending[r.videoId]
                  const inProgress = !!p && !p.error
                  const failed = !!p?.error
                  const saved = !p && songs.some((s) => s.videoId === r.videoId)
                  return (
                    <div
                      key={r.videoId}
                      className="group w-full flex items-center gap-3 rounded-xl px-2 py-1.5 hover:bg-white/[0.06] transition-colors"
                    >
                      <button
                        onClick={() => (inProgress || failed || saved ? onSelect(r.videoId) : startWithSelection(r.videoId))}
                        title={
                          inProgress
                            ? 'View splitting progress'
                            : failed
                              ? 'View error'
                              : saved
                                ? 'Open from your library'
                                : 'Split into stems'
                        }
                        className="no-drag min-w-0 flex-1 flex items-center gap-3 text-left cursor-pointer"
                      >
                        <span className="relative shrink-0">
                          <img
                            src={`https://i.ytimg.com/vi/${r.videoId}/default.jpg`}
                            alt=""
                            className="w-[67px] h-[38px] rounded-md object-cover bg-white/5"
                            draggable={false}
                          />
                          {typeof r.duration === 'number' && r.duration > 0 && (
                            <span className="absolute bottom-1 right-1 bg-black/80 rounded text-[9px] font-mono px-1">
                              {fmtTime(r.duration)}
                            </span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] truncate text-white/85">{r.title}</span>
                          <span className="block text-[11px] text-white/35 mt-0.5 truncate">
                            {r.channel}
                            {typeof r.duration === 'number' && r.duration > 0 && !saved && !p
                              ? ` · about ${fmtEstimate(estimateSeconds(effective, r.duration / 60, gpu))} to split`
                              : ''}
                          </span>
                        </span>
                      </button>
                      {inProgress ? (
                        <span className="shrink-0 flex items-center gap-2 pr-2 text-violet-300">
                          <span className="text-[11px] font-medium max-w-[120px] truncate">{p!.label}</span>
                          <span className="w-3 h-3 rounded-full border-2 border-white/20 border-t-violet-300 animate-spin" />
                        </span>
                      ) : failed ? (
                        <span className="shrink-0 pr-2 text-[11px] font-medium text-rose-300">failed, view it</span>
                      ) : saved ? (
                        <span className="shrink-0 flex items-center gap-2.5 pr-2">
                          <button
                            onClick={() => startWithSelection(r.videoId)}
                            disabled={!hasStems}
                            title="Split this song again with the engine and options above"
                            className="no-drag text-[11px] font-medium text-violet-300 opacity-100 md:opacity-0 md:group-hover:opacity-100 hover:text-violet-200 transition-opacity"
                          >
                            Split again
                          </button>
                          <span className="text-[11px] font-medium text-emerald-300">✓ In library</span>
                        </span>
                      ) : (
                        <button
                          onClick={() => startWithSelection(r.videoId)}
                          disabled={!hasStems}
                          className="no-drag shrink-0 text-[11px] font-medium text-violet-300 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity pr-2 px-2 py-1 md:px-0 md:py-0 rounded-md bg-violet-500/15 md:bg-transparent"
                        >
                          Split →
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
