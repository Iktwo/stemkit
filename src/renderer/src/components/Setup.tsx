import { useEffect, useRef } from 'react'
import type { EnvStatus } from '../../../shared/types'
import { LogoMark } from './Icons'

interface Props {
  status: EnvStatus
  logs: { message: string; level: string }[]
  onInstall: () => void
}

export function Setup({ status, logs, onInstall }: Props): React.ReactElement {
  const logRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs])

  const checks = [
    {
      ok: status.python.found,
      label: 'Python 3',
      detail: status.python.path ?? 'not found — install with brew install python'
    },
    {
      ok: status.ffmpeg.found,
      label: 'ffmpeg',
      detail: status.ffmpeg.path ?? 'not found — install with brew install ffmpeg'
    }
  ]

  return (
    <div className="h-full flex items-center justify-center px-8">
      <div className="w-full max-w-lg rise-in">
        <div className="flex items-center gap-3 justify-center">
          <LogoMark className="w-10 h-10" />
          <h1 className="text-xl font-bold tracking-tight">Welcome to StemKit</h1>
        </div>
        <p className="text-center text-white/45 text-sm mt-3 leading-relaxed">
          One-time setup downloads the separation engine.
          <br />
          Everything runs locally after that.
        </p>

        <div className="mt-7 space-y-2">
          {checks.map((c) => (
            <div key={c.label} className="glass rounded-xl px-4 py-3 flex items-center gap-3">
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[11px] font-bold ${
                  c.ok ? 'bg-emerald-400 text-black' : 'bg-white/10 text-white/40'
                }`}
              >
                {c.ok ? '✓' : '·'}
              </span>
              <span className="text-sm font-medium w-20">{c.label}</span>
              <span className="text-xs text-white/35 truncate font-mono">{c.detail}</span>
            </div>
          ))}
        </div>

        {!status.bootstrapping && (
          <button
            onClick={onInstall}
            disabled={!status.python.found || !status.ffmpeg.found}
            className="mt-6 w-full py-3.5 rounded-xl bg-white text-black font-semibold text-sm hover:bg-white/90 active:scale-[0.99] transition-all disabled:opacity-40 disabled:hover:bg-white"
          >
            Install separation engine · ~2 GB, one time
          </button>
        )}

        {(status.bootstrapping || logs.length > 0) && (
          <div
            ref={logRef}
            className="mt-6 h-44 overflow-y-auto rounded-xl bg-black/50 border border-white/[0.07] p-3.5 font-mono text-[11px] leading-relaxed"
          >
            {logs.map((l, i) => (
              <div
                key={i}
                className={
                  l.level === 'error' ? 'text-rose-300' : l.level === 'success' ? 'text-emerald-300' : 'text-white/45'
                }
              >
                {l.message}
              </div>
            ))}
            {status.bootstrapping && (
              <div className="flex items-center gap-2 mt-2 text-violet-300">
                <span className="w-3 h-3 rounded-full border-2 border-white/20 border-t-violet-300 animate-spin inline-block" />
                working…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
