import { useEffect, useRef, useState, useCallback } from 'react'
import type { Song } from '../../../shared/types'
import { fmtTime } from '../lib/format'
import { PlayIcon, PauseIcon, MaximizeIcon, XIcon, VolumeIcon, VolumeMuteIcon } from './Icons'

interface Props {
  song: Song
  playing: boolean
  duration: number
  getPosition: () => number
  onTogglePlay: () => void
  onSeek: (seconds: number) => void
  master: number
  onMaster: (v: number) => void
  onExpand: () => void
  onClose: () => void
}

function MiniSeekBar({
  duration,
  getPosition,
  onSeek,
  playing
}: {
  duration: number
  getPosition: () => number
  onSeek: (seconds: number) => void
  playing: boolean
}): React.ReactElement {
  const barRef = useRef<HTMLDivElement>(null)
  const [, force] = useState(0)

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = (): void => {
      force((n) => (n + 1) % 1000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const curPos = getPosition()
  const frac = duration > 0 ? Math.min(1, Math.max(0, curPos / duration)) : 0

  const seekFromEvent = useCallback(
    (clientX: number): void => {
      const rect = barRef.current?.getBoundingClientRect()
      if (!rect || duration <= 0) return
      const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      onSeek(f * duration)
    },
    [duration, onSeek]
  )

  return (
    <div className="flex items-center gap-2.5 w-full">
      <span className="text-[11px] text-white/50 font-mono tabular-nums w-10 text-right shrink-0">
        {fmtTime(curPos)}
      </span>
      <div
        ref={barRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          seekFromEvent(e.clientX)
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekFromEvent(e.clientX)
        }}
        className="no-drag relative flex-1 h-3 flex items-center cursor-pointer group py-1"
      >
        <div className="w-full h-1 rounded-full bg-white/10 group-hover:h-1.5 transition-all overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-olive-400 to-emerald-400"
            style={{ width: `${frac * 100}%` }}
          />
        </div>
        <div
          className="absolute w-2.5 h-2.5 rounded-full bg-white shadow opacity-0 group-hover:opacity-100 transition-all pointer-events-none"
          style={{ left: `calc(${frac * 100}% - 5px)` }}
        />
      </div>
      <span className="text-[11px] text-white/50 font-mono tabular-nums w-10 shrink-0">
        {fmtTime(duration)}
      </span>
    </div>
  )
}

export function MiniPlayer({
  song,
  playing,
  duration,
  getPosition,
  onTogglePlay,
  onSeek,
  master,
  onMaster,
  onExpand,
  onClose
}: Props): React.ReactElement {
  const [prevMaster, setPrevMaster] = useState(0.9)

  const toggleMuteMaster = (): void => {
    if (master > 0) {
      setPrevMaster(master)
      onMaster(0)
    } else {
      onMaster(prevMaster || 0.9)
    }
  }

  return (
    <aside
      aria-label="Now Playing"
      className="shrink-0 h-[68px] border-t border-white/10 bg-[#0d0f0a]/95 backdrop-blur-2xl px-5 flex items-center justify-between gap-6 shadow-2xl z-30 select-none animate-in fade-in slide-in-from-bottom-2 duration-200"
    >
      {/* Left: Track info & expand click target */}
      <div
        onClick={onExpand}
        title="Open full stems player"
        className="no-drag flex items-center gap-3 w-[260px] min-w-0 cursor-pointer group p-1.5 -ml-1.5 rounded-xl hover:bg-white/[0.06] transition-colors"
      >
        <div className="relative shrink-0 w-11 h-11 rounded-lg overflow-hidden bg-white/5 border border-white/10 shadow-sm">
          <img
            src={`https://i.ytimg.com/vi/${song.videoId}/default.jpg`}
            alt=""
            className="w-full h-full object-cover"
            draggable={false}
          />
          {playing && (
            <span className="absolute inset-0 bg-black/40 flex items-center justify-center gap-0.5">
              <span className="w-0.5 h-3 bg-olive-400 rounded-full animate-pulse" />
              <span className="w-0.5 h-4 bg-emerald-400 rounded-full animate-pulse [animation-delay:150ms]" />
              <span className="w-0.5 h-2.5 bg-olive-400 rounded-full animate-pulse [animation-delay:300ms]" />
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="block text-[13px] font-semibold text-white/90 group-hover:text-olive-300 transition-colors truncate">
              {song.title || song.videoId}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 text-[11px] text-white/40">
            <span className="w-1.5 h-1.5 rounded-full bg-olive-400" />
            <span className="text-olive-300 font-medium">Now Playing</span>
            <span className="text-white/20">·</span>
            <span className="group-hover:text-white/70 transition-colors">Click to expand</span>
          </div>
        </div>
      </div>

      {/* Center: Controls & Seek bar */}
      <div className="flex-1 max-w-xl flex flex-col items-center gap-1 min-w-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onTogglePlay}
            disabled={duration === 0}
            className="no-drag w-8 h-8 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shadow-md shadow-olive-500/20 disabled:opacity-40 disabled:hover:scale-100 cursor-pointer"
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? (
              <PauseIcon className="w-3.5 h-3.5" />
            ) : (
              <PlayIcon className="w-3.5 h-3.5 translate-x-px" />
            )}
          </button>
        </div>

        <MiniSeekBar
          duration={duration}
          getPosition={getPosition}
          onSeek={onSeek}
          playing={playing}
        />
      </div>

      {/* Right: Volume & Actions */}
      <div className="flex items-center justify-end gap-3 w-[260px] shrink-0">
        {/* Volume slider */}
        <div className="flex items-center gap-2 w-32">
          <button
            onClick={toggleMuteMaster}
            title={master === 0 ? 'Unmute' : 'Mute'}
            className="no-drag text-white/50 hover:text-white transition-colors shrink-0 p-1"
          >
            {master === 0 ? (
              <VolumeMuteIcon className="w-3.5 h-3.5 text-rose-300" />
            ) : (
              <VolumeIcon className="w-3.5 h-3.5" />
            )}
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={master}
            onChange={(e) => onMaster(parseFloat(e.target.value))}
            className="no-drag w-full h-1 cursor-pointer"
            style={{
              background: `linear-gradient(to right, #fff ${master * 100}%, rgba(255,255,255,0.14) ${master * 100}%)`
            }}
          />
        </div>

        {/* Expand to full player button */}
        <button
          onClick={onExpand}
          title="Expand stems player"
          className="no-drag p-2 rounded-xl text-white/50 hover:text-white hover:bg-white/10 transition-all cursor-pointer"
        >
          <MaximizeIcon className="w-4 h-4" />
        </button>

        {/* Close / stop button */}
        <button
          onClick={onClose}
          title="Stop and close player"
          className="no-drag p-2 rounded-xl text-white/35 hover:text-rose-300 hover:bg-white/10 transition-all cursor-pointer"
        >
          <XIcon className="w-4 h-4" />
        </button>
      </div>
    </aside>
  )
}
