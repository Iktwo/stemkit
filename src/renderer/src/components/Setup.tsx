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

  return (
    <div className="h-full flex items-center justify-center px-8">
      <div className="w-full max-w-lg rise-in">
        <div className="flex items-center gap-3 justify-center">
          <LogoMark className="w-10 h-10" />
          <h1 className="text-xl font-bold tracking-tight">Welcome to StemKit</h1>
        </div>
        <p className="text-center text-white/45 text-sm mt-3 leading-relaxed">
          One-time setup downloads the separation engine (~2 GB).
          <br />
          After that everything works offline, right on your machine.
        </p>

        {!status.bootstrapping && (
          <button
            onClick={onInstall}
            className="mt-7 w-full py-3.5 rounded-xl bg-white text-black font-semibold text-sm hover:bg-white/90 active:scale-[0.99] transition-all"
          >
            Get started · ~2 GB, once
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
              <div className="flex items-center gap-2 mt-2 text-olive-300">
                <span className="w-3 h-3 rounded-full border-2 border-white/20 border-t-olive-300 animate-spin inline-block" />
                working…
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
