import { useState } from 'react'
import { MODEL_STANDARD, MODEL_EXTENDED, type StemId } from '../../../shared/types'
import { STEM_INFO } from '../lib/stems'

const STANDARD_IDS: StemId[] = ['vocals', 'drums', 'bass', 'other']
const EXTENDED_IDS: StemId[] = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

interface Props {
  busy: boolean
  hasSongs: boolean
  onStart: (url: string, model: string) => void
}

export function Home({ busy, hasSongs, onStart }: Props): React.ReactElement {
  const [url, setUrl] = useState('')
  const [model, setModel] = useState(MODEL_STANDARD)

  const submit = (): void => {
    const trimmed = url.trim()
    if (!trimmed || busy) return
    onStart(trimmed, model)
    setUrl('')
  }

  const chipsFor = (ids: StemId[]): React.ReactElement => (
    <span className="flex items-center gap-1.5 flex-wrap">
      {ids.map((id) => (
        <span key={id} className="flex items-center gap-1 text-[10px]">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: STEM_INFO[id].color }}
          />
          <span className={model === id ? '' : ''}>{STEM_INFO[id].label}</span>
        </span>
      ))}
    </span>
  )

  return (
    <div className="h-full flex flex-col items-center justify-center px-8">
      <div className="w-full max-w-xl rise-in">
        <h1 className="text-center text-[34px] font-bold tracking-tight leading-tight bg-gradient-to-r from-violet-300 via-white to-emerald-200 bg-clip-text text-transparent">
          Turn any YouTube track into stems.
        </h1>
        <p className="text-center text-white/45 mt-3 text-[15px]">
          Vocals, drums, bass and everything else — separated locally, synced to the video.
        </p>

        <div className="mt-8 flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Paste a YouTube link…"
            spellCheck={false}
            className="no-drag flex-1 glass rounded-xl px-4 py-3.5 text-sm outline-none placeholder:text-white/25 focus:ring-2 focus:ring-violet-400/60 transition-shadow"
          />
          <button
            onClick={submit}
            disabled={busy || !url.trim()}
            className="no-drag px-6 rounded-xl bg-white text-black text-sm font-semibold hover:bg-white/90 active:scale-[0.98] transition-all disabled:opacity-40 disabled:hover:bg-white disabled:active:scale-100"
          >
            {busy ? 'Working…' : 'Split'}
          </button>
        </div>

        <div className="mt-4 flex justify-center">
          <div className="no-drag flex items-stretch gap-1 glass rounded-2xl p-1">
            {[
              { id: MODEL_STANDARD, label: 'Standard', ids: STANDARD_IDS },
              { id: MODEL_EXTENDED, label: 'Extended · all instruments', ids: EXTENDED_IDS }
            ].map((opt) => (
              <button
                key={opt.id}
                onClick={() => setModel(opt.id)}
                className={`px-4 py-2.5 rounded-xl text-[13px] font-medium transition-all text-left ${
                  model === opt.id
                    ? 'bg-white/90 text-black'
                    : 'text-white/55 hover:text-white hover:bg-white/5'
                }`}
              >
                <span className="block">{opt.label}</span>
                <span className={`block mt-1 ${model === opt.id ? 'opacity-70' : 'opacity-50'}`}>
                  {chipsFor(opt.ids)}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-center gap-2 flex-wrap">
          {['Karaoke mode', 'Acapella', 'Instrumental', 'Runs on your machine'].map((chip) => (
            <span
              key={chip}
              className="text-[12px] text-white/40 glass rounded-full px-3 py-1"
            >
              {chip}
            </span>
          ))}
        </div>

        {!hasSongs && (
          <p className="mt-10 text-center text-xs text-white/25 leading-relaxed">
            First run installs the separation engine (~2 GB, one time).
            <br />
            After that, a 4-minute song takes about a minute to split.
          </p>
        )}
      </div>
    </div>
  )
}
