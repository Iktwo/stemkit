import { useCallback, useEffect, useRef, useState } from 'react'
import type { Song, KaraokeData } from '../../../shared/types'
import { usePlayer } from '../lib/PlayerContext'
import { fmtTime } from '../lib/format'
import { Thumb } from '../lib/thumbs'
import {
  MicIcon,
  PlayIcon,
  PauseIcon,
  XIcon,
  VolumeIcon,
  VolumeMuteIcon,
  EditIcon
} from './Icons'
import { KaraokeEditor } from './KaraokeEditor'

interface SeekBarProps {
  duration: number
  getPosition: () => number
  onSeek: (seconds: number) => void
  playing: boolean
}

function KaraokeSeekBar({
  duration,
  getPosition,
  onSeek,
  playing
}: SeekBarProps): React.ReactElement {
  const barRef = useRef<HTMLDivElement>(null)
  const [, force] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [dragPos, setDragPos] = useState(0)
  const isDraggingRef = useRef(false)
  isDraggingRef.current = isDragging

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

  const currentPos = getPosition()
  const displayPos = isDragging ? dragPos : currentPos
  const frac = duration > 0 ? Math.min(1, Math.max(0, displayPos / duration)) : 0

  const calcSeconds = (clientX: number): number => {
    const rect = barRef.current?.getBoundingClientRect()
    if (!rect || duration <= 0) return 0
    const f = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return f * duration
  }

  return (
    <div className="flex items-center gap-3 w-full">
      <span className="text-xs text-white/50 font-mono tabular-nums w-12 text-right">
        {fmtTime(displayPos)}
      </span>
      <div
        ref={barRef}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          setIsDragging(true)
          const s = calcSeconds(e.clientX)
          setDragPos(s)
          onSeek(s)
        }}
        onPointerMove={(e) => {
          if (isDraggingRef.current || e.buttons === 1) {
            const s = calcSeconds(e.clientX)
            setDragPos(s)
            onSeek(s)
          }
        }}
        onPointerUp={(e) => {
          if (isDraggingRef.current) {
            setIsDragging(false)
            const s = calcSeconds(e.clientX)
            onSeek(s)
          }
        }}
        onPointerCancel={() => {
          setIsDragging(false)
        }}
        className="no-drag relative flex-1 h-5 flex items-center cursor-pointer group select-none"
      >
        <div className="w-full h-2 rounded-full bg-white/15 overflow-hidden">
          <div
            className="h-full rounded-full bg-gradient-to-r from-amber-400 to-olive-400"
            style={{ width: `${frac * 100}%` }}
          />
        </div>
        <div
          className="absolute w-3.5 h-3.5 rounded-full bg-amber-400 border-2 border-white shadow-lg shadow-amber-400/50 transition-transform group-hover:scale-125 pointer-events-none"
          style={{ left: `calc(${frac * 100}% - 7px)` }}
        />
      </div>
      <span className="text-xs text-white/50 font-mono tabular-nums w-12">
        {fmtTime(duration)}
      </span>
    </div>
  )
}

interface Props {
  song: Song
  onClose: () => void
}

