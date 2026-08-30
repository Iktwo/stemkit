import type { JobProgress } from '../../../shared/types'
import { XIcon } from './Icons'

const STAGES: { id: JobProgress['stage']; label: string }[] = [
  { id: 'metadata', label: 'Video Info' },
  { id: 'download', label: 'Audio Stream' },
  { id: 'convert', label: 'Preparing WAV' },
  { id: 'separate', label: 'BS-RoFormer Engine' },
  { id: 'finalize', label: 'Finalizing Stems' }
]

interface Props {
  job: JobProgress | null
  error: string | null
  botSuspected: boolean
  onCancel: () => void
  onRetry: () => void
  onUpdateYtDlp: () => void
}

export function Processing({
  job,
  error,
  botSuspected,
  onCancel,
  onRetry,
  onUpdateYtDlp
}: Props): React.ReactElement {
  const isQueued = !!job?.message?.toLowerCase().includes('in queue')
  const stageIndex = job ? STAGES.findIndex((s) => s.id === job.stage) : -1

  return (
    <div className="h-full flex items-center justify-center px-8 bg-gradient-to-b from-[#12121c] to-[#0a0a0e]">
      <div className="w-full max-w-md glass rounded-3xl p-8 shadow-2xl border border-white/10 rise-in">
        {/* Track Card */}
        <div className="flex items-center gap-4">
          {job?.videoId ? (
            <img
              src={`https://i.ytimg.com/vi/${job.videoId}/default.jpg`}
              alt=""
              className="w-20 h-12 rounded-xl object-cover bg-white/5 shadow-md shrink-0"
            />
          ) : (
            <div className="w-12 h-12 rounded-xl bg-violet-500/20 flex items-center justify-center shrink-0">
              <span className="w-5 h-5 rounded-full border-2 border-violet-400/40 border-t-violet-400 animate-spin" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold leading-snug truncate text-white">
              {job?.title || (error ? 'Separation Failed' : 'Initializing…')}
            </h2>
            <div className="flex items-center gap-2 mt-1">
              {isQueued ? (
                <span className="text-[11px] font-semibold text-amber-300 bg-amber-400/10 border border-amber-400/30 px-2 py-0.5 rounded-md animate-pulse">
                  {job?.message}
                </span>
              ) : (
                <p className="text-xs text-white/50 truncate">
                  {job?.message || 'Processing on Apple Silicon / GPU'}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Progress Pipeline */}
        <div className="mt-8 space-y-4">
          {STAGES.map((stage, i) => {
            const done = !error && i < stageIndex
            const active = !error && i === stageIndex
            const pct = active && job ? job.pct : done ? 100 : 0
            return (
              <div key={stage.id} className="flex items-center gap-3.5">
                <span
                  className={`w-5 h-5 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold transition-all ${
                    done
                      ? 'bg-emerald-400 text-black shadow-sm'
                      : active
                        ? 'bg-violet-400 text-black animate-pulse shadow-md shadow-violet-400/30 ring-2 ring-violet-400/30'
                        : error && i >= stageIndex
                          ? 'bg-rose-400/80 text-black'
                          : 'bg-white/10 text-white/30'
                  }`}
                >
                  {done ? '✓' : i + 1}
                </span>
                <span className={`text-[13px] w-36 font-medium ${active ? 'text-white' : 'text-white/40'}`}>
                  {stage.label}
                </span>
                <div className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-violet-400 to-emerald-400 transition-[width] duration-300"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-9 text-right text-[11px] font-mono text-white/40">
                  {active && job ? `${Math.round(job.pct)}%` : done ? '100%' : '0%'}
                </span>
              </div>
            )
          })}
        </div>

        {/* Error Handling */}
        {error && (
          <div className="mt-6 rise-in">
            <div className="rounded-xl bg-rose-500/10 border border-rose-400/25 px-4 py-3 text-[13px] text-rose-200 break-words leading-relaxed">
              {error}
            </div>
            <div className="mt-4 flex gap-2 justify-end">
              {botSuspected && (
                <button
                  onClick={onUpdateYtDlp}
                  className="px-4 py-2 rounded-xl glass text-[13px] hover:bg-white/10 transition-colors text-white"
                >
                  Update yt-dlp & retry
                </button>
              )}
              <button
                onClick={onRetry}
                className="px-5 py-2 rounded-xl bg-white text-black text-[13px] font-semibold hover:bg-white/90 transition-colors shadow-md"
              >
                Try again
              </button>
            </div>
          </div>
        )}

        {/* Cancel Button */}
        {!error && (
          <div className="mt-8 flex justify-center">
            <button
              onClick={onCancel}
              className="flex items-center gap-1.5 text-xs text-white/40 hover:text-rose-300 py-1.5 px-3 rounded-lg hover:bg-white/5 transition-all"
            >
              <XIcon className="w-3.5 h-3.5" /> Cancel separation
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
