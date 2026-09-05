import { useState } from 'react'
import { fmtTime } from '../lib/format'
import { PLAYBACK_RATES, type LoopRegion } from '../lib/PlayerContext'
import { LoopIcon, SpeedIcon, XIcon } from './Icons'

interface Props {
  rate: number
  onRate: (rate: number) => void
  loop: LoopRegion | null
  onLoop: (loop: LoopRegion | null) => void
  getPosition: () => number
  duration: number
  accent?: 'olive' | 'amber'
}

/**
 * Practice tools shared by the mixer and the tab stage: playback speed and an
 * A-B loop. Speed is tape-style (pitch follows the speed).
 */
export function PracticeControls({
  rate,
  onRate,
  loop,
  onLoop,
  getPosition,
  duration,
  accent = 'olive'
}: Props): React.ReactElement {
  const [pendingA, setPendingA] = useState<number | null>(null)
  const on =
    accent === 'amber'
      ? 'bg-amber-400 text-black shadow-sm'
      : 'bg-olive-400 text-black shadow-sm'
  const chip =
    accent === 'amber'
      ? 'bg-amber-400/15 text-amber-200 border-amber-400/30'
      : 'bg-olive-500/15 text-olive-200 border-olive-400/30'

  const markA = (): void => {
    const pos = getPosition()
    if (loop) {
      onLoop(pos < loop.end - 0.2 ? { start: pos, end: loop.end } : null)
      if (pos >= loop.end - 0.2) setPendingA(pos)
      return
    }
    setPendingA(pos)
  }

  const markB = (): void => {
    const pos = getPosition()
    const start = loop ? loop.start : (pendingA ?? 0)
    if (pos <= start + 0.2) return
    setPendingA(null)
    onLoop({ start, end: pos })
  }

  const clear = (): void => {
    setPendingA(null)
    onLoop(null)
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div
        className="no-drag flex items-center gap-0.5 rounded-xl bg-white/[0.05] border border-white/10 p-0.5"
        title="Playback speed (pitch follows, like slowing a tape)"
      >
        <SpeedIcon className="w-3.5 h-3.5 text-white/40 mx-1.5" />
        {PLAYBACK_RATES.map((r) => (
          <button
            key={r}
            onClick={() => onRate(r)}
            className={`px-2 h-6 rounded-lg text-[11px] font-semibold tabular-nums transition-colors cursor-pointer ${
              Math.abs(rate - r) < 0.001 ? on : 'text-white/50 hover:text-white'
            }`}
          >
            {r === 1 ? '1×' : `${r}×`}
          </button>
        ))}
      </div>

      <div className="no-drag flex items-center gap-0.5 rounded-xl bg-white/[0.05] border border-white/10 p-0.5">
        <LoopIcon className={`w-3.5 h-3.5 mx-1.5 ${loop ? (accent === 'amber' ? 'text-amber-300' : 'text-olive-300') : 'text-white/40'}`} />
        <button
          onClick={markA}
          disabled={duration <= 0}
          title="Set loop start at the playhead"
          className={`px-2 h-6 rounded-lg text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-40 ${
            loop || pendingA !== null ? on : 'text-white/60 hover:text-white'
          }`}
        >
          A
        </button>
        <button
          onClick={markB}
          disabled={duration <= 0}
          title="Set loop end at the playhead"
          className={`px-2 h-6 rounded-lg text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-40 ${
            loop ? on : 'text-white/60 hover:text-white'
          }`}
        >
          B
        </button>
        {(loop || pendingA !== null) && (
          <>
            <span className={`ml-1 px-2 h-6 rounded-lg text-[11px] font-mono border flex items-center gap-1 ${chip}`}>
              {loop ? `${fmtTime(loop.start)} – ${fmtTime(loop.end)}` : `${fmtTime(pendingA ?? 0)} – set B`}
            </span>
            <button
              onClick={clear}
              title="Clear loop"
              className="w-6 h-6 rounded-lg text-white/40 hover:text-rose-300 hover:bg-white/10 flex items-center justify-center cursor-pointer"
            >
              <XIcon className="w-3 h-3" />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
