import { useEffect, useRef, useState } from 'react'
import {
  MODEL_EXTENDED,
  DEFAULT_STEMS,
  type AppSettings,
  type PlaylistInfo,
  type SearchResult,
  type Song,
  type StemId
} from '../../../shared/types'
import { parseVideoId, parsePlaylistId } from '../../../shared/url'
import { STEM_INFO, PREFERRED_ORDER } from '../lib/stems'
import { fmtTime } from '../lib/format'
import { GearIcon, GuitarIcon, BassIcon, MicIcon, LoopIcon, FolderIcon, FileAudioIcon, UploadIcon } from './Icons'

interface Props {
  hasSongs: boolean
  songs: Song[]
  pending?: Record<string, { label: string; error?: boolean }>
  settings?: AppSettings
  onStart: (url: string, model: string, stems?: string[]) => void
  onStartLocal: (filePath: string, model: string, stems?: string[]) => void
  onSelect: (videoId: string) => void
  onOpenSettings: () => void
}

const ALL_STEMS = PREFERRED_ORDER

export function Home({
  hasSongs,
  songs,
  pending = {},
  settings: _settings,
  onStart,
  onStartLocal,
  onSelect,
  onOpenSettings
}: Props): React.ReactElement {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<StemId>>(new Set<StemId>(DEFAULT_STEMS as StemId[]))
  const [results, setResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchedFor, setSearchedFor] = useState('')
  const [playlist, setPlaylist] = useState<PlaylistInfo | null>(null)
  const [playlistLoading, setPlaylistLoading] = useState(false)
  const [playlistError, setPlaylistError] = useState<string | null>(null)
  const [playlistChecked, setPlaylistChecked] = useState<Set<string>>(new Set())
  const [isDragging, setIsDragging] = useState(false)
  const dragCounter = useRef(0)
  const seqRef = useRef(0)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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
      MODEL_EXTENDED,
      orderedSelection
    )
  }

  const isLikelyLocalFile = (val: string): boolean => {
    const t = val.trim().replace(/^["']|["']$/g, '')
    if (t.startsWith('file://') || t.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(t)) return true
    return /\.(mp3|wav|flac|m4a|aac|ogg|opus|aiff|aif|alac|wma)$/i.test(t)
  }

  const handleOpenLocal = async (): Promise<void> => {
    try {
      const files = await window.stemkit.pickAudioFiles()
      if (!files || files.length === 0) return
      for (const f of files) {
        onStartLocal(f, MODEL_EXTENDED, orderedSelection)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  const handleDragEnter = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current += 1
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true)
    }
  }

  const handleDragLeave = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current -= 1
    if (dragCounter.current <= 0) {
      setIsDragging(false)
      dragCounter.current = 0
    }
  }

  const handleDragOver = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
  }

  const handleDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    dragCounter.current = 0

    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return

    for (const file of files) {
      const path = window.stemkit.getPathForFile(file)
      if (path) {
        onStartLocal(path, MODEL_EXTENDED, orderedSelection)
      }
    }
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
    const listId = parsePlaylistId(trimmed)
    if (listId) {
      setResults([])
      setSearchError(null)
      setSearching(false)
      setPlaylistError(null)
      setPlaylistLoading(true)
      debounceRef.current = setTimeout(() => void loadPlaylist(trimmed, listId), 450)
      return
    }
    setPlaylist(null)
    setPlaylistLoading(false)
    if (!trimmed || parseVideoId(trimmed) || isLikelyLocalFile(trimmed)) {
      setResults([])
      setSearchError(null)
      setSearching(false)
      return
    }
    debounceRef.current = setTimeout(() => void runSearch(trimmed), 450)
  }

  const loadPlaylist = async (url: string, listId: string): Promise<void> => {
    const seq = ++seqRef.current
    setPlaylistLoading(true)
    setPlaylistError(null)
    try {
      const info = await window.stemkit.fetchPlaylist(url)
      if (seqRef.current !== seq) return
      setPlaylist(info)
      const importable = info.entries
        .filter((e) => !songs.some((s) => s.videoId === e.videoId) && !pending[e.videoId])
        .map((e) => e.videoId)
      setPlaylistChecked(new Set(importable))
    } catch (err) {
      if (seqRef.current !== seq) return
      setPlaylistError(err instanceof Error ? err.message : String(err))
      setPlaylist(null)
    } finally {
      if (seqRef.current === seq) setPlaylistLoading(false)
    }
  }

  const trackStatus = (videoId: string): 'saved' | 'pending' | 'failed' | 'new' => {
    const p = pending[videoId]
    if (p) return p.error ? 'failed' : 'pending'
    if (songs.some((s) => s.videoId === videoId)) return 'saved'
    return 'new'
  }

  const togglePlaylistTrack = (videoId: string): void => {
    if (trackStatus(videoId) !== 'new') return
    setPlaylistChecked((prev) => {
      const next = new Set(prev)
      if (next.has(videoId)) next.delete(videoId)
      else next.add(videoId)
      return next
    })
  }

  const setAllPlaylistChecked = (on: boolean): void => {
    if (!playlist) return
    setPlaylistChecked(
      on
        ? new Set(playlist.entries.filter((e) => trackStatus(e.videoId) === 'new').map((e) => e.videoId))
        : new Set()
    )
  }

  const importSelectedTracks = (): void => {
    if (!playlist) return
    const picked = playlist.entries.filter((e) => playlistChecked.has(e.videoId))
    for (const e of picked) {
      startWithSelection(e.videoId)
    }
    setPlaylistChecked(new Set())
  }

  const submit = (): void => {
    const trimmed = query.trim()
    if (!trimmed || selected.size === 0) return
    if (isLikelyLocalFile(trimmed)) {
      onStartLocal(trimmed, MODEL_EXTENDED, orderedSelection)
      setQuery('')
      setResults([])
      return
    }
    const listId = parsePlaylistId(trimmed)
    if (listId) {
      void loadPlaylist(trimmed, listId)
      return
    }
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
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className="relative h-full flex flex-col items-center px-8 pt-[6vh] pb-8 overflow-y-auto bg-gradient-to-b from-[#12140f] to-[#0a0c08]"
    >
      {/* Drag & Drop Visual Overlay */}
      {isDragging && (
        <div className="absolute inset-4 z-50 bg-black/85 backdrop-blur-md rounded-3xl border-2 border-dashed border-olive-400 flex flex-col items-center justify-center pointer-events-none animate-in fade-in">
          <UploadIcon className="w-12 h-12 text-olive-400 animate-bounce mb-3" />
          <h3 className="text-xl font-bold text-white">Drop music file here</h3>
          <p className="text-xs text-white/50 mt-1">
            Will split with the {orderedSelection.length} selected {orderedSelection.length === 1 ? 'stem' : 'stems'}
          </p>
        </div>
      )}

      <div className="w-full max-w-2xl space-y-6">
        {/* Header Hero */}
        <div className="text-center space-y-2">
          <h1 className="text-[32px] font-extrabold tracking-tight leading-tight bg-gradient-to-r from-olive-300 via-white to-emerald-200 bg-clip-text text-transparent">
            Separate any song into isolated stems
          </h1>
          <p className="text-white/45 text-[14px]">
            Powered by SOTA BS-RoFormer — 100% private and processed on your device.
          </p>
          <div className="flex items-center justify-center gap-2 flex-wrap pt-1">
            {[
              { icon: <GuitarIcon className="w-3 h-3" />, label: 'Guitar tabs', color: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
              { icon: <BassIcon className="w-3 h-3" />, label: 'Bass tabs', color: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
              { icon: <MicIcon className="w-3 h-3" />, label: 'Karaoke lyrics', color: 'text-pink-300 bg-pink-500/10 border-pink-500/20' },
              { icon: <FileAudioIcon className="w-3 h-3" />, label: 'Local audio files', color: 'text-purple-300 bg-purple-500/10 border-purple-500/20' },
              { icon: <LoopIcon className="w-3 h-3" />, label: 'Loop & slow-down practice', color: 'text-sky-300 bg-sky-500/10 border-sky-500/20' }
            ].map((f) => (
              <span
                key={f.label}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${f.color}`}
              >
                {f.icon}
                {f.label}
              </span>
            ))}
          </div>
        </div>

        {/* Search / Paste Input & Open File */}
        <div className="flex gap-2">
          <input
            autoFocus
            value={query}
            onChange={(e) => handleInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Paste YouTube link, audio file path, or search artist / track title…"
            spellCheck={false}
            className="no-drag flex-1 glass rounded-xl px-4 py-3 text-sm outline-none placeholder:text-white/30 focus:ring-2 focus:ring-olive-400/60 transition-all text-white"
          />
          <button
            onClick={submit}
            disabled={!query.trim() || selected.size === 0}
            className="no-drag px-5 rounded-xl bg-olive-500 hover:bg-olive-400 active:scale-[0.98] text-white text-sm font-semibold transition-all disabled:opacity-40 disabled:hover:bg-olive-500 disabled:active:scale-100 shadow-md shadow-olive-500/25 cursor-pointer shrink-0"
          >
            {isLikelyLocalFile(query)
              ? 'Split Audio'
              : parsePlaylistId(query)
              ? 'Load Playlist'
              : parseVideoId(query)
              ? 'Split Stems'
              : 'Search'}
          </button>
          <button
            type="button"
            onClick={handleOpenLocal}
            disabled={selected.size === 0}
            title="Load local music file (MP3, WAV, FLAC, M4A, OGG...)"
            className="no-drag px-3.5 rounded-xl bg-white/10 hover:bg-white/15 text-white/90 hover:text-white text-sm font-semibold transition-all border border-white/5 hover:border-white/15 cursor-pointer flex items-center gap-1.5 shrink-0 disabled:opacity-40"
          >
            <FolderIcon className="w-4 h-4 text-olive-400" />
            <span>Open File</span>
          </button>
        </div>

        {/* Local File Dropzone / Hint Banner */}
        <div
          onClick={handleOpenLocal}
          className="no-drag glass rounded-xl px-4 py-2 border border-dashed border-white/10 hover:border-olive-400/40 hover:bg-white/[0.04] transition-all cursor-pointer flex items-center justify-between group"
        >
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-olive-500/15 border border-olive-500/25 flex items-center justify-center text-olive-300 group-hover:bg-olive-500/25 transition-all">
              <FileAudioIcon className="w-3.5 h-3.5" />
            </div>
            <div>
              <span className="text-xs font-medium text-white/80 group-hover:text-white">
                Drag & drop local music files here
              </span>
              <span className="text-[11px] text-white/35 ml-2">
                (MP3, WAV, FLAC, M4A, OGG, AIFF…)
              </span>
            </div>
          </div>
          <span className="text-[11px] font-medium text-olive-300 group-hover:text-olive-200">
            Browse files →
          </span>
        </div>

        {/* Stem Selection Card */}
        <div className="glass rounded-2xl p-4.5 border border-white/10 space-y-3.5">
          {/* Header with Quick Presets */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-bold uppercase tracking-wider text-white/40">
                Instruments
              </span>
              <span className="text-[11px] font-semibold text-olive-300 bg-olive-500/15 px-2 py-0.5 rounded-full border border-olive-500/25">
                {selected.size === 0
                  ? 'select at least 1'
                  : `${selected.size} ${selected.size === 1 ? 'stem' : 'stems'} selected`}
              </span>
            </div>

            {/* Quick Presets and Settings */}
            <div className="flex items-center gap-1.5 text-[11px]">
              <span className="text-white/30 mr-0.5">Presets:</span>
              <button
                type="button"
                onClick={() => setPreset(ALL_STEMS as StemId[])}
                className="px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors cursor-pointer"
              >
                All 6
              </button>
              <button
                type="button"
                onClick={() => setPreset(['piano', 'guitar'])}
                className="px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors cursor-pointer"
              >
                Piano & Guitar
              </button>
              <button
                type="button"
                onClick={() => setPreset(['vocals', 'drums', 'bass', 'other'])}
                className="px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors cursor-pointer"
              >
                Standard 4
              </button>
              <button
                type="button"
                onClick={() => setPreset(['piano'])}
                className="px-2 py-0.5 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors cursor-pointer"
              >
                Solo Piano
              </button>
              <button
                onClick={onOpenSettings}
                title="Settings"
                className="no-drag ml-1 w-6 h-6 rounded-md hover:bg-white/10 text-white/35 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
              >
                <GearIcon className="w-3.5 h-3.5" />
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
        </div>

        {/* Playlist Detection Panel */}
        {(playlistLoading || playlistError || playlist) && (
          <div className="space-y-2">
            {playlistLoading && (
              <div className="space-y-2">
                <div className="glass rounded-xl h-[52px] animate-pulse" />
                {[...Array(3)].map((_, i) => (
                  <div
                    key={i}
                    className="glass rounded-xl h-[56px] animate-pulse"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))}
              </div>
            )}
            {!playlistLoading && playlistError && (
              <div className="rounded-xl bg-rose-500/10 border border-rose-400/20 px-4 py-3 text-[13px] text-rose-200">
                Playlist lookup failed: {playlistError}
              </div>
            )}
            {!playlistLoading && playlist && (
              <div className="glass rounded-2xl border border-white/10 overflow-hidden rise-in">
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/[0.06]">
                  <div className="min-w-0">
                    <p className="text-[11px] uppercase tracking-wider text-white/40 font-bold">
                      Playlist detected
                    </p>
                    <p className="text-[14px] font-semibold text-white truncate mt-0.5">
                      {playlist.title}
                      <span className="text-white/40 font-normal ml-2">
                        {playlist.entries.length} tracks
                      </span>
                    </p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setAllPlaylistChecked(true)}
                      className="px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors cursor-pointer"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setAllPlaylistChecked(false)}
                      className="px-2 py-1 rounded-md bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors cursor-pointer"
                    >
                      None
                    </button>
                  </div>
                </div>
                <div className="max-h-[340px] overflow-y-auto p-2 space-y-1">
                  {playlist.entries.map((e) => {
                    const st = trackStatus(e.videoId)
                    const checked = playlistChecked.has(e.videoId)
                    return (
                      <div
                        key={e.videoId}
                        onClick={() => togglePlaylistTrack(e.videoId)}
                        className={`group flex items-center gap-3 rounded-xl p-2 border transition-all ${
                          st !== 'new'
                            ? 'opacity-55 cursor-default border-transparent bg-white/[0.02]'
                            : checked
                              ? 'bg-olive-500/[0.08] border-olive-500/25 cursor-pointer'
                              : 'bg-white/[0.03] hover:bg-white/[0.06] border-transparent cursor-pointer'
                        }`}
                      >
                        <span
                          className={`shrink-0 w-4 h-4 rounded-md border flex items-center justify-center text-[10px] font-bold transition-all ${
                            checked
                              ? 'bg-olive-500 border-olive-500 text-white'
                              : 'border-white/25 text-transparent group-hover:border-white/40'
                          }`}
                        >
                          ✓
                        </span>
                        <img
                          src={`https://i.ytimg.com/vi/${e.videoId}/default.jpg`}
                          alt=""
                          className="w-[64px] h-[36px] rounded-lg object-cover bg-white/5 shrink-0"
                          draggable={false}
                        />
                        <div className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium truncate text-white/90">
                            {e.title}
                          </span>
                          <span className="block text-[11px] text-white/40 mt-0.5 truncate">
                            {e.channel}
                            {typeof e.duration === 'number' && e.duration > 0
                              ? ` · ${fmtTime(e.duration)}`
                              : ''}
                          </span>
                        </div>
                        {st === 'saved' && (
                          <span className="shrink-0 pr-1 text-[11px] font-semibold text-emerald-300">
                            ✓ In library
                          </span>
                        )}
                        {st === 'pending' && (
                          <span className="shrink-0 pr-1 flex items-center gap-1.5 text-[11px] font-medium text-olive-300">
                            <span className="w-3 h-3 rounded-full border-2 border-white/20 border-t-olive-300 animate-spin" />
                            {pending[e.videoId]!.label}
                          </span>
                        )}
                        {st === 'failed' && (
                          <span className="shrink-0 pr-1 text-[11px] font-semibold text-rose-300">
                            Failed
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
                <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-white/[0.06]">
                  <span className="text-[11px] text-white/40">
                    {playlistChecked.size} of {playlist.entries.length} selected · queued tracks are
                    split one by one
                  </span>
                  <button
                    type="button"
                    onClick={importSelectedTracks}
                    disabled={playlistChecked.size === 0 || selected.size === 0}
                    className="px-4 py-2 rounded-xl bg-olive-500 hover:bg-olive-400 active:scale-[0.98] text-white text-[13px] font-semibold transition-all disabled:opacity-40 disabled:hover:bg-olive-500 disabled:active:scale-100 shadow-md shadow-olive-500/25 cursor-pointer"
                  >
                    Import {playlistChecked.size}{' '}
                    {playlistChecked.size === 1 ? 'track' : 'tracks'} →
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

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
                        <div className="shrink-0 flex items-center gap-2 pr-2 text-olive-300">
                          <span className="text-[11px] font-medium max-w-[130px] truncate">{p!.label}</span>
                          <span className="w-3.5 h-3.5 rounded-full border-2 border-white/20 border-t-olive-300 animate-spin" />
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
                          className="shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg bg-olive-500/20 text-olive-300 group-hover:bg-olive-500 group-hover:text-white transition-all shadow-sm cursor-pointer"
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
            Fast Apple Silicon MPS separation · Full 6-stem isolation · Tabs transcribed from the isolated guitar and bass, or imported from any MIDI file
          </p>
        )}
      </div>
    </div>
  )
}
