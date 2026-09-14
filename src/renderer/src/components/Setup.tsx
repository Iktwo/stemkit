import { useEffect, useMemo, useRef, useState } from 'react'
import type { EnvStatus } from '../../../shared/types'
import { LogoMark } from './Icons'

interface Props {
  status: EnvStatus
  logs: { message: string; level: string; pct?: number; detail?: string }[]
  onInstall: () => void
}

export function Setup({ status, logs, onInstall }: Props): React.ReactElement {
  const logRef = useRef<HTMLDivElement>(null)
  const [showLogs, setShowLogs] = useState(false)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  const latestProgressLog = useMemo(() => {
    return [...logs].reverse().find((l) => typeof l.pct === 'number')
  }, [logs])

  const latestError = useMemo(() => {
    return [...logs].reverse().find((l) => l.level === 'error')
  }, [logs])

  const currentPct = latestProgressLog?.pct ?? null
  const currentDetail = latestProgressLog?.detail ?? ''

  const currentTitle = useMemo(() => {
    if (!status.bootstrapping && latestError) return 'Setup encountered an error'
    if (!status.bootstrapping) return 'Ready'
    const last = logs[logs.length - 1]?.message || ''
    if (!last) return 'Setting up environment…'
    return last.replace(/:\s*\d{1,3}%/g, '').replace(/—\s*grab a coffee/i, '').trim() || 'Setting up environment…'
  }, [status.bootstrapping, latestError, logs])

  return (
    <div className="h-full flex items-center justify-center px-8 bg-gradient-to-b from-[#12140f] to-[#0a0c08]">
      <div className="w-full max-w-lg rise-in">
        <div className="flex items-center gap-3 justify-center">
          <LogoMark className="w-10 h-10 text-olive-400" />
          <h1 className="text-xl font-bold tracking-tight text-white">Welcome to StemKit</h1>
        </div>
        <p className="text-center text-white/45 text-sm mt-3 leading-relaxed">
          One-time setup — after this everything works offline, right on your machine.
        </p>

        {!status.bootstrapping && !latestError && (
          <button
            onClick={onInstall}
            className="mt-7 w-full py-3.5 rounded-xl bg-white text-black font-semibold text-sm hover:bg-white/90 active:scale-[0.99] transition-all cursor-pointer shadow-lg shadow-white/5"
          >
            Get started (~2 GB, one time)
          </button>
        )}

        {!status.bootstrapping && latestError && (
          <div className="mt-6 p-4 rounded-xl bg-rose-500/10 border border-rose-500/25 text-left">
            <div className="text-xs font-semibold text-rose-300">Setup Encountered an Issue</div>
            <div className="text-[11.5px] text-white/60 mt-1 font-mono break-words">{latestError.message}</div>
            <div className="text-[11px] text-white/40 mt-2">
              Downloads resume from where they stopped. Check your connection and try again.
            </div>
            <button
              onClick={onInstall}
              className="mt-3.5 w-full py-2.5 rounded-lg bg-rose-500/80 hover:bg-rose-500 active:scale-[0.99] text-white font-semibold text-xs transition-colors cursor-pointer"
            >
              Retry Setup
            </button>
          </div>
        )}

        {status.bootstrapping && (
          <div className="mt-6 p-4 rounded-2xl bg-white/[0.04] border border-white/10 text-left shadow-xl">
            <div className="flex items-center justify-between gap-3 text-xs mb-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-2.5 h-2.5 rounded-full bg-olive-400 animate-pulse shrink-0 shadow-sm shadow-olive-400/50" />
                <span className="font-semibold text-white truncate">{currentTitle}</span>
              </div>
              <span className="font-mono text-xs font-bold text-olive-300 shrink-0">
                {currentPct !== null ? `${currentPct}%` : 'Working…'}
              </span>
            </div>

            <div className="h-2 rounded-full bg-white/10 overflow-hidden relative">
              {currentPct !== null ? (
                <div
                  className="h-full rounded-full bg-gradient-to-r from-olive-400 via-emerald-400 to-teal-300 transition-all duration-300 shadow-sm shadow-olive-400/25"
                  style={{ width: `${Math.max(3, currentPct)}%` }}
                />
              ) : (
                <div className="h-full w-full rounded-full bg-gradient-to-r from-olive-400 to-emerald-400 animate-pulse opacity-45" />
              )}
            </div>

            <div className="flex items-center justify-between text-[11px] text-white/40 mt-2 font-mono">
              <span className="truncate max-w-[280px]">{currentDetail || 'One-time download'}</span>
              <span className="text-white/30 text-[10px] shrink-0 uppercase tracking-wider font-sans">~2 GB Total</span>
            </div>
          </div>
        )}

        {(status.bootstrapping || logs.length > 0) && (
          <div className="mt-4">
            <div className="flex items-center justify-between px-1 mb-1.5">
              <span className="text-[10px] font-semibold tracking-wider uppercase text-white/30">Setup Output</span>
              <button
                type="button"
                onClick={() => setShowLogs((s) => !s)}
                className="text-[11px] text-white/40 hover:text-white/70 transition-colors cursor-pointer"
              >
                {showLogs ? 'Compact' : 'Expand'}
              </button>
            </div>
            <div
              ref={logRef}
              className={`${
                showLogs ? 'h-52' : 'h-32'
              } overflow-y-auto rounded-xl bg-black/60 border border-white/[0.07] p-3 font-mono text-[11px] leading-relaxed transition-all`}
            >
              {logs.map((l, i) => (
                <div
                  key={i}
                  className={
                    l.level === 'error'
                      ? 'text-rose-300'
                      : l.level === 'success'
                        ? 'text-emerald-300'
                        : 'text-white/45'
                  }
                >
                  {l.message}
                  {l.detail ? <span className="text-white/30 ml-2">({l.detail})</span> : null}
                </div>
              ))}
              {status.bootstrapping && (
                <div className="flex items-center gap-2 mt-2 text-olive-300">
                  <span className="w-3 h-3 rounded-full border-2 border-white/20 border-t-olive-300 animate-spin inline-block" />
                  working…
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
