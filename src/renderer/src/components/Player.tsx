import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MODEL_EXTENDED, MODEL_STANDARD, type Song, type StemId } from '../../../shared/types'
import { engine, decodePayload, type BufferMap } from '../lib/engine'
import { buildStemMeta, STEM_INFO, PREFERRED_ORDER } from '../lib/stems'
import { fmtTime } from '../lib/format'
import { YouTubeHost } from '../lib/youtube'
import { StemLane } from './StemLane'
import { Transport, type PresetId } from './Transport'
import { DownloadIcon, RefreshIcon, XIcon } from './Icons'

type BufferCacheMap = BufferMap

const bufferCache = new Map<string, Promise<BufferCacheMap>>()

export function clearBufferCache(videoId?: string): void {
  if (videoId) {
    bufferCache.delete(videoId)
  } else {
    bufferCache.clear()
  }
}

function getDecoded(videoId: string): Promise<BufferCacheMap> {
  let entry = bufferCache.get(videoId)
  if (!entry) {
    entry = window.stemkit
      .getBuffers(videoId)
      .then((payload) => decodePayload(payload))
      .catch((err) => {
        bufferCache.delete(videoId)
        throw err
      })
    bufferCache.set(videoId, entry)
  }
  return entry
}

interface Props {
  song: Song
  onReprocess?: (videoId: string, model: string, stems: string[]) => void
}