export function KaraokeStage({ song, onClose }: Props): React.ReactElement {
  const {
    playing,
    duration,
    getPosition,
    togglePlay,
    seekTo,
    vols,
    setStemVolume,
    mutes,
    setStemMute,
    master,
    setMasterVolume
  } = usePlayer()

  const [lyrics, setLyrics] = useState<KaraokeData | null>(null)
  const effectiveDuration = duration > 0 ? duration : (song.duration || lyrics?.duration || 0)
  const [loading, setLoading] = useState(true)
  const [transcribing, setTranscribing] = useState(false)
  const [transcribeProgress, setTranscribeProgress] = useState<{ pct: number; message?: string } | null>(null)
  const [selectedModel, setSelectedModel] = useState<'base' | 'small' | 'large-v3-turbo'>('large-v3-turbo')
  const [isEditing, setIsEditing] = useState(false)

  // Voice track option: true = voice ON (for testing timing), false = voice MUTED (karaoke)
  const [voiceTrackOn, setVoiceTrackOn] = useState<boolean>(() => !mutes.has('vocals'))
  const [voiceVol, setVoiceVol] = useState<number>(() => (vols['vocals'] && vols['vocals'] > 0 ? vols['vocals'] : 1.0))

  const [activeLineIdx, setActiveLineIdx] = useState<number>(-1)
  const [currentTime, setCurrentTime] = useState<number>(0)
  const [countdown, setCountdown] = useState<number | null>(null)

  const lineRefs = useRef<(HTMLDivElement | null)[]>([])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const userScrolledRef = useRef(false)
  const userScrollTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Ensure initial mute state matches voiceTrackOn
  useEffect(() => {
    if (voiceTrackOn) {
      setStemMute('vocals', false)
      setStemVolume('vocals', voiceVol)
    } else {
      setStemMute('vocals', true)
    }
  }, [])

  // Toggle voice track on/off
  const handleToggleVoiceTrack = (enable: boolean): void => {
    setVoiceTrackOn(enable)
    setStemMute('vocals', !enable)
    if (enable) {
      const v = voiceVol > 0 ? voiceVol : 1.0
      setStemVolume('vocals', v)
    }
  }

  // Handle voice volume change
  const handleVoiceVolChange = (vol: number): void => {
    setVoiceVol(vol)
    if (voiceTrackOn) {
      setStemVolume('vocals', vol)
    }
  }

  // Load existing lyrics
  const loadExistingLyrics = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const data = await window.stemkit.getLyrics(song.videoId)
      setLyrics(data)
    } catch (err) {
      console.error('Failed to load lyrics:', err)
    } finally {
      setLoading(false)
    }
  }, [song.videoId])

  useEffect(() => {
    void loadExistingLyrics()
  }, [loadExistingLyrics])

  // Listen to transcription progress events
  useEffect(() => {
    const unsub = window.stemkit.onLyricsProgress((ev) => {
      if (ev.videoId === song.videoId) {
        setTranscribeProgress({ pct: ev.pct, message: ev.message })
      }
    })
    return unsub
  }, [song.videoId])

  // Trigger vocal transcription
  const handleTranscribe = async (model = selectedModel): Promise<void> => {
    setTranscribing(true)
    setTranscribeProgress({ pct: 0, message: `Loading Whisper ${model} model…` })
    try {
      const data = await window.stemkit.transcribeLyrics(song.videoId, model)
      setLyrics(data)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setTranscribing(false)
      setTranscribeProgress(null)
    }
  }

  // Animation Loop: Synchronize with audio clock
  useEffect(() => {
    let raf = 0
    const updateTime = (): void => {
      const t = getPosition()
      setCurrentTime(t)

      if (lyrics?.lines && lyrics.lines.length > 0) {
        const lines = lyrics.lines
        let currentIdx = -1

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (t >= line.start && t <= line.end + 0.5) {
            currentIdx = i
            break
          }
          if (t < line.start) {
            currentIdx = i
            break
          }
        }

        if (currentIdx === -1 && t > lines[lines.length - 1].end) {
          currentIdx = lines.length - 1
        }

        setActiveLineIdx(currentIdx)

        if (currentIdx >= 0) {
          const targetLine = lines[currentIdx]
          const gap = targetLine.start - t
          if (gap > 0.5 && gap <= 4.0) {
            setCountdown(Math.ceil(gap))
          } else {
            setCountdown(null)
          }
        } else {
          setCountdown(null)
        }
      }

      raf = requestAnimationFrame(updateTime)
    }

    raf = requestAnimationFrame(updateTime)
    return () => cancelAnimationFrame(raf)
  }, [getPosition, lyrics])

  // Smooth auto-scroll when active line changes
  useEffect(() => {
    if (activeLineIdx >= 0 && !userScrolledRef.current) {
      const el = lineRefs.current[activeLineIdx]
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }
  }, [activeLineIdx])

  // Temporary pause auto-scroll if user manually scrolls
  const handleWheel = (): void => {
    userScrolledRef.current = true
    if (userScrollTimeoutRef.current) clearTimeout(userScrollTimeoutRef.current)
    userScrollTimeoutRef.current = setTimeout(() => {
      userScrolledRef.current = false
    }, 2500)
  }

  // Keyboard shortcut: Space to toggle play, V to toggle voice track, Escape to exit
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'KeyV') {
        e.preventDefault()
        setVoiceTrackOn((prev) => {
          const next = !prev
          setStemMute('vocals', !next)
          if (next) {
            setStemVolume('vocals', voiceVol > 0 ? voiceVol : 1.0)
          }
          return next
        })
      } else if (e.code === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, onClose, voiceVol, setStemMute, setStemVolume])

  const lines = lyrics?.lines ?? []

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0b0d09] text-white select-none animate-in fade-in duration-200">
      {/* Dynamic Ambient Glow Backdrop */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-25">
        <div className="absolute -top-1/4 -left-1/4 w-[70vw] h-[70vw] rounded-full bg-olive-500/20 blur-[140px]" />
        <div className="absolute -bottom-1/4 -right-1/4 w-[70vw] h-[70vw] rounded-full bg-amber-500/15 blur-[160px]" />
      </div>

      {/* macOS Window Controls Drag Region & Spacer */}
      <div className="drag-region h-9 w-full shrink-0 flex items-center justify-between px-4 border-b border-white/[0.06] bg-black/40">
        {/* 90px left spacer for macOS traffic lights (close, min, max) */}
        <div className="w-24 shrink-0 pointer-events-none" />
        <div className="flex items-center gap-2 text-[11px] font-mono font-medium text-white/40 uppercase tracking-wider">
          <MicIcon className="w-3.5 h-3.5 text-amber-400/80" />
          <span>Karaoke Stage</span>
          {voiceTrackOn && (
            <span className="text-amber-400/90 bg-amber-400/15 px-2 py-0.5 rounded text-[10px] normal-case border border-amber-400/25">
              Voice track audible (Press 'V' to mute)
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="no-drag flex items-center gap-1.5 px-3 py-1 rounded-lg glass hover:bg-white/10 text-white/70 hover:text-white text-xs transition-colors cursor-pointer"
          title="Exit Stage (Esc)"
        >
          <XIcon className="w-3.5 h-3.5" />
          <span>Exit Stage</span>
        </button>
      </div>

      {/* Top Navigation Bar */}
      <header className="relative z-10 flex items-center justify-between px-8 py-3.5 border-b border-white/10 glass backdrop-blur-xl shrink-0">
        <div className="flex items-center gap-4 min-w-0">
          <Thumb
            videoId={song.videoId}
            className="w-14 h-14 rounded-xl object-cover ring-1 ring-white/20 shrink-0 shadow-lg"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-amber-400/20 text-amber-300 font-semibold text-[11px] uppercase tracking-wider border border-amber-400/30">
                <MicIcon className="w-3 h-3" />
                Karaoke Stage
              </span>
              {lyrics?.language && (
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-white/10 text-white/70 font-mono">
                  {lyrics.language.toUpperCase()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <h1 className="text-lg font-bold truncate text-white">{song.title}</h1>
              <span
                onClick={() => handleToggleVoiceTrack(!voiceTrackOn)}
                className={`text-[11px] px-2 py-0.5 rounded-md font-mono cursor-pointer transition-colors ${
                  voiceTrackOn
                    ? 'bg-amber-400/20 text-amber-300 border border-amber-400/30 hover:bg-amber-400/30'
                    : 'bg-white/5 text-white/50 border border-white/10 hover:bg-white/10'
                }`}
                title="Click or press 'V' to toggle voice track"
              >
                {voiceTrackOn ? '🎙️ Voice Track ON (Test Timing)' : '🎤 Vocals Muted (Karaoke)'}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 flex-wrap">
          {/* Voice Track ON/MUTED Toggle */}
          <div className="flex items-center gap-2.5 glass px-3.5 py-1.5 rounded-xl border border-white/10">
            <span className="text-xs text-white/60 font-medium">Voice Track:</span>
            <div className="flex items-center bg-black/40 rounded-lg p-0.5 border border-white/10">
              <button
                onClick={() => handleToggleVoiceTrack(true)}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                  voiceTrackOn
                    ? 'bg-amber-400 text-black shadow-md shadow-amber-400/20'
                    : 'text-white/60 hover:text-white'
                }`}
                title="Keep voice track ON to hear singing and test timing against the lyrics (Shortcut: V)"
              >
                <MicIcon className="w-3.5 h-3.5" />
                ON (Test Timing)
              </button>
              <button
                onClick={() => handleToggleVoiceTrack(false)}
                className={`px-3 py-1 rounded-md text-xs font-semibold transition-all cursor-pointer flex items-center gap-1.5 ${
                  !voiceTrackOn
                    ? 'bg-white/20 text-white shadow-md'
                    : 'text-white/60 hover:text-white'
                }`}
                title="Mute vocals for singing karaoke (Shortcut: V)"
              >
                <VolumeMuteIcon className="w-3.5 h-3.5" />
                MUTED
              </button>
            </div>

            {/* Voice Volume Slider if Voice Track is ON */}
            {voiceTrackOn && (
              <div className="flex items-center gap-2 pl-2 border-l border-white/10">
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={voiceVol}
                  onChange={(e) => handleVoiceVolChange(parseFloat(e.target.value))}
                  className="w-20 accent-amber-400 cursor-pointer"
                  title="Original voice track volume"
                />
                <span className="text-[11px] font-mono text-amber-300/90 tabular-nums w-8">
                  {Math.round(voiceVol * 100)}%
                </span>
              </div>
            )}
          </div>

          {/* Re-transcribe dropdown button */}
          {lyrics && !transcribing && (
            <div className="relative flex items-center gap-1 glass px-3 py-1.5 rounded-xl border border-white/10 text-xs">
              <span className="text-white/50">Model:</span>
              <select
                value={selectedModel}
                onChange={(e) => {
                  const m = e.target.value as 'base' | 'small' | 'large-v3-turbo'
                  setSelectedModel(m)
                  void handleTranscribe(m)
                }}
                className="bg-transparent text-white/80 text-xs focus:outline-none cursor-pointer pr-1"
                title="Select Whisper transcription model quality"
              >
                <option value="large-v3-turbo" className="bg-[#1a1c14] text-white">Whisper Turbo (Best Quality)</option>
                <option value="small" className="bg-[#1a1c14] text-white">Whisper Small (High Quality)</option>
                <option value="base" className="bg-[#1a1c14] text-white">Whisper Base (Fast)</option>
              </select>
            </div>
          )}

          {/* Edit Lyrics Toggle */}
          {lyrics && !transcribing && (
            <button
              onClick={() => setIsEditing((prev) => !prev)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all cursor-pointer ${
                isEditing
                  ? 'bg-amber-400 text-black border-amber-400 shadow-md shadow-amber-400/20'
                  : 'glass text-white/80 hover:text-white border-white/10 hover:bg-white/10'
              }`}
              title={isEditing ? 'Return to Karaoke Stage' : 'Open Lyric Editor to correct words and timing'}
            >
              <EditIcon className="w-3.5 h-3.5" />
              <span>{isEditing ? 'Stage View' : 'Edit Lyrics'}</span>
            </button>
          )}

          {/* Close button */}
          <button
            onClick={onClose}
            className="p-2.5 rounded-xl glass hover:bg-white/10 border border-white/10 text-white/70 hover:text-white transition-all cursor-pointer"
            title="Exit Karaoke Stage (Esc)"
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      {isEditing && lyrics ? (
        <main className="relative z-10 flex-1 overflow-hidden flex flex-col">
          <KaraokeEditor
            lines={lyrics.lines}
            currentTime={currentTime}
            duration={effectiveDuration}
            onSeek={(t) => seekTo(t)}
            onSave={async (updatedLines) => {
              const updatedData: KaraokeData = {
                ...lyrics,
                lines: updatedLines
              }
              await window.stemkit.saveLyrics(song.videoId, updatedData)
              setLyrics(updatedData)
            }}
            onClose={() => setIsEditing(false)}
            voiceTrackOn={voiceTrackOn}
            onToggleVoiceTrack={handleToggleVoiceTrack}
          />
        </main>
      ) : (
        <main
          ref={containerRef}
          onWheel={handleWheel}
          className="relative z-10 flex-1 overflow-y-auto px-6 py-12 scroll-smooth"
        >
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
            <MicIcon className="w-12 h-12 text-amber-400 animate-pulse" />
            <p className="text-sm text-white/60">Checking for timed lyrics…</p>
          </div>
        ) : transcribing ? (
          <div className="h-full flex flex-col items-center justify-center max-w-md mx-auto text-center px-4">
            <div className="w-16 h-16 rounded-2xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center mb-6 shadow-xl">
              <MicIcon className="w-8 h-8 text-amber-400 animate-bounce" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Transcribing Vocals with Whisper AI</h2>
            <p className="text-xs text-white/50 mb-6">
              Processing isolated vocal stem locally to extract synchronized word-level timestamps.
            </p>

            <div className="w-full bg-white/10 rounded-full h-3 overflow-hidden p-0.5 border border-white/10 mb-3">
              <div
                className="bg-gradient-to-r from-amber-400 to-olive-400 h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.max(5, transcribeProgress?.pct ?? 0)}%` }}
              />
            </div>
            <p className="text-xs font-mono text-amber-300/80">
              {transcribeProgress?.message ?? 'Analyzing vocal audio…'} ({transcribeProgress?.pct ?? 0}%)
            </p>
          </div>
        ) : !lyrics || lines.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center max-w-lg mx-auto text-center px-6">
            <div className="w-20 h-20 rounded-3xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center mb-6 shadow-2xl">
              <MicIcon className="w-10 h-10 text-amber-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Ready for Karaoke?</h2>
            <p className="text-sm text-white/60 mb-6 leading-relaxed">
              Extract word-level timestamps locally from your clean vocal stem using open AI models. No cloud needed, 100% private.
            </p>

            <div className="flex items-center gap-2.5 text-xs text-white/75 mb-6 glass px-4 py-2.5 rounded-xl border border-white/10">
              <input
                type="checkbox"
                id="voiceTrackInitial"
                checked={voiceTrackOn}
                onChange={(e) => handleToggleVoiceTrack(e.target.checked)}
                className="accent-amber-400 cursor-pointer w-4 h-4 rounded"
              />
              <label htmlFor="voiceTrackInitial" className="cursor-pointer select-none">
                Keep voice track ON while playing (hear vocals to verify timing)
              </label>
            </div>

            <div className="flex flex-col sm:flex-row items-center gap-3 w-full justify-center">
              <button
                onClick={() => void handleTranscribe('base')}
                className="w-full sm:w-auto px-6 py-3.5 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 text-black font-semibold text-sm hover:from-amber-300 hover:to-amber-400 transition-all shadow-lg hover:shadow-amber-500/25 cursor-pointer flex items-center justify-center gap-2"
              >
                <MicIcon className="w-4 h-4 text-black" />
                Transcribe (Fast · Whisper Base)
              </button>
              <button
                onClick={() => void handleTranscribe('small')}
                className="w-full sm:w-auto px-6 py-3.5 rounded-xl glass hover:bg-white/10 text-white/80 hover:text-white font-medium text-sm transition-all border border-white/15 cursor-pointer"
              >
                High Quality (Whisper Small)
              </button>
            </div>
          </div>
        ) : (
          <div className="max-w-4xl mx-auto py-24 space-y-12">
            {/* Instrumental Interlude Countdown */}
            {countdown !== null && (
              <div className="sticky top-4 z-20 flex justify-center pointer-events-none">
                <div className="glass px-5 py-2 rounded-full border border-amber-400/30 text-amber-300 font-bold text-sm shadow-xl flex items-center gap-2 animate-pulse backdrop-blur-2xl">
                  <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                  Sing in {countdown}…
                </div>
              </div>
            )}

            {/* Lyric Lines */}
            {lines.map((line, lIdx) => {
              const isActive = lIdx === activeLineIdx
              const isPast = activeLineIdx > lIdx && currentTime > line.end

              return (
                <div
                  key={lIdx}
                  ref={(el) => (lineRefs.current[lIdx] = el)}
                  onClick={() => seekTo(line.start)}
                  className={`cursor-pointer transition-all duration-300 px-6 py-4 rounded-2xl ${
                    isActive
                      ? 'scale-105 opacity-100 bg-white/[0.04] ring-1 ring-amber-400/30 shadow-2xl backdrop-blur-sm'
                      : isPast
                        ? 'opacity-40 hover:opacity-75 scale-95'
                        : 'opacity-35 hover:opacity-65 scale-95'
                  }`}
                >
                  <p className="text-2xl md:text-3xl lg:text-4xl font-extrabold tracking-tight leading-relaxed flex flex-wrap gap-x-2.5 gap-y-1 justify-center text-center">
                    {line.words && line.words.length > 0 ? (
                      line.words.map((w, wIdx) => {
                        const wordPast = currentTime >= w.end
                        const wordActive = currentTime >= w.start && currentTime < w.end
                        const frac = wordActive
                          ? Math.min(1, Math.max(0, (currentTime - w.start) / Math.max(0.01, w.end - w.start)))
                          : wordPast
                            ? 1
                            : 0

                        return (
                          <span
                            key={wIdx}
                            className={`relative inline-block mx-1.5 transition-transform duration-100 ${
                              wordActive ? 'scale-105' : ''
                            }`}
                          >
                            {/* Inactive Base Text (always readable, never transparent or hidden by a box) */}
                            <span
                              className={`transition-colors duration-150 ${
                                isActive
                                  ? 'text-white/40'
                                  : isPast
                                    ? 'text-white/20'
                                    : 'text-white/30'
                              }`}
                            >
                              {w.word}
                            </span>

                            {/* Active Golden Highlight Wipe Layer (revealed smoothly by width %) */}
                            {isActive && frac > 0 && (
                              <span
                                className="absolute inset-0 overflow-hidden whitespace-nowrap select-none pointer-events-none"
                                style={{ width: `${Math.min(100, Math.max(0, frac * 100))}%` }}
                              >
                                <span className="text-amber-400 font-black drop-shadow-[0_0_12px_rgba(251,191,36,0.65)]">
                                  {w.word}
                                </span>
                              </span>
                            )}
                          </span>
                        )
                      })
                    ) : (
                      <span className={isActive ? 'text-amber-400 font-extrabold drop-shadow-[0_0_10px_rgba(251,191,36,0.5)]' : 'text-white/40'}>
                        {line.text}
                      </span>
                    )}
                  </p>
                </div>
              )
            })}
          </div>
        )}
      </main>
      )}

      {/* Bottom Transport Player Controls */}
      <footer className="relative z-10 px-8 py-5 border-t border-white/10 glass backdrop-blur-xl shrink-0">
        <div className="max-w-4xl mx-auto flex flex-col gap-3">
          {/* Seek progress bar */}
          <KaraokeSeekBar
            duration={effectiveDuration}
            getPosition={getPosition}
            onSeek={seekTo}
            playing={playing}
          />

          {/* Controls Bar */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={() => seekTo(Math.max(0, currentTime - 5))}
                className="p-2 rounded-lg hover:bg-white/10 text-white/60 hover:text-white transition-colors cursor-pointer text-xs font-mono"
                title="Rewind 5 seconds"
              >
                -5s
              </button>
              <button
                onClick={() => seekTo(Math.min(effectiveDuration, currentTime + 5))}
                className="p-2 rounded-lg hover:bg-white/10 text-white/60 hover:text-white transition-colors cursor-pointer text-xs font-mono"
                title="Skip forward 5 seconds"
              >
                +5s
              </button>
            </div>

            {/* Play/Pause Button */}
            <button
              onClick={togglePlay}
              className="w-12 h-12 rounded-full bg-amber-400 hover:bg-amber-300 text-black flex items-center justify-center transition-transform hover:scale-105 shadow-xl shadow-amber-400/20 cursor-pointer"
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
            >
              {playing ? <PauseIcon className="w-6 h-6 text-black" /> : <PlayIcon className="w-6 h-6 text-black ml-0.5" />}
            </button>

            {/* Master Volume */}
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => setMasterVolume(master > 0 ? 0 : 1)}
                className="p-1.5 text-white/60 hover:text-white transition-colors cursor-pointer"
              >
                {master > 0 ? <VolumeIcon className="w-4 h-4" /> : <VolumeMuteIcon className="w-4 h-4" />}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={master}
                onChange={(e) => setMasterVolume(parseFloat(e.target.value))}
                className="w-20 accent-amber-400 cursor-pointer"
                title="Master volume"
              />
            </div>
          </div>
        </div>
      </footer>
    </div>
  )
}
