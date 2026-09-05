import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Song, GuitarTabData, TabProgress } from '../../../shared/types'
import { usePlayer } from '../lib/PlayerContext'
import { fmtTime } from '../lib/format'
import { Thumb } from '../lib/thumbs'
import {
  GuitarIcon,
  BassIcon,
  PlayIcon,
  PauseIcon,
  XIcon,
  VolumeIcon,
  VolumeMuteIcon,
  CopyIcon,
  CheckIcon,
  RefreshIcon,
  DownloadIcon,
  GearIcon,
  MusicNoteIcon
} from './Icons'
import { tabSynth, SYNTH_INSTRUMENTS, type SynthInstrument } from '../lib/midiSynth'

interface Props {
  song: Song
  instrument?: 'guitar' | 'bass'
  onClose: () => void
}

const MODE_OPTIONS = [
  {
    id: 'chord',
    label: '🎸 Chord & Rhythm Tab (Authentic Chords - Recommended)',
    desc: 'Extracts real harmonic chords & progressions with authentic CAGED/barre/power grips across all 6 strings'
  },
  {
    id: 'note',
    label: '🎼 Note-by-Note Solo Tab (Spotify Basic Pitch)',
    desc: 'Analyzes individual solo leads and melodies using Basic Pitch neural network'
  }
]

const VOICING_OPTIONS = [
  { id: 'standard', label: 'Standard / Open (CAGED Shapes)', desc: 'Natural acoustic & rhythm guitar open chord voicings' },
  { id: 'barre', label: 'Barre Chords (E & A shapes)', desc: 'Movable barre chords across mid-neck' },
  { id: 'power', label: 'Power Chords (5ths - Rock / Punk / Metal)', desc: 'Heavy root+5th power chord shapes' }
]

const GUITAR_TUNING_OPTIONS = [
  { id: 'standard', label: 'Standard (E A D G B e)', strings: ['e', 'B', 'G', 'D', 'A', 'E'], pitches: [64, 59, 55, 50, 45, 40] },
  { id: 'drop_d', label: 'Drop D (D A D G B e)', strings: ['e', 'B', 'G', 'D', 'A', 'D'], pitches: [64, 59, 55, 50, 45, 38] },
  { id: 'half_step_down', label: 'Half-Step Down (Eb Ab Db Gb Bb eb)', strings: ['eb', 'Bb', 'Gb', 'Db', 'Ab', 'Eb'], pitches: [63, 58, 54, 49, 44, 39] },
  { id: 'd_standard', label: 'D Standard (D G C F A d)', strings: ['d', 'A', 'F', 'C', 'G', 'D'], pitches: [62, 57, 53, 48, 43, 38] },
  { id: 'open_d', label: 'Open D (D A D F# A d)', strings: ['d', 'A', 'F#', 'D', 'A', 'D'], pitches: [62, 57, 54, 50, 45, 38] },
  { id: 'open_g', label: 'Open G (D G D G B d)', strings: ['d', 'B', 'G', 'D', 'G', 'D'], pitches: [62, 59, 55, 50, 43, 38] }
]

const BASS_TUNING_OPTIONS = [
  { id: 'standard', label: 'Standard 4-String (G D A E)', strings: ['G', 'D', 'A', 'E'], pitches: [43, 38, 33, 28] },
  { id: 'drop_d', label: 'Drop D (G D A D)', strings: ['G', 'D', 'A', 'D'], pitches: [43, 38, 33, 26] },
  { id: 'half_step_down', label: 'Half-Step Down (Gb Db Ab Eb)', strings: ['Gb', 'Db', 'Ab', 'Eb'], pitches: [42, 37, 32, 27] },
  { id: 'd_standard', label: 'D Standard (F C G D)', strings: ['F', 'C', 'G', 'D'], pitches: [41, 36, 31, 26] },
  { id: '5_string', label: '5-String Standard (G D A E B)', strings: ['G', 'D', 'A', 'E', 'B'], pitches: [43, 38, 33, 28, 23] },
  { id: '5_string_drop_a', label: '5-String Drop A (G D A E A)', strings: ['G', 'D', 'A', 'E', 'A'], pitches: [43, 38, 33, 28, 21] }
]

const POSITION_OPTIONS = [
  { id: 'auto', label: 'Auto (Smooth Position Anchor)', desc: 'Keeps hand in natural phrase boxes without erratic jumps' },
  { id: 'open', label: 'Open / Cowboy (Frets 0–4)', desc: 'Forces open strings and first 4 frets (ideal for rhythm & riffs)' },
  { id: 'mid', label: 'Mid-Neck (Frets 5–9)', desc: 'Plays in the 5th-fret pentatonic/barre zone' },
  { id: 'high', label: 'High-Neck (Frets 9–14)', desc: 'Plays upper register leads and solos' }
]

const SENSITIVITY_OPTIONS = [
  { id: 'clean', label: 'Clean (Recommended)', desc: 'Filters harmonics, bleeds & ghost chatter' },
  { id: 'sensitive', label: 'Sensitive', desc: 'Picks up faint ghost notes & rapid arpeggios' }
]

const FRET_COUNT = 22
const SINGLE_DOT_FRETS = new Set([3, 5, 7, 9, 15, 17, 19, 21])
const DOUBLE_DOT_FRET = 12

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
function midiToName(pitch: number): string {
  const octave = Math.floor(pitch / 12) - 1
  const name = NOTE_NAMES[pitch % 12]
  return `${name}${octave}`
}

