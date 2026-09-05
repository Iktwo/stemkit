import { useCallback, useEffect, useMemo, useState } from 'react'
import { MODEL_EXTENDED, type AppSettings, type Song, type StemId } from '../../../shared/types'
import { usePlayer, clearBufferCache } from '../lib/PlayerContext'
import { buildStemMeta, STEM_INFO, PREFERRED_ORDER } from '../lib/stems'
import { fmtTime } from '../lib/format'
import { Thumb } from '../lib/thumbs'
import { StemLane } from './StemLane'
import { Transport } from './Transport'
import { DownloadIcon, ExternalIcon, RefreshIcon, XIcon } from './Icons'

export { clearBufferCache }

interface Props {
  song: Song
  settings?: AppSettings
  onReprocess?: (videoId: string, model: string, stems: string[]) => void
}

export function Player({ song, settings, onReprocess }: Props): React.ReactElement {
  void settings
  const {
    playing,
    duration,
    decoding,
    decodeError,
    buffers,
    vols,
    mutes,
    solos,
    master,
    preset,
    getPosition,
    loadSong,
    togglePlay,
    seekTo,
    setStemVolume,
    toggleStemMute,
    toggleStemSolo,
    setMasterVolume,
    applyPreset,
    stopAndClose
  } = usePlayer()

  // Reprocess modal state
  const [showReprocess, setShowReprocess] = useState(false)
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

  // Load song if not already loaded
  useEffect(() => {
    void loadSong(song)
  }, [song.videoId, song.model, loadSong])

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
    stopAndClose()
    setShowReprocess(false)
    onReprocess?.(song.videoId, MODEL_EXTENDED, ordered)
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-gradient-to-b from-[#11130d] to-[#0a0c08]">
      <div className="flex-1 overflow-y-auto px-8 py-6">
        <div className="max-w-5xl mx-auto space-y-4">
          <div className="glass rounded-2xl p-6 rise-in flex flex-col md:flex-row gap-6 items-start md:items-center justify-between">
            <div className="flex items-center gap-5 min-w-0 flex-1">
              <Thumb
                videoId={song.videoId}
                className="w-36 h-24 rounded-xl object-cover bg-white/5 shadow-md shrink-0 ring-1 ring-white/10"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="text-xs px-2.5 py-0.5 rounded-full bg-olive-500/20 text-olive-300 font-semibold uppercase tracking-wider">
                    {stemMeta.length} Stems
                  </span>
                  <span className="text-xs text-white/40 font-mono">
                    BS-RoFormer (SOTA)
                  </span>
                </div>
                <h2 className="text-2xl font-bold leading-snug truncate text-white">{song.title}</h2>
                <p className="text-xs text-white/45 mt-1 font-mono truncate">
                  {fmtTime(duration || song.duration)} · added {addedLabel}
                  {song.took ? ` · split in ${fmtTime(song.took)}` : ''}
                </p>
                <div className="flex items-center gap-x-5 gap-y-1.5 flex-wrap mt-3">
                  {stemMeta.map((meta) => (
                    <span key={meta.id} className="flex items-center gap-1.5 text-xs text-white/70">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} />
                      <span className="capitalize">{meta.label}</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
              <button
                onClick={() => setShowReprocess(true)}
                className="no-drag glass rounded-xl px-4 py-2.5 text-[13px] font-medium text-olive-200 hover:text-white hover:bg-olive-500/20 border border-olive-400/30 transition-all flex items-center gap-2 cursor-pointer"
                title="Reprocess this track with SOTA BS-RoFormer or new stems"
              >
                <RefreshIcon className="w-3.5 h-3.5" />
                Reprocess Stems
              </button>
              <button
                onClick={exportAllStems}
                disabled={decoding || !!decodeError}
                className="no-drag glass rounded-xl px-4 py-2.5 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-2 disabled:opacity-40 cursor-pointer"
              >
                <DownloadIcon className="w-4 h-4" />
                Export everything
              </button>
              <button
                onClick={() => window.stemkit.openExternal(youtubeUrl)}
                className="no-drag glass rounded-xl px-4 py-2.5 text-[13px] font-medium text-white/70 hover:text-white hover:bg-white/10 transition-colors flex items-center gap-2 cursor-pointer"
                title="Open original video on YouTube"
              >
                <ExternalIcon className="w-3.5 h-3.5" />
                YouTube
              </button>
            </div>
          </div>

          {decodeError && (
            <div className="glass rounded-xl px-4 py-3 text-xs text-rose-300 border border-rose-500/20 flex items-center gap-2 rise-in">
              <span>Failed to decode stems: {decodeError}</span>
            </div>
          )}

          <Transport
            playing={playing}
            duration={duration}
            getPosition={getPosition}
            onTogglePlay={togglePlay}
            onSeek={seekTo}
            preset={preset === 'custom' ? 'all' : preset}
            onPreset={applyPreset}
            master={master}
            onMaster={setMasterVolume}
          />

          <div className="mt-4 space-y-2">
            {decoding
              ? [...Array(4)].map((_, i) => (
                  <div
                    key={i}
                    className="glass rounded-xl h-16 animate-pulse"
                    style={{ animationDelay: `${i * 120}ms` }}
                  />
                ))
              : stemMeta.map((meta) => (
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
                onToggleMute={() => toggleStemMute(meta.id)}
                onToggleSolo={() => toggleStemSolo(meta.id)}
                onVolume={(v) => setStemVolume(meta.id, v)}
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
                  <RefreshIcon className="w-5 h-5 text-olive-400" />
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
                Reuses existing audio download — separates with SOTA BS-RoFormer.
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
                  className="no-drag px-4 py-2 rounded-xl text-xs font-semibold bg-olive-500 hover:bg-olive-400 text-white transition-all disabled:opacity-40 flex items-center gap-1.5"
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
