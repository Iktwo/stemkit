import { useEffect, useRef, useState } from 'react'
import {
  MODEL_STANDARD,
  MODEL_EXTENDED,
  DEFAULT_STEMS,
  type SearchResult,
  type Song,
  type StemId
} from '../../../shared/types'
import { parseVideoId } from '../../../shared/url'
import { STEM_INFO, PREFERRED_ORDER } from '../lib/stems'
import { fmtTime } from '../lib/format'

interface Props {
  hasSongs: boolean
  songs: Song[]
  pending?: Record<string, { label: string; error?: boolean }>
  onStart: (url: string, model: string, stems?: string[]) => void
  onSelect: (videoId: string) => void
}

const ALL_STEMS = PREFERRED_ORDER

export function Home({ hasSongs, songs, pending = {}, onStart, onSelect }: Props): React.ReactElement {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<StemId>>(new Set<StemId>(DEFAULT_STEMS as StemId[]))
  const [preferredModel, setPreferredModel] = useState<string>(MODEL_EXTENDED)
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchedFor, setSearchedFor] = useState('')
  const seqRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const usesExtended = [...selected].some((id) => id === 'guitar' || id === 'piano')
  const effectiveModel = usesExtended ? MODEL_EXTENDED : preferredModel
  const orderedSelection = ALL_STEMS.filter((id) => selected.has(id))

  const toggleStem = (id: StemId): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const setPreset = (stems: StemId[]): void => {
    setSelected(new Set<StemId>(stems))
  }

  const startWithSelection = (videoIdOrUrl: string): void => {
    onStart(
      videoIdOrUrl.startsWith('http') ? videoIdOrUrl : `https://www.youtube.com/watch?v=${videoIdOrUrl}`,
      effectiveModel,
      orderedSelection
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
    if (!trimmed || selected.size === 0) return
    if (parseVideoId(trimmed)) {
      startWithSelection(trimmed)
      setQuery('')
      setResults([])
      return
    }
    if (searching) return
    void runSearch(trimmed)
  }

  const startResult = (r: SearchResult): void => {
    startWithSelection(r.videoId)
  }

  return (
    <div className="h-full flex flex-col items-center px-8 pt-[6vh] pb-8 overflow-y-auto bg-gradient-to-b from-[#12121c] to-[#0a0a0e]">
      <div className="w-full max-w-2xl space-y-6">
        {/* Header Hero */}
        <div className="text-center space-y-2">
          <h1 className="text-[32px] font-extrabold tracking-tight leading-tight bg-gradient-to-r from-violet-300 via-white to-emerald-200 bg-clip-text text-transparent">
            Separate any song into isolated stems
          </h1>
          <p className="text-white/45 text-[14px]">
            Powered by SOTA BS-RoFormer — 100% private and processed on your device.
          </p>
        </div>

        {/* Search / Paste Input */}
        <div className="flex gap-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Paste YouTube link or search artist / track title…"
            spellCheck={false}
            className="no-drag flex-1 glass rounded-xl px-4 py-3 text-sm outline-none placeholder:text-white/30 focus:ring-2 focus:ring-violet-400/60 transition-all text-white"
          />
          <button
            onClick={submit}
            disabled={!query.trim() || selected.size === 0}
            className="no-drag px-6 rounded-xl bg-violet-500 hover:bg-violet-400 active:scale-[0.98] text-white text-sm font-semibold transition-all disabled:opacity-40 disabled:hover:bg-violet-500 disabled:active:scale-100 shadow-md shadow-violet-500/25 cursor-pointer"
          >
            {parseVideoId(query) ? 'Split Stems' : 'Search'}
          </button>
        </div>

        {/* Stem & Engine Settings Card */}
        <div className="glass rounded-2xl p-4.5 border border-white/10 space-y-3.5">
          {/* Header with Quick Presets */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-white/40">
                Instruments
              </span>
              <span className="text-[11px] font-semibold text-violet-300 bg-violet-500/15 px-2 py-0.5 rounded-full border border-violet-500/25">
                {selected.size === 0
                  ? 'select at least 1'
                  : usesExtended
                    ? `BS-RoFormer SOTA · ${selected.size} stems`
                    : `${effectiveModel === MODEL_EXTENDED ? 'BS-RoFormer SOTA' : 'Demucs FT'} · ${selected.size} stems`}
              </span>
            </div>

            {/* Quick Presets */}
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-white/30 mr-0.5">Presets:</span>
              <button
                type="button"
                onClick={() => setPreset(ALL_STEMS as StemId[])}
                className="px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              >
                All 6
              </button>
              <button
                type="button"
                onClick={() => setPreset(['piano', 'guitar'])}
                className="px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              >
                Piano & Guitar
              </button>
              <button
                type="button"
                onClick={() => setPreset(['vocals', 'drums', 'bass', 'other'])}
                className="px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              >
                Standard 4
              </button>
              <button
                type="button"
                onClick={() => setPreset(['piano'])}
                className="px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors"
              >
                Solo Piano
              </button>
            </div>
          </div>

          {/* Instrument Pills */}
          <div className="flex items-center gap-2 flex-wrap">
            {ALL_STEMS.map((id) => {
              const info = STEM_INFO[id]
              const on = selected.has(id)
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleStem(id)}
                  className={`no-drag flex items-center gap-2 rounded-xl px-3.5 py-2 text-[12px] font-medium capitalize border transition-all cursor-pointer ${
                    on
                      ? 'border-transparent shadow-sm'
                      : 'border-white/[0.08] bg-white/[0.03] text-white/35 hover:text-white/60 hover:border-white/20'
                  }`}
                  style={
                    on
                      ? {
                          background: `${info.color}22`,
                          color: info.color,
                          boxShadow: `inset 0 0 0 1px ${info.color}66`
                        }
                      : undefined
                  }
                >
                  <span
                    className="w-2 h-2 rounded-full transition-opacity"
                    style={{ background: info.color, opacity: on ? 1 : 0.3 }}
                  />
                  {info.label}
                </button>
              )
            })}
          </div>

          {/* Engine Selector */}
          <div className="pt-2 border-t border-white/[0.08] flex items-center justify-between flex-wrap gap-2">
            <span className="text-[11px] text-white/40">Separation Engine:</span>
            <div className="flex items-center gap-1 bg-black/40 p-0.5 rounded-lg border border-white/10">
              <button
                type="button"
                onClick={() => setPreferredModel(MODEL_EXTENDED)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                  effectiveModel === MODEL_EXTENDED
                    ? 'bg-violet-500 text-white shadow-sm'
                    : 'text-white/40 hover:text-white'
                }`}
              >
                BS-RoFormer (SOTA 6-source)
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreferredModel(MODEL_STANDARD)
                  setSelected(new Set(['vocals', 'drums', 'bass', 'other'] as StemId[]))
                }}
                className={`px-2.5 py-1 rounded-md text-[11px] font-semibold transition-all ${
                  effectiveModel === MODEL_STANDARD
                    ? 'bg-emerald-500 text-white shadow-sm'
                    : 'text-white/40 hover:text-white'
                }`}
              >
                Demucs FT (4-source)
              </button>
            </div>
          </div>
        </div>

        {/* Search Results Area */}
        {(searching || searchError || results.length > 0) && (
          <div className="space-y-3">
            {searching && (
              <div className="space-y-2">
                {[...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="glass rounded-xl h-[56px] animate-pulse"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))}
              </div>
            )}
            {!searching && searchError && (
              <div className="rounded-xl bg-rose-500/10 border border-rose-400/20 px-4 py-3 text-[13px] text-rose-200">
                Search failed: {searchError}
              </div>
            )}
            {!searching && !searchError && results.length > 0 && (
              <div className="space-y-1.5 rise-in">
                <p className="text-[11px] uppercase tracking-wider text-white/40 font-bold px-1 mb-1">
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
                      onClick={() => (inProgress || failed || saved ? onSelect(r.videoId) : startResult(r))}
                      className="no-drag group w-full flex items-center gap-3.5 rounded-xl p-2 bg-white/[0.03] hover:bg-white/[0.08] border border-white/5 hover:border-white/15 transition-all cursor-pointer"
                    >
                      <div className="relative shrink-0">
                        <img
                          src={`https://i.ytimg.com/vi/${r.videoId}/default.jpg`}
                          alt=""
                          className="w-[72px] h-[40px] rounded-lg object-cover bg-white/5 shadow-sm"
                          draggable={false}
                        />
                        {typeof r.duration === 'number' && r.duration > 0 && (
                          <span className="absolute bottom-1 right-1 bg-black/80 rounded text-[9px] font-mono px-1">
                            {fmtTime(r.duration)}
                          </span>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium truncate text-white/90 group-hover:text-white">
                          {r.title}
                        </span>
                        <span className="block text-[11px] text-white/40 mt-0.5">{r.channel}</span>
                      </div>
                      {inProgress ? (
                        <div className="shrink-0 flex items-center gap-2 pr-2 text-violet-300">
                          <span className="text-[11px] font-medium max-w-[130px] truncate">{p!.label}</span>
                          <span className="w-3.5 h-3.5 rounded-full border-2 border-white/20 border-t-violet-300 animate-spin" />
                        </div>
                      ) : failed ? (
                        <span className="shrink-0 pr-2 text-[11px] font-semibold text-rose-300">
                          Failed — view
                        </span>
                      ) : saved ? (
                        <span className="shrink-0 pr-2 text-[11px] font-semibold text-emerald-300 flex items-center gap-1">
                          ✓ In library
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            startResult(r)
                          }}
                          className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg bg-violet-500/20 text-violet-300 group-hover:bg-violet-500 group-hover:text-white transition-all shadow-sm cursor-pointer"
                        >
                          Split Stems →
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {!hasSongs && results.length === 0 && !searching && (
          <p className="mt-8 text-center text-xs text-white/25 leading-relaxed">
            Fast Apple Silicon MPS separation · Full 6-stem frequency band isolation
          </p>
        )}
      </div>
    </div>
  )
}