export function Player({ song, onReprocess }: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<YouTubeHost | null>(null)
  const posRef = useRef(0)
  const playingRef = useRef(false)
  const videoSyncAtRef = useRef(0)

  const VIDEO_DRIFT_LIMIT = 0.4
  const VIDEO_RESYNC_COOLDOWN = 2000

  const [ytReady, setYtReady] = useState(false)
  const [decoding, setDecoding] = useState(true)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(song.duration || 0)
  const [buffers, setBuffers] = useState<BufferMap>({})

  const [vols, setVols] = useState<Partial<Record<StemId, number>>>({})
  const [mutes, setMutes] = useState<Set<StemId>>(new Set())
  const [solos, setSolos] = useState<Set<StemId>>(new Set())
  const [master, setMaster] = useState(0.9)
  const [preset, setPreset] = useState<PresetId | 'custom'>('all')

  // Reprocess modal state
  const [showReprocess, setShowReprocess] = useState(false)
  const [reprocessModel, setReprocessModel] = useState<string>(song.model || MODEL_EXTENDED)
  const [reprocessStems, setReprocessStems] = useState<Set<StemId>>(
    new Set<StemId>((song.stems as StemId[]) || (PREFERRED_ORDER as StemId[]))
  )

  const stemMeta = useMemo(() => buildStemMeta(Object.keys(buffers) as StemId[]), [buffers])

  const youtubeUrl = `https://www.youtube.com/watch?v=${song.videoId}`
  const addedLabel = new Date(song.addedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })

  useEffect(() => {
    posRef.current = 0
    setPlaying(false)
    playingRef.current = false
    videoSyncAtRef.current = 0
    setYtReady(false)
    setDecodeError(null)
    setBuffers({})
    setDuration(song.duration || 0)
    setVols({})
    setMutes(new Set())
    setSolos(new Set())
    setPreset('all')
    setShowReprocess(false)
    setReprocessModel(song.model || MODEL_EXTENDED)
    setReprocessStems(new Set<StemId>((song.stems as StemId[]) || (PREFERRED_ORDER as StemId[])))
    engine.stopAll()

    let cancelled = false
    setDecoding(true)
    getDecoded(song.videoId)
      .then((decoded) => {
        if (cancelled) return
        setBuffers(decoded)
        engine.setBuffers(decoded)
        setVols(Object.fromEntries(Object.keys(decoded).map((id) => [id, 1])))
        const d = engine.trackDuration()
        if (d > 0) setDuration(d)
        setDecoding(false)
      })
      .catch((err) => {
        if (cancelled) return
        setDecoding(false)
        setDecodeError(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      engine.stopAll()
      hostRef.current?.destroy()
      hostRef.current = null
    }
  }, [song.videoId, song.model])

  useEffect(() => {
    if (!containerRef.current) return
    const host = new YouTubeHost()
    let cancelled = false
    void host
      .mount(containerRef.current, song.videoId, (st) => {
        if (cancelled) return
        if (st === 'playing') {
          if (!playingRef.current) {
            playingRef.current = true
            setPlaying(true)
            const t = host.time()
            posRef.current = t
            engine.setPlaying(true, t)
          }
        } else if (st === 'paused' || st === 'ended') {
          if (playingRef.current) {
            playingRef.current = false
            setPlaying(false)
            posRef.current = engine.expected()
            engine.setPlaying(false, posRef.current)
          }
        }
      })
      .then(() => {
        if (cancelled) return
        setYtReady(true)
      })
    hostRef.current = host
    return () => {
      cancelled = true
      host.destroy()
      hostRef.current = null
    }
  }, [song.videoId])

  useEffect(() => {
    engine.applyMix(vols, mutes, solos, master)
  }, [vols, mutes, solos, master])

  useEffect(() => {
    if (!playing) return
    let animId: number
    const checkSync = (): void => {
      const now = performance.now()
      if (
        hostRef.current &&
        ytReady &&
        now - videoSyncAtRef.current > VIDEO_RESYNC_COOLDOWN
      ) {
        const audioPos = engine.expected()
        const videoPos = hostRef.current.time()
        const drift = Math.abs(audioPos - videoPos)
        if (drift > VIDEO_DRIFT_LIMIT) {
          hostRef.current.seek(audioPos)
          videoSyncAtRef.current = now
        }
      }
      animId = requestAnimationFrame(checkSync)
    }
    animId = requestAnimationFrame(checkSync)
    return () => cancelAnimationFrame(animId)
  }, [playing, ytReady])

  const getPosition = useCallback((): number => {
    if (playingRef.current) return engine.expected()
    return posRef.current
  }, [])

  const seekTo = useCallback(
    (t: number): void => {
      posRef.current = t
      engine.align(t)
      hostRef.current?.seek(t)
      videoSyncAtRef.current = performance.now()
    },
    []
  )

  const togglePlay = useCallback((): void => {
    const next = !playingRef.current
    playingRef.current = next
    setPlaying(next)
    if (next) {
      const t = posRef.current
      engine.setPlaying(true, t)
      hostRef.current?.seek(t)
      hostRef.current?.play()
      videoSyncAtRef.current = performance.now()
    } else {
      posRef.current = engine.expected()
      engine.setPlaying(false, posRef.current)
      hostRef.current?.pause()
    }
  }, [])

  const toggleMute = useCallback((id: StemId): void => {
    setMutes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setPreset('custom')
  }, [])

  const toggleSolo = useCallback((id: StemId): void => {
    setSolos((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setPreset('custom')
  }, [])

  const applyPreset = useCallback(
    (p: PresetId): void => {
      setPreset(p)
      const available = Object.keys(buffers) as StemId[]
      const nextMutes = new Set<StemId>()
      const nextSolos = new Set<StemId>()
      if (p === 'all') {
        // all unmuted
      } else if (p === 'karaoke') {
        if (available.includes('vocals')) nextMutes.add('vocals')
      } else if (p === 'acapella') {
        if (available.includes('vocals')) nextSolos.add('vocals')
      } else if (p === 'drumnbass') {
        if (available.includes('drums')) nextSolos.add('drums')
        if (available.includes('bass')) nextSolos.add('bass')
      }
      setMutes(nextMutes)
      setSolos(nextSolos)
    },
    [buffers]
  )

  const exportStem = useCallback(
    async (id: StemId): Promise<void> => {
      try {
        await window.stemkit.exportStem(song.videoId, id)
      } catch (err) {
        alert(err instanceof Error ? err.message : String(err))
      }
    },
    [song.videoId]
  )

  const exportAllStems = useCallback(async (): Promise<void> => {
    try {
      const res = await window.stemkit.exportAllStems(song.videoId)
      if (res.saved && res.count) {
        // quiet success
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }, [song.videoId])

  const toggleReprocessStem = (id: StemId): void => {
    setReprocessStems((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleStartReprocess = (): void => {
    if (reprocessStems.size === 0) return
    const ordered = PREFERRED_ORDER.filter((id) => reprocessStems.has(id))
    clearBufferCache(song.videoId)
    setShowReprocess(false)
    onReprocess?.(song.videoId, reprocessModel, ordered)
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-gradient-to-b from-[#101018] to-[#0a0a0e]">
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-5xl mx-auto space-y-4">
          <div className="flex gap-4">
            <div className="w-[320px] shrink-0 glass rounded-2xl p-2.5 rise-in flex flex-col">
              <div className="relative w-full aspect-video rounded-xl overflow-hidden bg-black/60 shadow-inner">
                <div ref={containerRef} className="absolute inset-0 [&_iframe]:w-full [&_iframe]:h-full" />
                {!ytReady && (
                  <div className="absolute inset-0 flex items-center justify-center animate-pulse">
                    <span className="text-[10px] text-white/40 tracking-widest uppercase">loading…</span>
                  </div>
                )}
                {decodeError && (
                  <div className="absolute inset-x-3 bottom-3 flex justify-center rise-in">
                    <div className="glass rounded-lg px-3 py-1.5 text-xs text-rose-300 break-words">
                      {decodeError}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <aside className="flex-1 min-w-0 glass rounded-2xl px-6 py-5 rise-in flex flex-col justify-between">
              <div className="flex items-center gap-4">
                <img
                  src={`https://i.ytimg.com/vi/${song.videoId}/mqdefault.jpg`}
                  alt=""
                  className="w-32 h-[72px] rounded-lg object-cover bg-white/5 shrink-0"
                  draggable={false}
                />
                <div className="min-w-0 flex-1">
                  <h3 className="text-xl font-semibold leading-snug truncate">{song.title}</h3>
                  <p className="text-xs text-white/45 mt-1.5 font-mono truncate">
                    {fmtTime(song.duration)} · added {addedLabel} ·{' '}
                    {song.model === 'bs_roformer'
                      ? 'BS-RoFormer (SOTA 6-source)'
                      : song.model === 'htdemucs_6s'
                        ? 'Demucs (6-source)'
                        : song.model === 'htdemucs_ft'
                          ? 'Demucs FT (4-source)'
                          : '4-source engine'}
                  </p>
                </div>
                <span className="shrink-0 text-xs px-3 py-1.5 rounded-full bg-white/5 text-white/50 font-medium">
                  {stemMeta.length} stems
                </span>
              </div>

              <div className="flex items-center gap-x-6 gap-y-2 flex-wrap my-3">
                {stemMeta.map((meta) => (
                  <span key={meta.id} className="flex items-center gap-2 text-[14px] text-white/75">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: meta.color }} />
                    <span className="capitalize">{meta.label}</span>
                  </span>
                ))}
              </div>

              <div className="flex items-center gap-2.5 flex-wrap">
                <button
                  onClick={() => setShowReprocess(true)}
                  className="no-drag glass rounded-xl px-4 py-2.5 text-[13px] font-medium text-violet-200 hover:text-white hover:bg-violet-500/20 border border-violet-400/30 transition-all flex items-center gap-2"
                  title="Reprocess this track with SOTA BS-RoFormer or new stems"
                >
                  <RefreshIcon className="w-3.5 h-3.5" />
                  Reprocess Stems
                </button>
                <button
                  onClick={exportAllStems}
                  disabled={decoding || !!decodeError}
                  className="no-drag glass rounded-xl px-4 py-2.5 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-2 disabled:opacity-40"
                >
                  <DownloadIcon className="w-4 h-4" />
                  Export everything
                </button>
                <button
                  onClick={() => window.stemkit.openExternal(youtubeUrl)}
                  className="no-drag glass rounded-xl px-4 py-2.5 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors"
                >
                  Open on YouTube
                </button>
              </div>
            </aside>
          </div>

          <Transport
            playing={playing}
            duration={duration}
            getPosition={getPosition}
            onTogglePlay={togglePlay}
            onSeek={seekTo}
            preset={preset === 'custom' ? 'all' : preset}
            onPreset={applyPreset}
            master={master}
            onMaster={setMaster}
            youtubeUrl={youtubeUrl}
          />

          <div className="mt-4 space-y-2">
            {stemMeta.map((meta) => (
              <StemLane
                key={meta.id}
                meta={meta}
                buffer={buffers[meta.id] ?? null}
                duration={duration}
                getPosition={getPosition}
                audible={!mutes.has(meta.id) && (solos.size === 0 || solos.has(meta.id))}
                volume={vols[meta.id] ?? 1}
                muted={mutes.has(meta.id)}
                soloed={solos.has(meta.id)}
                onToggleMute={() => toggleMute(meta.id)}
                onToggleSolo={() => toggleSolo(meta.id)}
                onVolume={(v) => setVols((prev) => ({ ...prev, [meta.id]: v }))}
                onSeek={seekTo}
                onExport={() => exportStem(meta.id)}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Reprocess Modal */}
      {showReprocess && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg glass rounded-2xl border border-white/15 p-6 shadow-2xl space-y-5 rise-in">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <RefreshIcon className="w-5 h-5 text-violet-400" />
                  Reprocess Track
                </h2>
                <p className="text-xs text-white/45 mt-0.5 max-w-sm truncate">{song.title}</p>
              </div>
              <button
                onClick={() => setShowReprocess(false)}
                className="no-drag text-white/40 hover:text-white p-1 rounded-lg hover:bg-white/10 transition-colors"
              >
                <XIcon className="w-4 h-4" />
              </button>
            </div>

            {/* Model Selection */}
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-widest text-white/40 mb-2">
                Separation Engine
              </label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setReprocessModel(MODEL_EXTENDED)}
                  className={`no-drag text-left p-3 rounded-xl border transition-all ${
                    reprocessModel === MODEL_EXTENDED
                      ? 'border-violet-400/80 bg-violet-500/15 text-white ring-1 ring-violet-400/40'
                      : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <div className="font-semibold text-[13px] flex items-center gap-1.5">
                    BS-RoFormer
                    <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-violet-400/20 text-violet-300">
                      SOTA
                    </span>
                  </div>
                  <div className="text-[11px] text-white/40 mt-1 leading-tight">
                    6-source Band-Split Transformer. Best for piano & guitar isolation.
                  </div>
                </button>

                <button
                  onClick={() => setReprocessModel(MODEL_STANDARD)}
                  className={`no-drag text-left p-3 rounded-xl border transition-all ${
                    reprocessModel === MODEL_STANDARD
                      ? 'border-emerald-400/80 bg-emerald-500/15 text-white ring-1 ring-emerald-400/40'
                      : 'border-white/10 bg-white/5 text-white/60 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <div className="font-semibold text-[13px] flex items-center gap-1.5">
                    Demucs FT
                    <span className="text-[9px] uppercase font-mono px-1.5 py-0.5 rounded bg-emerald-400/20 text-emerald-300">
                      Fast
                    </span>
                  </div>
                  <div className="text-[11px] text-white/40 mt-1 leading-tight">
                    Fine-tuned 4-source Demucs model (vocals, drums, bass, other).
                  </div>
                </button>
              </div>
            </div>

            {/* Stem Selection */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-[11px] font-semibold uppercase tracking-widest text-white/40">
                  Instruments to Extract
                </label>
                <div className="flex items-center gap-1.5 text-[11px]">
                  <button
                    onClick={() => setReprocessStems(new Set(PREFERRED_ORDER as StemId[]))}
                    className="text-white/45 hover:text-white transition-colors"
                  >
                    All 6
                  </button>
                  <span className="text-white/20">·</span>
                  <button
                    onClick={() => setReprocessStems(new Set(['piano', 'guitar'] as StemId[]))}
                    className="text-white/45 hover:text-white transition-colors"
                  >
                    Piano & Guitar
                  </button>
                  <span className="text-white/20">·</span>
                  <button
                    onClick={() => setReprocessStems(new Set(['vocals', 'drums', 'bass', 'other'] as StemId[]))}
                    className="text-white/45 hover:text-white transition-colors"
                  >
                    Standard 4
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-wrap">
                {PREFERRED_ORDER.map((id) => {
                  const info = STEM_INFO[id]
                  const on = reprocessStems.has(id)
                  return (
                    <button
                      key={id}
                      onClick={() => toggleReprocessStem(id)}
                      className={`no-drag flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] font-medium capitalize border transition-all ${
                        on
                          ? 'border-transparent'
                          : 'border-white/[0.08] bg-white/[0.03] text-white/35 hover:text-white/60 hover:border-white/20'
                      }`}
                      style={
                        on
                          ? {
                              background: `${info.color}1f`,
                              color: info.color,
                              boxShadow: `inset 0 0 0 1px ${info.color}55`
                            }
                          : undefined
                      }
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full transition-opacity"
                        style={{ background: info.color, opacity: on ? 1 : 0.3 }}
                      />
                      {info.label}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="pt-2 border-t border-white/10 flex items-center justify-between">
              <p className="text-[11px] text-white/40">
                Reuses existing audio download — skips straight to separation.
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowReprocess(false)}
                  className="no-drag px-4 py-2 rounded-xl text-xs font-medium text-white/60 hover:text-white hover:bg-white/5 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleStartReprocess}
                  disabled={reprocessStems.size === 0}
                  className="no-drag px-4 py-2 rounded-xl text-xs font-semibold bg-violet-500 hover:bg-violet-400 text-white transition-all disabled:opacity-40 flex items-center gap-1.5"
                >
                  <RefreshIcon className="w-3.5 h-3.5" />
                  Reprocess Track
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