export function TabStage({ song, instrument = 'guitar', onClose }: Props): React.ReactElement {
  const isBass = instrument === 'bass'
  const tuningOptions = isBass ? BASS_TUNING_OPTIONS : GUITAR_TUNING_OPTIONS

  const {
    playing,
    duration,
    getPosition,
    togglePlay,
    seekTo,
    solos,
    mutes,
    vols,
    toggleStemSolo,
    toggleStemMute,
    setStemVolume
  } = usePlayer()

  const [tabs, setTabs] = useState<GuitarTabData | null>(null)
  const [loading, setLoading] = useState(true)
  const [transcribing, setTranscribing] = useState(false)
  const [transcribeProgress, setTranscribeProgress] = useState<TabProgress | null>(null)
  const [viewMode, setViewMode] = useState<'interactive' | 'fretboard' | 'ascii'>('interactive')
  const [selectedMode, setSelectedMode] = useState<'chord' | 'note'>(isBass ? 'note' : 'chord')
  const [selectedVoicing, setSelectedVoicing] = useState<'standard' | 'barre' | 'power'>('standard')
  const [selectedTuning, setSelectedTuning] = useState('standard')
  const [selectedPosition, setSelectedPosition] = useState('auto')
  const [selectedSensitivity, setSelectedSensitivity] = useState('clean')
  const [showConfig, setShowConfig] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [copiedAscii, setCopiedAscii] = useState(false)
  const [exportNotice, setExportNotice] = useState<string | null>(null)

  const [midiPlayerEnabled, setMidiPlayerEnabled] = useState(false)
  const [midiVolume, setMidiVolume] = useState(0.85)
  const [synthInstrument, setSynthInstrument] = useState<SynthInstrument>(
    isBass ? 'bass_electric' : 'acoustic'
  )
  const [clickedFret, setClickedFret] = useState<{ string: number; fret: number; pitch: number } | null>(null)

  const tabContainerRef = useRef<HTMLDivElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  // Synchronize TabSynth with tab data
  useEffect(() => {
    if (tabs?.notes) {
      tabSynth.setNotes(tabs.notes)
    }
  }, [tabs?.notes])

  useEffect(() => {
    tabSynth.enabled = midiPlayerEnabled
  }, [midiPlayerEnabled])

  useEffect(() => {
    tabSynth.setVolume(midiVolume)
  }, [midiVolume])

  useEffect(() => {
    tabSynth.setInstrument(synthInstrument)
  }, [synthInstrument])

  // Stop ringing synth voices on pause or unmount
  useEffect(() => {
    if (!playing) {
      tabSynth.stopAllVoices()
    }
  }, [playing])

  useEffect(() => {
    return () => {
      tabSynth.stopAllVoices()
      tabSynth.reset(0)
    }
  }, [])

  // RAF loop for synchronized display during playback
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loop = (): void => {
      forceTick((n) => (n + 1) % 1000)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  const currentPos = getPosition()

  // Update MIDI synth notes lookahead during playback
  useEffect(() => {
    if (tabs?.notes && playing) {
      tabSynth.updatePlayback(currentPos, playing)
    }
  }, [currentPos, playing, tabs?.notes])

  // Keyboard shortcut: Space to toggle play, Escape to exit
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, onClose])

  // Load existing tabs on mount
  useEffect(() => {
    let unmounted = false
    setLoading(true)
    setErrorMsg(null)

    window.stemkit
      .getTabs(song.videoId, instrument)
      .then((data) => {
        if (!unmounted) {
          setTabs(data)
          if (data?.mode) setSelectedMode(data.mode)
          if (data?.voicingStyle && (data.voicingStyle === 'standard' || data.voicingStyle === 'barre' || data.voicingStyle === 'power')) {
            setSelectedVoicing(data.voicingStyle)
          }
          if (data?.positionAnchor) setSelectedPosition(data.positionAnchor)
          if (data?.sensitivity) setSelectedSensitivity(data.sensitivity)
          setLoading(false)
        }
      })
      .catch((err) => {
        if (!unmounted) {
          setErrorMsg(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })

    const unsubscribe = window.stemkit.onTabProgress((ev) => {
      if (ev.videoId === song.videoId && (ev.instrument ?? 'guitar') === instrument) {
        setTranscribeProgress(ev)
      }
    })

    return () => {
      unmounted = true
      unsubscribe()
    }
  }, [song.videoId, instrument])

  const handleTranscribe = useCallback(
    async (force = true) => {
      setTranscribing(true)
      setErrorMsg(null)
      setShowConfig(false)
      setTranscribeProgress({
        videoId: song.videoId,
        pct: 0,
        message: `Starting ${isBass ? 'bass' : 'guitar'} transcription…`,
        instrument
      })
      try {
        const res = await window.stemkit.transcribeTabs(
          song.videoId,
          selectedTuning,
          selectedPosition,
          selectedSensitivity,
          selectedMode,
          selectedVoicing,
          force,
          instrument
        )
        setTabs(res)
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err))
      } finally {
        setTranscribing(false)
        setTranscribeProgress(null)
      }
    },
    [
      song.videoId,
      selectedTuning,
      selectedPosition,
      selectedSensitivity,
      selectedMode,
      selectedVoicing,
      instrument,
      isBass
    ]
  )

  const handleExportAscii = async (): Promise<void> => {
    try {
      const res = await window.stemkit.exportTabAscii(song.videoId, instrument)
      if (res.saved) {
        setExportNotice('Saved tab text file')
        setTimeout(() => setExportNotice(null), 3000)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  const handleExportMidi = async (): Promise<void> => {
    try {
      const res = await window.stemkit.exportTabMidi(song.videoId, instrument)
      if (res.saved) {
        setExportNotice('Saved multi-track MIDI file')
        setTimeout(() => setExportNotice(null), 3000)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    }
  }

  const handleCopyAscii = (): void => {
    if (!tabs?.asciiTab) return
    void navigator.clipboard.writeText(tabs.asciiTab).then(() => {
      setCopiedAscii(true)
      setTimeout(() => setCopiedAscii(false), 2000)
    })
  }

  // Stem controls for playback
  const targetStem = isBass ? 'bass' : 'guitar'
  const isTargetSolo = solos.has(targetStem)
  const isTargetMuted = mutes.has(targetStem)
  const targetVolume = vols[targetStem] ?? 1

  const handleSoloTarget = (): void => {
    if (isTargetSolo) {
      toggleStemSolo(targetStem)
    } else {
      if (solos.size > 0) {
        solos.forEach((s) => {
          if (s !== targetStem) toggleStemSolo(s)
        })
      }
      toggleStemSolo(targetStem)
    }
  }

  const handleMuteTarget = (): void => {
    toggleStemMute(targetStem)
  }

  // Active sounding notes at current time
  const activeNotes = useMemo(() => {
    if (!tabs?.notes) return []
    return tabs.notes.filter(
      (n) => n.start <= currentPos && currentPos <= Math.max(n.start + 0.08, n.end)
    )
  }, [tabs?.notes, currentPos])

  const tuningStrings = useMemo(() => {
    if (tabs?.tuning && tabs.tuning.length > 0) {
      return tabs.tuning
    }
    const match = tuningOptions.find((t) => t.id === selectedTuning)
    return match ? match.strings : (isBass ? ['G', 'D', 'A', 'E'] : ['e', 'B', 'G', 'D', 'A', 'E'])
  }, [tabs?.tuning, selectedTuning, tuningOptions, isBass])

  const tuningPitches = useMemo(() => {
    if (tabs?.tuningPitches && tabs.tuningPitches.length > 0) {
      return tabs.tuningPitches
    }
    const match = tuningOptions.find((t) => t.id === selectedTuning)
    return match?.pitches ?? (isBass ? [43, 38, 33, 28] : [64, 59, 55, 50, 45, 40])
  }, [tabs?.tuningPitches, selectedTuning, tuningOptions, isBass])

  // Auto-scroll interactive tab playhead into view
  useEffect(() => {
    if (!playing || viewMode !== 'interactive' || !autoScroll) return
    const container = tabContainerRef.current
    if (!container) return

    const targetLeft = currentPos * PIXELS_PER_SECOND - container.clientWidth * 0.35
    container.scrollLeft = Math.max(0, targetLeft)
    if (container.scrollTop !== 0) {
      container.scrollTop = 0
    }
  }, [playing, currentPos, viewMode, autoScroll])

  const PIXELS_PER_SECOND = 90
  const totalTimelineWidth = Math.max(800, (duration || tabs?.duration || 1) * PIXELS_PER_SECOND)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0b0d09] text-white select-none animate-fadeIn overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-amber-500/5 via-transparent to-black pointer-events-none" />

      {/* macOS Window Controls Drag Region & Spacer */}
      <div className="drag-region h-9 w-full shrink-0 flex items-center justify-between px-4 border-b border-white/[0.06] bg-black/40">
        {/* 96px left spacer for macOS traffic lights (close, min, max) */}
        <div className="w-24 shrink-0 pointer-events-none" />
        <div className="flex items-center gap-2 text-[11px] font-mono font-medium text-white/40 uppercase tracking-wider">
          {isBass ? <BassIcon className="w-3.5 h-3.5 text-amber-400/80" /> : <GuitarIcon className="w-3.5 h-3.5 text-amber-400/80" />}
          <span>{isBass ? 'Bass Tablature' : 'Guitar Tablature'}</span>
        </div>
        <button
          onClick={onClose}
          className="no-drag flex items-center gap-1.5 px-3 py-1 rounded-lg glass hover:bg-white/10 text-white/70 hover:text-white text-xs transition-colors cursor-pointer"
          title="Exit Tab Stage (Esc)"
        >
          <XIcon className="w-3.5 h-3.5" />
          <span>Exit Stage</span>
        </button>
      </div>

      {/* Top Header */}
      <header className="relative z-20 flex items-center justify-between px-6 py-4 border-b border-white/10 bg-[#0e110b]/90 backdrop-blur-md">
        <div className="flex items-center gap-4 min-w-0">
          <Thumb
            videoId={song.videoId}
            className="w-14 h-14 rounded-xl object-cover ring-1 ring-white/10 shadow-md shrink-0"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-400/20 text-amber-300 border border-amber-400/30">
                {isBass ? <BassIcon className="w-3 h-3 text-amber-300" /> : <GuitarIcon className="w-3 h-3 text-amber-300" />}
                {isBass ? 'Playable Bass Tab' : 'Playable Guitar Tab'}
              </span>
              {tabs?.mode && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-400/15 text-amber-300 border border-amber-400/25">
                  {tabs.mode === 'chord' ? '🎸 Chord & Rhythm' : '🎼 Melodic Solo'}
                </span>
              )}
              {tabs?.voicingStyle && tabs?.mode !== 'note' && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-amber-500/15 text-amber-200 border border-amber-500/25 capitalize">
                  {tabs.voicingStyle} Voicings
                </span>
              )}
              {tabs?.bpm && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-mono font-medium bg-white/5 text-white/70 border border-white/10">
                  {tabs.bpm} BPM
                </span>
              )}
              {tabs?.mode === 'note' && tabs?.positionAnchor && (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 capitalize">
                  {tabs.positionAnchor === 'open' ? 'Open (Frets 0-4)' : tabs.positionAnchor === 'mid' ? 'Mid-Neck (Frets 5-9)' : tabs.positionAnchor === 'high' ? 'High-Neck' : 'Auto Anchor'}
                </span>
              )}
              {tabs?.notesCount ? (
                <span className="px-2 py-0.5 rounded-md text-[11px] font-mono font-medium bg-white/5 text-white/70 border border-white/10">
                  {tabs.notesCount.toLocaleString()} Notes
                </span>
              ) : null}
            </div>
            <h1 className="text-lg font-bold text-white truncate max-w-lg">{song.title}</h1>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-3 shrink-0">
          {tabs && (
            <div className="flex items-center rounded-xl p-1 bg-white/5 border border-white/10 text-xs">
              <button
                onClick={() => setViewMode('interactive')}
                className={`no-drag px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                  viewMode === 'interactive'
                    ? 'bg-amber-400 text-black font-semibold shadow-sm'
                    : 'text-white/60 hover:text-white'
                }`}
              >
                Interactive Tab
              </button>
              <button
                onClick={() => setViewMode('fretboard')}
                className={`no-drag px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                  viewMode === 'fretboard'
                    ? 'bg-amber-400 text-black font-semibold shadow-sm'
                    : 'text-white/60 hover:text-white'
                }`}
              >
                Fretboard
              </button>
              <button
                onClick={() => setViewMode('ascii')}
                className={`no-drag px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                  viewMode === 'ascii'
                    ? 'bg-amber-400 text-black font-semibold shadow-sm'
                    : 'text-white/60 hover:text-white'
                }`}
              >
                ASCII Tab
              </button>
            </div>
          )}

          {tabs && (
            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyAscii}
                className="no-drag glass hover:bg-white/10 px-3 py-2 rounded-xl text-xs font-medium text-white/80 hover:text-white border border-white/15 flex items-center gap-1.5 transition-all cursor-pointer"
                title="Copy entire ASCII tablature to clipboard"
              >
                {copiedAscii ? (
                  <>
                    <CheckIcon className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-300">Copied!</span>
                  </>
                ) : (
                  <>
                    <CopyIcon className="w-3.5 h-3.5" />
                    <span>Copy Tab</span>
                  </>
                )}
              </button>

              <button
                onClick={handleExportMidi}
                className="no-drag glass hover:bg-white/10 px-3 py-2 rounded-xl text-xs font-medium text-white/80 hover:text-white border border-white/15 flex items-center gap-1.5 transition-all cursor-pointer"
                title={`Export multi-channel MIDI file (channels map to strings for ${isBass ? 'Bass / TuxGuitar' : 'Guitar Pro / TuxGuitar'})`}
              >
                <DownloadIcon className="w-3.5 h-3.5" />
                <span>MIDI (.mid)</span>
              </button>

              <button
                onClick={handleExportAscii}
                className="no-drag glass hover:bg-white/10 px-3 py-2 rounded-xl text-xs font-medium text-white/80 hover:text-white border border-white/15 flex items-center gap-1.5 transition-all cursor-pointer"
                title="Export formatted text ASCII tab file"
              >
                <DownloadIcon className="w-3.5 h-3.5" />
                <span>Text (.txt)</span>
              </button>

              <button
                onClick={() => setShowConfig(!showConfig)}
                className={`no-drag glass hover:bg-white/10 p-2 rounded-xl border border-white/15 transition-all cursor-pointer ${
                  showConfig ? 'bg-amber-400/20 text-amber-300 border-amber-400/30' : 'text-white/70 hover:text-white'
                }`}
                title="Fretboard tuning & position preferences"
              >
                <GearIcon className="w-4 h-4" />
              </button>
            </div>
          )}

          <button
            onClick={onClose}
            className="no-drag glass hover:bg-rose-500/20 hover:border-rose-500/40 p-2 rounded-xl text-white/70 hover:text-rose-300 border border-white/15 transition-all cursor-pointer"
            title={`Close ${isBass ? 'bass' : 'guitar'} tab stage`}
          >
            <XIcon className="w-5 h-5" />
          </button>
        </div>
      </header>

      {/* Floating Tuning & Position Configuration Popover */}
      {showConfig && (
        <div className="absolute top-20 right-6 z-40 w-96 glass rounded-2xl border border-white/20 p-5 shadow-2xl space-y-4 animate-fadeIn">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <GearIcon className="w-3.5 h-3.5 text-amber-400" />
              Fretboard & Playability Settings
            </h3>
            <button onClick={() => setShowConfig(false)} className="text-white/50 hover:text-white">
              <XIcon className="w-4 h-4" />
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-white/70 mb-1.5">Transcription Engine</label>
            <select
              value={selectedMode}
              onChange={(e) => setSelectedMode(e.target.value as 'chord' | 'note')}
              className="w-full bg-black/60 border border-white/15 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400 font-medium"
            >
              {MODE_OPTIONS.map((m) => (
                <option key={m.id} value={m.id} className="bg-[#12140e] text-white">
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-white/40 mt-1">
              {MODE_OPTIONS.find((m) => m.id === selectedMode)?.desc}
            </p>
          </div>

          {selectedMode === 'chord' && (
            <div>
              <label className="block text-xs font-medium text-white/70 mb-1.5">{isBass ? 'Voicing Style' : 'Guitar Voicing Style'}</label>
              <select
                value={selectedVoicing}
                onChange={(e) => setSelectedVoicing(e.target.value as 'standard' | 'barre' | 'power')}
                className="w-full bg-black/60 border border-white/15 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
              >
                {VOICING_OPTIONS.map((v) => (
                  <option key={v.id} value={v.id} className="bg-[#12140e] text-white">
                    {v.label}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-white/40 mt-1">
                {VOICING_OPTIONS.find((v) => v.id === selectedVoicing)?.desc}
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-white/70 mb-1.5">{isBass ? 'Bass Tuning' : 'Guitar Tuning'}</label>
            <select
              value={selectedTuning}
              onChange={(e) => setSelectedTuning(e.target.value)}
              className="w-full bg-black/60 border border-white/15 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
            >
              {tuningOptions.map((t) => (
                <option key={t.id} value={t.id} className="bg-[#12140e] text-white">
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {selectedMode === 'note' && (
            <>
              <div>
                <label className="block text-xs font-medium text-white/70 mb-1.5">Fretboard Position Anchor</label>
                <select
                  value={selectedPosition}
                  onChange={(e) => setSelectedPosition(e.target.value)}
                  className="w-full bg-black/60 border border-white/15 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
                >
                  {POSITION_OPTIONS.map((p) => (
                    <option key={p.id} value={p.id} className="bg-[#12140e] text-white">
                      {p.label}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-white/40 mt-1">
                  {POSITION_OPTIONS.find((p) => p.id === selectedPosition)?.desc}
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-white/70 mb-1.5">Detection Sensitivity</label>
                <select
                  value={selectedSensitivity}
                  onChange={(e) => setSelectedSensitivity(e.target.value)}
                  className="w-full bg-black/60 border border-white/15 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-amber-400"
                >
                  {SENSITIVITY_OPTIONS.map((s) => (
                    <option key={s.id} value={s.id} className="bg-[#12140e] text-white">
                      {s.label}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-white/40 mt-1">
                  {SENSITIVITY_OPTIONS.find((s) => s.id === selectedSensitivity)?.desc}
                </p>
              </div>
            </>
          )}

          <button
            onClick={() => void handleTranscribe(true)}
            disabled={transcribing}
            className="w-full py-2.5 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 text-black font-semibold text-xs hover:from-amber-300 hover:to-amber-400 transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40"
          >
            <RefreshIcon className={`w-3.5 h-3.5 ${transcribing ? 'animate-spin' : ''}`} />
            Re-solve Tab with These Settings
          </button>
        </div>
      )}

      {exportNotice && (
        <div className="absolute top-20 right-6 z-30 px-4 py-2 rounded-xl bg-emerald-500/90 text-black font-semibold text-xs shadow-lg animate-bounce">
          {exportNotice}
        </div>
      )}

      {/* Main Content Area */}
      <div className="relative z-10 flex-1 flex flex-col min-h-0 overflow-hidden">
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
            {isBass ? <BassIcon className="w-12 h-12 text-amber-400 animate-pulse" /> : <GuitarIcon className="w-12 h-12 text-amber-400 animate-pulse" />}
            <p className="text-sm text-white/60">Checking for {isBass ? 'bass' : 'guitar'} tablature…</p>
          </div>
        ) : transcribing ? (
          <div className="h-full flex flex-col items-center justify-center max-w-md mx-auto text-center px-4">
            <div className="w-16 h-16 rounded-2xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center mb-6 shadow-xl">
              {isBass ? <BassIcon className="w-8 h-8 text-amber-400 animate-bounce" /> : <GuitarIcon className="w-8 h-8 text-amber-400 animate-bounce" />}
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Transcribing {isBass ? 'Bass' : 'Guitar'} with AI</h2>
            <p className="text-xs text-white/50 mb-6 leading-relaxed">
              Analyzing the isolated {isBass ? 'bass' : 'guitar'} stem using Spotify Basic Pitch, filtering {isBass ? 'sub-bass harmonics' : 'overtones'}, and solving position-anchored fretboard fingerings.
            </p>

            <div className="w-full bg-white/10 rounded-full h-3 overflow-hidden p-0.5 border border-white/10 mb-3">
              <div
                className="bg-gradient-to-r from-amber-400 to-amber-500 h-full rounded-full transition-all duration-300 shadow-sm shadow-amber-400/50"
                style={{ width: `${Math.max(6, transcribeProgress?.pct ?? 0)}%` }}
              />
            </div>
            <p className="text-xs font-mono text-amber-300/80">
              {transcribeProgress?.message ?? 'Processing audio…'} ({transcribeProgress?.pct ?? 0}%)
            </p>
          </div>
        ) : !tabs ? (
          /* Initial Empty Setup View */
          <div className="h-full flex flex-col items-center justify-center max-w-lg mx-auto text-center px-6">
            <div className="w-20 h-20 rounded-3xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center mb-6 shadow-2xl">
              {isBass ? <BassIcon className="w-10 h-10 text-amber-400" /> : <GuitarIcon className="w-10 h-10 text-amber-400" />}
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">Generate Playable {isBass ? 'Bass' : 'Guitar'} Tabs</h2>
            <p className="text-sm text-white/60 mb-6 leading-relaxed">
              {isBass
                ? 'Extract authentic, playable bass tablature from the isolated bass stem. Solves natural hand positions across 4-string or 5-string setups with clean note tracking.'
                : 'Extract authentic, playable guitar tablature from the isolated guitar stem. Choose Chord & Rhythm mode for real CAGED/power chords, or Melodic Solo mode for single-note leads.'}
            </p>

            {errorMsg && (
              <div className="w-full mb-6 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs text-left">
                {errorMsg}
              </div>
            )}

            {/* Initial Options */}
            <div className="w-full glass p-5 rounded-2xl border border-white/10 mb-6 text-left space-y-4">
              <div>
                <label className="block text-xs font-medium text-white/70 mb-1.5">Transcription Engine</label>
                <select
                  value={selectedMode}
                  onChange={(e) => setSelectedMode(e.target.value as 'chord' | 'note')}
                  className="w-full bg-black/50 border border-white/20 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400 font-medium"
                >
                  {MODE_OPTIONS.map((m) => (
                    <option key={m.id} value={m.id} className="bg-[#12140e] text-white">
                      {m.label}
                    </option>
                  ))}
                </select>
                <p className="text-[10px] text-white/40 mt-1">
                  {MODE_OPTIONS.find((m) => m.id === selectedMode)?.desc}
                </p>
              </div>

              {selectedMode === 'chord' ? (
                <div>
                  <label className="block text-xs font-medium text-white/70 mb-1.5">{isBass ? 'Voicing Style' : 'Guitar Voicing Style'}</label>
                  <select
                    value={selectedVoicing}
                    onChange={(e) => setSelectedVoicing(e.target.value as 'standard' | 'barre' | 'power')}
                    className="w-full bg-black/50 border border-white/20 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400"
                  >
                    {VOICING_OPTIONS.map((v) => (
                      <option key={v.id} value={v.id} className="bg-[#12140e] text-white">
                        {v.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-medium text-white/70 mb-1.5">Hand Position Preference</label>
                  <select
                    value={selectedPosition}
                    onChange={(e) => setSelectedPosition(e.target.value)}
                    className="w-full bg-black/50 border border-white/20 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400"
                  >
                    {POSITION_OPTIONS.map((p) => (
                      <option key={p.id} value={p.id} className="bg-[#12140e] text-white">
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-white/70 mb-1.5">{isBass ? 'Bass Tuning' : 'Guitar Tuning'}</label>
                <select
                  value={selectedTuning}
                  onChange={(e) => setSelectedTuning(e.target.value)}
                  className="w-full bg-black/50 border border-white/20 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-amber-400"
                >
                  {tuningOptions.map((t) => (
                    <option key={t.id} value={t.id} className="bg-[#12140e] text-white">
                      {t.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <button
              onClick={() => void handleTranscribe(true)}
              className="w-full px-6 py-3.5 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 text-black font-semibold text-sm hover:from-amber-300 hover:to-amber-400 transition-all shadow-lg hover:shadow-amber-500/25 cursor-pointer flex items-center justify-center gap-2"
            >
              {isBass ? <BassIcon className="w-4 h-4 text-black" /> : <GuitarIcon className="w-4 h-4 text-black" />}
              Generate {isBass ? 'Bass' : 'Guitar'} Tabs
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* Live Fretboard Visualizer */}
            {(viewMode === 'interactive' || viewMode === 'fretboard') && (
              <div className={`px-6 py-4 border-b border-white/10 bg-[#0d1009]/95 shrink-0 ${viewMode === 'fretboard' ? 'flex-1 flex flex-col justify-center' : ''}`}>
                <div className="max-w-6xl mx-auto w-full">
                  <div className="flex items-center justify-between h-7 min-h-[28px] max-h-[28px] mb-2 overflow-hidden select-none">
                    <span className="text-xs font-semibold text-white/60 uppercase tracking-wider flex items-center gap-2 shrink-0">
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                      Fretboard View
                    </span>
                    <div className="flex items-center gap-2 h-7 shrink-0">
                      {clickedFret && (
                        <span className="h-6 px-2.5 rounded-md text-xs font-mono font-bold bg-amber-400 text-black shadow-sm flex items-center shrink-0 animate-pulse">
                          Audition: Str {clickedFret.string}·Fret {clickedFret.fret} ({midiToName(clickedFret.pitch)})
                        </span>
                      )}
                      {activeNotes.length > 0 && activeNotes[0].chord && (
                        <span className="h-6 px-2.5 rounded-md text-xs font-mono font-bold bg-amber-300 text-black shadow-sm border border-amber-400 flex items-center shrink-0">
                          Chord: {activeNotes[0].chord}
                        </span>
                      )}
                      {activeNotes.length > 0 ? (
                        <div className="flex items-center gap-1.5 overflow-hidden">
                          {activeNotes.map((n) => (
                            <span
                              key={`${n.string}-${n.fret}`}
                              className="h-6 px-2 rounded-md text-[11px] font-mono font-bold bg-amber-400/90 text-black flex items-center shrink-0 shadow-sm"
                            >
                              Str {n.string}·{n.fret}
                            </span>
                          ))}
                        </div>
                      ) : (
                        !clickedFret && (
                          <span className="h-6 text-xs text-white/30 font-mono italic flex items-center">
                            Click any fret to audition
                          </span>
                        )
                      )}
                    </div>
                  </div>

                  {/* Fretboard SVG / Canvas UI */}
                  <div className="relative w-full bg-[#1b1712] rounded-xl p-3 border border-amber-900/30 shadow-2xl overflow-x-auto overflow-y-hidden">
                    <div className="relative min-w-[750px] h-32 flex flex-col justify-between py-2 overflow-hidden">
                      {/* Strings */}
                      {tuningStrings.map((sName, sIdx) => {
                        const stringNum = sIdx + 1
                        const stringCount = tuningStrings.length
                        const thickness = isBass
                          ? 2 + (stringCount - stringNum) * 0.9
                          : 1 + (stringCount - stringNum) * 0.5
                        return (
                          <div key={sIdx} className="relative w-full flex items-center h-4">
                            <span className="absolute -left-6 text-[10px] font-mono font-bold text-amber-200/60 w-5 text-right">
                              {sName}
                            </span>
                            <div
                              className="w-full bg-gradient-to-r from-amber-100/40 via-amber-200/60 to-amber-100/40 shadow-sm"
                              style={{ height: `${thickness}px` }}
                            />
                          </div>
                        )
                      })}

                      {/* Fret dividers */}
                      <div className="absolute inset-0 flex pointer-events-none pl-4">
                        {[...Array(FRET_COUNT + 1)].map((_, f) => {
                          const isNut = f === 0
                          const hasSingleDot = SINGLE_DOT_FRETS.has(f)
                          const hasDoubleDot = f === DOUBLE_DOT_FRET

                          return (
                            <div
                              key={f}
                              className={`flex-1 relative border-r ${
                                isNut ? 'border-r-4 border-amber-100/80' : 'border-r border-stone-500/40'
                              } flex items-center justify-center`}
                            >
                              <span className="absolute -bottom-4 text-[9px] font-mono text-white/30">
                                {f}
                              </span>

                              {hasSingleDot && (
                                <div className="w-2.5 h-2.5 rounded-full bg-stone-300/40 shadow-inner" />
                              )}
                              {hasDoubleDot && (
                                <div className="flex flex-col gap-4">
                                  <div className="w-2 h-2 rounded-full bg-stone-300/40 shadow-inner" />
                                  <div className="w-2 h-2 rounded-full bg-stone-300/40 shadow-inner" />
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>

                      {/* Interactive Clickable Fret Cells */}
                      <div className="absolute inset-0 flex pl-4 z-10 pointer-events-auto">
                        {[...Array(FRET_COUNT + 1)].map((_, f) => (
                          <div key={f} className="flex-1 flex flex-col justify-between py-2">
                            {tuningStrings.map((_, sIdx) => {
                              const stringNum = sIdx + 1
                              const stringPitch = tuningPitches[sIdx] ?? (isBass ? [43, 38, 33, 28][sIdx] : [64, 59, 55, 50, 45, 40][sIdx])
                              const pitch = stringPitch + f
                              const isAuditioning = clickedFret?.string === stringNum && clickedFret?.fret === f

                              return (
                                <button
                                  key={sIdx}
                                  type="button"
                                  onClick={() => {
                                    tabSynth.auditionNote(pitch, 0.75, 0.9)
                                    setClickedFret({ string: stringNum, fret: f, pitch })
                                    setTimeout(() => {
                                      setClickedFret((curr) =>
                                        curr?.string === stringNum && curr?.fret === f ? null : curr
                                      )
                                    }, 600)
                                  }}
                                  title={`Click to pluck: String ${stringNum} (${tuningStrings[sIdx]}), Fret ${f} (${midiToName(pitch)})`}
                                  className={`h-4 w-full rounded transition-all cursor-pointer ${
                                    isAuditioning
                                      ? 'bg-amber-400/40 ring-1 ring-amber-300'
                                      : 'hover:bg-amber-400/20 active:bg-amber-400/40'
                                  }`}
                                />
                              )
                            })}
                          </div>
                        ))}
                      </div>

                      {/* Sounding Active Note Badges on Fretboard */}
                      {activeNotes.map((n) => {
                        const stringIdx = n.string - 1
                        const stringCount = tuningStrings.length
                        const fretWidthPct = 100 / (FRET_COUNT + 1)
                        const fretLeftPct = n.fret === 0 ? 0 : (n.fret - 0.5) * fretWidthPct
                        const numIntervals = Math.max(1, stringCount - 1)

                        return (
                          <div
                            key={`${n.string}-${n.fret}`}
                            className="absolute -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none"
                            style={{
                              top: `calc(16px + ${stringIdx} * ((100% - 32px) / ${numIntervals}))`,
                              left: `calc(${fretLeftPct}% + 16px)`
                            }}
                          >
                            <div className="w-6 h-6 rounded-full bg-gradient-to-br from-amber-300 to-amber-500 text-black font-black text-[10px] flex items-center justify-center shadow-lg shadow-amber-400/80 border-2 border-white">
                              {n.fret}
                            </div>
                          </div>
                        )
                      })}

                      {/* Click Audition Glow Badge */}
                      {clickedFret && !activeNotes.some(n => n.string === clickedFret.string && n.fret === clickedFret.fret) && (
                        <div
                          className="absolute -translate-x-1/2 -translate-y-1/2 z-20 pointer-events-none"
                          style={{
                            top: `calc(16px + ${(clickedFret.string - 1)} * ((100% - 32px) / ${Math.max(1, tuningStrings.length - 1)}))`,
                            left: `calc(${clickedFret.fret === 0 ? 0 : (clickedFret.fret - 0.5) * (100 / (FRET_COUNT + 1))}% + 16px)`
                          }}
                        >
                          <div className="w-6 h-6 rounded-full bg-amber-400 text-black font-black text-[10px] flex items-center justify-center shadow-lg shadow-amber-400/90 border-2 border-white animate-pulse">
                            {clickedFret.fret}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Interactive Scrolling Tab Staff View */}
            {viewMode === 'interactive' && (
              <div
                ref={tabContainerRef}
                className="flex-1 overflow-x-auto overflow-y-hidden bg-[#0c0e09] relative cursor-crosshair p-6 select-none"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const clickX = e.clientX - rect.left + e.currentTarget.scrollLeft
                  const newSeconds = Math.max(0, Math.min(duration || tabs.duration, clickX / PIXELS_PER_SECOND))
                  seekTo(newSeconds)
                  tabSynth.reset(newSeconds)
                }}
              >
                <div
                  className="relative h-64 select-none"
                  style={{ width: `${totalTimelineWidth}px` }}
                >
                  {/* Measure Bar Dividers */}
                  {tabs.measures &&
                    tabs.measures.map((m) => {
                      const mLeft = m.start * PIXELS_PER_SECOND
                      return (
                        <div
                          key={m.number}
                          className="absolute top-0 bottom-0 border-l border-white/15 pointer-events-none"
                          style={{ left: `${mLeft}px` }}
                        >
                          <div className="absolute top-0 left-2 flex items-center gap-1.5 z-10 pointer-events-none">
                            <span className="text-[10px] font-mono font-semibold text-white/40">
                              Bar {m.number}
                            </span>
                            {m.chord && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-400/20 text-amber-300 font-bold text-[11px] font-mono border border-amber-400/30 shadow-sm backdrop-blur-sm">
                                {m.chord}
                              </span>
                            )}
                          </div>
                        </div>
                      )
                    })}

                  {/* 6 Tab String Lines */}
                  {tuningStrings.map((sName, sIdx) => {
                    const stringTop = sIdx * 34 + 32
                    return (
                      <div
                        key={sIdx}
                        className="absolute left-0 right-0 border-b border-white/20 flex items-center"
                        style={{ top: `${stringTop}px` }}
                      >
                        <span className="sticky left-0 z-20 w-8 h-6 bg-[#0c0e09]/90 border-r border-white/20 text-xs font-mono font-bold text-amber-300 flex items-center justify-center shadow-md">
                          {sName}
                        </span>
                      </div>
                    )
                  })}

                  {/* Render Tab Notes */}
                  {tabs.notes.map((n, idx) => {
                    const stringIdx = n.string - 1
                    const topPos = stringIdx * 34 + 32
                    const leftPos = n.start * PIXELS_PER_SECOND
                    const isActive = n.start <= currentPos && currentPos <= n.end

                    return (
                      <div
                        key={idx}
                        onClick={(e) => {
                          e.stopPropagation()
                          tabSynth.auditionNote(n.pitch, Math.max(0.4, n.end - n.start), n.amplitude || 0.85)
                          setClickedFret({ string: n.string, fret: n.fret, pitch: n.pitch })
                          setTimeout(() => {
                            setClickedFret((curr) =>
                              curr?.string === n.string && curr?.fret === n.fret ? null : curr
                            )
                          }, 600)
                        }}
                        className={`absolute -translate-y-1/2 z-10 flex items-center justify-center rounded-md font-mono text-xs font-bold select-none cursor-pointer transition-transform hover:scale-125 active:scale-95 ${
                          isActive
                            ? 'bg-amber-400 text-black shadow-md shadow-amber-400/50 z-20 border border-white scale-110'
                            : 'bg-zinc-800 text-amber-200 border border-amber-400/30 hover:bg-amber-500/30 hover:border-amber-400'
                        }`}
                        style={{
                          top: `${topPos}px`,
                          left: `${leftPos}px`,
                          minWidth: '22px',
                          height: '22px',
                          padding: '0 4px'
                        }}
                        title={`Click to pluck note: Fret ${n.fret} on String ${n.string} (${midiToName(n.pitch)}) at ${fmtTime(n.start)}`}
                      >
                        {n.fret}
                      </div>
                    )
                  })}

                  {/* Playhead */}
                  <div
                    id="tab-playhead"
                    className="absolute top-0 bottom-0 w-0.5 bg-amber-400 z-30 pointer-events-none shadow-[0_0_8px_rgba(251,191,36,0.8)]"
                    style={{ left: `${currentPos * PIXELS_PER_SECOND}px` }}
                  >
                    <div className="w-3 h-3 -ml-[5px] -top-1.5 absolute bg-amber-400 rounded-full border-2 border-white shadow-md" />
                  </div>
                </div>
              </div>
            )}

            {/* ASCII Tab Text View */}
            {viewMode === 'ascii' && (
              <div className="flex-1 overflow-auto bg-[#080906] p-6 font-mono text-xs text-amber-200/90 leading-relaxed select-text">
                <div className="max-w-4xl mx-auto space-y-4">
                  <div className="flex items-center justify-between border-b border-white/10 pb-3">
                    <span className="text-white/60">Standard ASCII Tablature (16th-note Quantized Grid)</span>
                    <button
                      onClick={handleCopyAscii}
                      className="px-3 py-1.5 rounded-lg bg-amber-400/20 text-amber-300 hover:bg-amber-400/30 font-medium transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      {copiedAscii ? <CheckIcon className="w-3.5 h-3.5 text-emerald-400" /> : <CopyIcon className="w-3.5 h-3.5" />}
                      <span>{copiedAscii ? 'Copied' : 'Copy Text'}</span>
                    </button>
                  </div>
                  <pre className="p-4 rounded-xl bg-black/40 border border-white/10 overflow-x-auto whitespace-pre font-mono">
                    {tabs.asciiTab}
                  </pre>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Transport */}
      <footer className="relative z-20 px-6 py-4 bg-[#0e110b] border-t border-white/10 flex flex-col gap-3">
        <div className="flex items-center gap-3 w-full">
          <span className="text-xs font-mono text-white/50 w-12 text-right">
            {fmtTime(currentPos)}
          </span>
          <div
            className="flex-1 h-2 rounded-full bg-white/10 relative cursor-pointer group"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              const pct = (e.clientX - rect.left) / rect.width
              const newSeconds = Math.max(0, Math.min(duration || tabs?.duration || 0, pct * (duration || tabs?.duration || 0)))
              seekTo(newSeconds)
              tabSynth.reset(newSeconds)
            }}
          >
            <div
              className="h-full bg-gradient-to-r from-amber-400 to-amber-500 rounded-full"
              style={{
                width: `${duration > 0 ? (currentPos / duration) * 100 : 0}%`
              }}
            />
          </div>
          <span className="text-xs font-mono text-white/50 w-12">
            {fmtTime(duration || tabs?.duration || 0)}
          </span>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2.5 flex-wrap">
            <button
              onClick={togglePlay}
              className="no-drag w-10 h-10 rounded-full bg-amber-400 text-black hover:bg-amber-300 flex items-center justify-center shadow-lg shadow-amber-400/20 transition-all cursor-pointer"
              title={playing ? 'Pause' : 'Play'}
            >
              {playing ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5 ml-0.5" />}
            </button>

            <div className="flex items-center gap-2 pl-2">
              <button
                onClick={() => setAutoScroll((v) => !v)}
                className={`no-drag px-3 py-1.5 rounded-xl text-xs font-medium border transition-all cursor-pointer flex items-center gap-1.5 ${
                  autoScroll
                    ? 'bg-amber-400/20 text-amber-300 border-amber-400/40 shadow-sm'
                    : 'glass text-white/40 hover:text-white border-white/10'
                }`}
                title="Toggle smooth auto-scrolling follow mode during playback"
              >
                <span className={`w-1.5 h-1.5 rounded-full ${autoScroll ? 'bg-amber-400 animate-pulse' : 'bg-white/30'}`} />
                <span>Auto-scroll {autoScroll ? 'ON' : 'OFF'}</span>
              </button>

              <button
                onClick={handleSoloTarget}
                className={`no-drag px-3 py-1.5 rounded-xl text-xs font-medium border transition-all cursor-pointer flex items-center gap-1.5 ${
                  isTargetSolo
                    ? 'bg-amber-400/20 text-amber-300 border-amber-400/40 shadow-sm'
                    : 'glass text-white/70 hover:text-white border-white/10'
                }`}
                title={`Solo ${isBass ? 'bass' : 'guitar'} stem to focus strictly on ${isBass ? 'bass' : 'guitar'} playback`}
              >
                {isBass ? <BassIcon className="w-3.5 h-3.5" /> : <GuitarIcon className="w-3.5 h-3.5" />}
                <span>{isBass ? 'Solo Bass' : 'Solo Guitar'}</span>
              </button>

              <button
                onClick={handleMuteTarget}
                className={`no-drag px-3 py-1.5 rounded-xl text-xs font-medium border transition-all cursor-pointer flex items-center gap-1.5 ${
                  isTargetMuted
                    ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 shadow-sm'
                    : 'glass text-white/70 hover:text-white border-white/10'
                }`}
                title={`Mute original ${isBass ? 'bass' : 'guitar'} so you can play along (or listen to the clean MIDI synth!)`}
              >
                {isTargetMuted ? <VolumeMuteIcon className="w-3.5 h-3.5" /> : <VolumeIcon className="w-3.5 h-3.5" />}
                <span>{isTargetMuted ? (isBass ? 'Bass Muted' : 'Guitar Muted') : (isBass ? 'Mute Bass' : 'Mute Guitar')}</span>
              </button>
            </div>
          </div>

          {/* Center: MIDI Synthesizer Player */}
          <div className="flex items-center gap-2 bg-[#12160d] border border-white/15 rounded-2xl px-3 py-1.5 shadow-inner flex-wrap">
            <button
              onClick={() => setMidiPlayerEnabled((v) => !v)}
              className={`no-drag px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all cursor-pointer flex items-center gap-2 ${
                midiPlayerEnabled
                  ? 'bg-amber-400 text-black border-amber-300 shadow-md shadow-amber-400/30'
                  : 'glass text-white/60 hover:text-white border-white/15'
              }`}
              title="Toggle real-time synthesized MIDI playback of transcribed tab notes"
            >
              <MusicNoteIcon className="w-3.5 h-3.5" />
              <span>MIDI Synth {midiPlayerEnabled ? 'ON' : 'OFF'}</span>
            </button>

            {midiPlayerEnabled && (
              <>
                <select
                  value={synthInstrument}
                  onChange={(e) => setSynthInstrument(e.target.value as SynthInstrument)}
                  className="bg-black/60 border border-white/20 rounded-xl px-2.5 py-1 text-xs text-amber-200 focus:outline-none focus:border-amber-400 cursor-pointer font-medium"
                  title="Synthesizer tone"
                >
                  {SYNTH_INSTRUMENTS.map((inst) => (
                    <option key={inst.id} value={inst.id} className="bg-[#12140e] text-white">
                      {inst.name}
                    </option>
                  ))}
                </select>

                <div className="flex items-center gap-2 text-xs text-white/70 pl-2 border-l border-white/15">
                  <span className="font-mono text-[11px] text-amber-300 font-medium">Synth Vol</span>
                  <input
                    type="range"
                    min="0"
                    max="1"
                    step="0.01"
                    value={midiVolume}
                    onChange={(e) => setMidiVolume(parseFloat(e.target.value))}
                    className="no-drag w-16 accent-amber-400 h-1.5 bg-white/10 rounded-lg cursor-pointer"
                    title={`MIDI Synth Volume: ${Math.round(midiVolume * 100)}%`}
                  />
                </div>
              </>
            )}
          </div>

          {/* Right: Original Stem Volume Slider */}
          <div className="flex items-center gap-2 text-xs text-white/60">
            <VolumeIcon className="w-3.5 h-3.5 text-white/40" />
            <span className="font-medium text-white/70">{isBass ? 'Orig Bass' : 'Orig Guitar'}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={targetVolume}
              onChange={(e) => setStemVolume(targetStem, parseFloat(e.target.value))}
              className="no-drag w-24 accent-amber-400 h-1.5 bg-white/10 rounded-lg cursor-pointer"
              title={`Original ${isBass ? 'bass' : 'guitar'} stem volume: ${Math.round(targetVolume * 100)}%`}
            />
          </div>
        </div>
      </footer>
    </div>
  )
}
