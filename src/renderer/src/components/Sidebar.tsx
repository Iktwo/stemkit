import { useState, useMemo } from 'react'
import type { Song } from '../../../shared/types'
import { fmtTime } from '../lib/format'
import { Thumb } from '../lib/thumbs'
import { LogoMark, TrashIcon, PlusIcon, GearIcon } from './Icons'

interface Props {
  songs: Song[]
  activeId: string | null
  playingId?: string | null
  isPlaying?: boolean
  pending?: Record<string, { label: string; error?: boolean }>
  update?: { status: string; version?: string; pct?: number }
  appVersion?: string
  onSelect: (videoId: string) => void
  onDelete: (videoId: string) => void
  onAdd: () => void
  onInstallUpdate: () => void
  onOpenSettings: () => void
}

export function Sidebar({
  songs,
  activeId,
  playingId,
  isPlaying,
  pending = {},
  update,
  appVersion,
  onSelect,
  onDelete,
  onAdd,
  onInstallUpdate,
  onOpenSettings
}: Props): React.ReactElement {
  const [search, setSearch] = useState('')

  const filteredSongs = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return songs
    return songs.filter((s) => (s.title || '').toLowerCase().includes(q))
  }, [songs, search])

  return (
    <aside className="w-[280px] shrink-0 h-full flex flex-col border-r border-white/[0.08] bg-black/30 backdrop-blur-xl select-none">
      {/* Window drag header with branding badge and settings button */}
      <div className="drag-region h-14 shrink-0 flex items-center gap-2.5 pl-[80px] pr-4">
        <LogoMark />
        <span className="font-semibold tracking-tight text-[15px] text-white">StemKit</span>
        <button
          onClick={onOpenSettings}
          title="Settings"
          className="no-drag ml-auto w-7 h-7 rounded-lg bg-white/5 hover:bg-white/10 text-white/50 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
        >
          <GearIcon className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Top Action: New Split */}
      <div className="px-3 pb-3">
        <button
          onClick={onAdd}
          className={`no-drag w-full flex items-center justify-center gap-2 rounded-xl py-2.5 px-4 text-xs font-semibold transition-all shadow-sm ${
            activeId === null
              ? 'bg-olive-500 text-white shadow-olive-500/25 ring-1 ring-olive-400'
              : 'bg-white/10 text-white/90 hover:bg-white/15 hover:text-white'
          }`}
        >
          <PlusIcon className="w-4 h-4" />
          <span>New Track Split</span>
        </button>
      </div>

      {/* Library Header & Search */}
      <div className="px-4 pb-2 pt-1">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-bold uppercase tracking-wider text-white/40">
            Library
          </span>
          <span className="text-[11px] text-white/30 font-mono">
            {songs.length} {songs.length === 1 ? 'track' : 'tracks'}
          </span>
        </div>

        {songs.length > 5 && (
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter library…"
            className="no-drag w-full bg-white/[0.04] border border-white/10 rounded-lg px-2.5 py-1 text-[12px] text-white outline-none placeholder:text-white/25 focus:border-olive-400/50 mb-1"
          />
        )}
      </div>

      {/* Songs List */}
      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-1">
        {songs.length === 0 && (
          <div className="px-4 pt-12 text-center">
            <p className="text-xs text-white/30 leading-relaxed">
              No tracks added yet.
              <br />
              Click <strong className="text-white/60">New Track Split</strong> to isolate stems from any song.
            </p>
          </div>
        )}

        {filteredSongs.map((song) => {
          const active = song.videoId === activeId
          const isCurrentlyPlaying = song.videoId === playingId
          const pendingInfo = pending[song.videoId]
          const working = !!pendingInfo && !pendingInfo.error
          const failed = !!pendingInfo?.error

          return (
            <div
              key={song.videoId}
              onClick={() => onSelect(song.videoId)}
              className={`no-drag group relative flex items-center gap-2.5 rounded-xl p-2 cursor-pointer transition-all border ${
                active
                  ? 'bg-white/[0.12] border-white/15 shadow-sm text-white'
                  : 'border-transparent hover:bg-white/[0.05] text-white/70 hover:text-white'
              }`}
            >
              <div className="relative shrink-0">
                <Thumb
                  videoId={song.videoId}
                  className={`w-12 h-7 rounded-md object-cover bg-white/5 block shadow-sm ${
                    working ? 'opacity-50' : ''
                  }`}
                />
                {working && (
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-olive-300/40 border-t-olive-300 animate-spin" />
                  </span>
                )}
                {!working && isCurrentlyPlaying && isPlaying && (
                  <span className="absolute inset-0 bg-black/50 rounded-md flex items-center justify-center gap-0.5">
                    <span className="w-0.5 h-2.5 bg-olive-400 rounded-full animate-pulse" />
                    <span className="w-0.5 h-3.5 bg-emerald-400 rounded-full animate-pulse [animation-delay:150ms]" />
                    <span className="w-0.5 h-2 bg-olive-400 rounded-full animate-pulse [animation-delay:300ms]" />
                  </span>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium leading-tight truncate">
                  {song.title || song.videoId}
                </span>
                <div className="flex items-center gap-1.5 mt-1">
                  {pendingInfo ? (
                    <span
                      className={`text-[11px] font-medium truncate ${
                        failed ? 'text-rose-300' : 'text-olive-300 animate-pulse'
                      }`}
                    >
                      {failed ? 'Failed' : pendingInfo.label}
                    </span>
                  ) : (
                    <>
                      <span className="text-[10px] text-white/40 font-mono">
                        {fmtTime(song.duration)}
                      </span>
                      <span className="text-white/20 text-[10px]">·</span>
                      {isCurrentlyPlaying ? (
                        <span className={`text-[9px] px-1.5 py-0.2 rounded font-semibold uppercase ${
                          isPlaying
                            ? 'bg-olive-400 text-black shadow-xs'
                            : 'bg-white/10 text-white/70'
                        }`}>
                          {isPlaying ? 'Playing' : 'Paused'}
                        </span>
                      ) : (
                        <span className="text-[9px] px-1.5 py-0.2 rounded font-semibold uppercase bg-olive-500/20 text-olive-300">
                          {song.stems?.length ? `${song.stems.length} stems` : 'SOTA'}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>

              {!working && (
                <button
                  title="Remove from library"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(song.videoId)
                  }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity p-1.5 rounded-lg hover:bg-rose-500/20 text-white/30 hover:text-rose-300"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )
        })}
      </div>

      {/* Footer Status */}
      <div className="shrink-0 border-t border-white/[0.08] px-4 py-3 space-y-2 bg-black/20">
        {update?.status === 'downloaded' && (
          <button
            onClick={onInstallUpdate}
            title="Install the downloaded update"
            className="no-drag w-full flex items-center justify-between rounded-lg bg-emerald-400/15 border border-emerald-400/30 px-3 py-2 text-[12px] text-emerald-200 hover:bg-emerald-400/25 transition-colors"
          >
            <span>v{update.version} ready</span>
            <span className="font-semibold">Restart ↻</span>
          </button>
        )}
        {update?.status === 'progress' && (
          <div className="flex items-center justify-between text-[11px] text-white/40 px-1">
            <span>Downloading update…</span>
            <span className="font-mono">{update.pct}%</span>
          </div>
        )}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            <span className="text-[11px] text-white/40 font-medium">
              SOTA BS-RoFormer Engine
            </span>
          </div>
          <span className="text-[10px] text-white/25 font-mono">
            {appVersion ? `v${appVersion}` : 'Local'}
          </span>
        </div>
      </div>
    </aside>
  )
}
