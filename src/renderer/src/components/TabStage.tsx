import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  SYNTH_LANE_FOR,
  type GuitarTabData,
  type MidiFileInfo,
  type Song,
  type TabInstrument,
  type TabEngine,
  type TabMode,
  type TabNote,
  type TabProgress,
  type TabVoicing
} from '../../../shared/types'
import { usePlayer } from '../lib/PlayerContext'
import { fmtTime } from '../lib/format'
import { Thumb } from '../lib/thumbs'
import {
  BassIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  GearIcon,
  GuitarIcon,
  ImportIcon,
  MixerIcon,
  MusicNoteIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  VolumeIcon,
  VolumeMuteIcon,
  XIcon
} from './Icons'
import { PracticeControls } from './PracticeControls'
import { renderNotesToBuffer, tabSynth, SYNTH_INSTRUMENTS, type SynthInstrument } from '../lib/midiSynth'

interface Props {
  song: Song
  instrument?: TabInstrument
  onClose: () => void
}

type EngineMode = Exclude<TabMode, 'note'>

const GUITAR_MODES: { id: EngineMode; label: string; desc: string }[] = [
  {
    id: 'poly',
    label: 'Notes & riffs',
    desc: 'Polyphonic neural transcription (Basic Pitch) anchored to a pitch tracker. Best default for riffs, arpeggios and lead lines.'
  },
  {
    id: 'lead',
    label: 'Single-note lead',
    desc: 'Monophonic pitch tracking with onset and legato detection. Cleanest result for solos and melodies played one note at a time.'
  },
  {
    id: 'chord',
    label: 'Chords & strums',
    desc: 'Detects the chord progression and writes real voicings at the strums actually played. For rhythm guitar parts.'
  }
]

const VOICING_OPTIONS: { id: TabVoicing; label: string }[] = [
  { id: 'standard', label: 'Open shapes (CAGED)' },
  { id: 'barre', label: 'Barre chords' },
  { id: 'power', label: 'Power chords' }
]

const GUITAR_TUNINGS = [
  { id: 'standard', label: 'Standard (E A D G B e)', strings: ['e', 'B', 'G', 'D', 'A', 'E'], pitches: [64, 59, 55, 50, 45, 40] },
  { id: 'drop_d', label: 'Drop D', strings: ['e', 'B', 'G', 'D', 'A', 'D'], pitches: [64, 59, 55, 50, 45, 38] },
  { id: 'half_step_down', label: 'Half-step down (Eb)', strings: ['eb', 'Bb', 'Gb', 'Db', 'Ab', 'Eb'], pitches: [63, 58, 54, 49, 44, 39] },
  { id: 'd_standard', label: 'D standard', strings: ['d', 'A', 'F', 'C', 'G', 'D'], pitches: [62, 57, 53, 48, 43, 38] },
  { id: 'drop_c', label: 'Drop C', strings: ['d', 'A', 'F', 'C', 'G', 'C'], pitches: [62, 57, 53, 48, 43, 36] },
  { id: 'open_d', label: 'Open D', strings: ['d', 'A', 'F#', 'D', 'A', 'D'], pitches: [62, 57, 54, 50, 45, 38] },
  { id: 'open_g', label: 'Open G', strings: ['d', 'B', 'G', 'D', 'G', 'D'], pitches: [62, 59, 55, 50, 43, 38] }
]

const BASS_TUNINGS = [
  { id: 'standard', label: 'Standard 4-string (E A D G)', strings: ['G', 'D', 'A', 'E'], pitches: [43, 38, 33, 28] },
  { id: 'drop_d', label: 'Drop D', strings: ['G', 'D', 'A', 'D'], pitches: [43, 38, 33, 26] },
  { id: 'half_step_down', label: 'Half-step down (Eb)', strings: ['Gb', 'Db', 'Ab', 'Eb'], pitches: [42, 37, 32, 27] },
  { id: 'd_standard', label: 'D standard', strings: ['F', 'C', 'G', 'D'], pitches: [41, 36, 31, 26] },
  { id: '5_string', label: '5-string (B E A D G)', strings: ['G', 'D', 'A', 'E', 'B'], pitches: [43, 38, 33, 28, 23] },
  { id: '5_string_drop_a', label: '5-string drop A', strings: ['G', 'D', 'A', 'E', 'A'], pitches: [43, 38, 33, 28, 21] }
]

const POSITION_OPTIONS = [
  { id: 'auto', label: 'Auto (smooth hand position)' },
  { id: 'open', label: 'Open position · frets 0–4' },
  { id: 'mid', label: 'Mid neck · frets 5–9' },
  { id: 'high', label: 'High neck · frets 9–14' },
  { id: 'octave', label: 'Octave · frets 12–16' }
]

const SENSITIVITY_OPTIONS = [
  { id: 'clean', label: 'Clean', desc: 'Ignores faint ghost notes and bleed' },
  { id: 'sensitive', label: 'Sensitive', desc: 'Keeps quiet notes and fast passages' }
]

const FRET_COUNT = 22
const SINGLE_DOTS = new Set([3, 5, 7, 9, 15, 17, 19, 21])
const STRING_GAP = 30
const STAFF_TOP = 46
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function midiToName(pitch: number): string {
  return `${NOTE_NAMES[pitch % 12]}${Math.floor(pitch / 12) - 1}`
}

function modeLabel(mode?: TabMode, source?: string): string {
  if (source === 'midi') return 'MIDI import'
  switch (mode) {
    case 'chord':
      return 'Chords & strums'
    case 'lead':
      return 'Single-note lead'
    default:
      return 'Notes & riffs'
  }
}

const ARTICULATION_GLYPH: Record<NonNullable<TabNote['articulation']>, string> = {
  hammer: 'h',
  pull: 'p',
  slide: '/'
}

interface FretboardProps {
  strings: string[]
  pitches: number[]
  isBass: boolean
  activeNotes: TabNote[]
  clicked: { string: number; fret: number } | null
  showNames: boolean
  tall: boolean
  onPluck: (stringNum: number, fret: number, pitch: number) => void
}

function Fretboard({ strings, pitches, isBass, activeNotes, clicked, showNames, tall, onPluck }: FretboardProps): React.ReactElement {
  const count = strings.length
  const rows = tall ? 'h-56' : 'h-28'
  const fretW = 100 / (FRET_COUNT + 1)
  return (
    <div className="relative w-full rounded-xl bg-[#1a1611] border border-amber-900/30 shadow-inner overflow-x-auto overflow-y-hidden">
      <div className={`relative min-w-[820px] ${rows} pl-8 pr-2 py-3`}>
        {/* frets */}
        <div className="absolute inset-y-3 left-8 right-2 flex pointer-events-none">
          {[...Array(FRET_COUNT + 1)].map((_, f) => (
            <div
              key={f}
              className={`flex-1 relative flex items-center justify-center ${
                f === 0 ? 'border-r-[3px] border-amber-100/70' : 'border-r border-stone-400/30'
              }`}
            >
              {SINGLE_DOTS.has(f) && <span className="w-2 h-2 rounded-full bg-stone-200/25" />}
              {f === 12 && (
                <span className="flex flex-col gap-3">
                  <span className="w-2 h-2 rounded-full bg-stone-200/25" />
                  <span className="w-2 h-2 rounded-full bg-stone-200/25" />
                </span>
              )}
              <span className="absolute -bottom-3 text-[9px] font-mono text-white/25">{f}</span>
            </div>
          ))}
        </div>
        {/* strings */}
        <div className="absolute inset-y-3 left-0 right-2 flex flex-col justify-between py-2">
          {strings.map((name, i) => (
            <div key={i} className="relative h-4 flex items-center">
              <span className="absolute left-1 w-6 text-right text-[10px] font-mono font-bold text-amber-200/60 pr-1">{name}</span>
              <div
                className="ml-8 flex-1 bg-gradient-to-r from-amber-100/30 via-amber-100/50 to-amber-100/30"
                style={{ height: `${(isBass ? 1.6 : 0.8) + (count - 1 - i) * (isBass ? 0.7 : 0.45)}px` }}
              />
            </div>
          ))}
        </div>
        {/* clickable cells */}
        <div className="absolute inset-y-3 left-8 right-2 flex">
          {[...Array(FRET_COUNT + 1)].map((_, f) => (
            <div key={f} className="flex-1 flex flex-col justify-between py-2">
              {strings.map((_, i) => {
                const pitch = (pitches[i] ?? 0) + f
                const isClicked = clicked?.string === i + 1 && clicked.fret === f
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => onPluck(i + 1, f, pitch)}
                    title={`${strings[i]} string · fret ${f} · ${midiToName(pitch)}`}
                    className={`h-4 w-full rounded transition-colors cursor-pointer ${
                      isClicked ? 'bg-amber-400/30' : 'hover:bg-amber-400/15 active:bg-amber-400/30'
                    }`}
                  >
                    {showNames && (
                      <span className="text-[8px] font-mono text-white/25 leading-none pointer-events-none">
                        {NOTE_NAMES[pitch % 12]}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        {/* active + clicked markers */}
        {[...activeNotes.map((n) => ({ string: n.string, fret: n.fret, live: true })), ...(clicked ? [{ ...clicked, live: false }] : [])].map(
          (m, idx) => {
            const stringIdx = m.string - 1
            if (stringIdx < 0 || stringIdx >= count) return null
            const left = (m.fret === 0 ? 0 : (m.fret - 0.5) * fretW)
            return (
              <div
                key={`${m.string}-${m.fret}-${idx}`}
                className="absolute z-10 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
                style={{
                  top: `calc(20px + ${stringIdx} * ((100% - 40px) / ${Math.max(1, count - 1)}))`,
                  left: `calc(32px + (100% - 40px) * ${left / 100})`
                }}
              >
                <div
                  className={`w-6 h-6 rounded-full text-black font-black text-[10px] flex items-center justify-center border-2 border-white shadow-lg ${
                    m.live ? 'bg-gradient-to-br from-amber-300 to-amber-500 shadow-amber-400/70' : 'bg-amber-300 animate-pulse'
                  }`}
                >
                  {m.fret}
                </div>
              </div>
            )
          }
        )}
      </div>
    </div>
  )
}

function Select({
  label,
  value,
  onChange,
  options,
  hint
}: {
  label: string
  value: string
  onChange: (v: string) => void
  options: { id: string; label: string }[]
  hint?: string
}): React.ReactElement {
  return (
    <div>
      <label className="block text-[11px] font-semibold text-white/60 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="no-drag w-full bg-black/50 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
      >
        {options.map((o) => (
          <option key={o.id} value={o.id} className="bg-[#12140e] text-white">
            {o.label}
          </option>
        ))}
      </select>
      {hint && <p className="text-[10px] text-white/35 mt-1 leading-relaxed">{hint}</p>}
    </div>
  )
}

export function TabStage({ song, instrument = 'guitar', onClose }: Props): React.ReactElement {
  const isBass = instrument === 'bass'
  const tuningOptions = isBass ? BASS_TUNINGS : GUITAR_TUNINGS
  const Icon = isBass ? BassIcon : GuitarIcon
  const instLabel = isBass ? 'Bass' : 'Guitar'
  const targetStem = instrument

  const {
    playing,
    duration: playerDuration,
    getPosition,
    togglePlay,
    seekTo,
    solos,
    mutes,
    vols,
    toggleStemSolo,
    toggleStemMute,
    setStemMute,
    setStemVolume,
    rate,
    setRate,
    loop,
    setLoop,
    addSynthLane,
    buffers
  } = usePlayer()

  const isMuted = mutes.has(targetStem)
  const isMutedRef = useRef(isMuted)
  isMutedRef.current = isMuted
  const targetStemRef = useRef(targetStem)
  targetStemRef.current = targetStem
  const setStemMuteRef = useRef(setStemMute)
  setStemMuteRef.current = setStemMute

  const handleClose = useCallback((): void => {
    if (isMutedRef.current) {
      setStemMuteRef.current(targetStemRef.current, false)
    }
    onClose()
  }, [onClose])

  const [tabs, setTabs] = useState<GuitarTabData | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<null | 'analyze' | 'import' | 'rebuild'>(null)
  const [progress, setProgress] = useState<TabProgress | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [view, setView] = useState<'tab' | 'fretboard' | 'text'>('tab')
  const [showSettings, setShowSettings] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const [mode, setMode] = useState<EngineMode>(isBass ? 'lead' : 'poly')
  const [modelEngine, setModelEngine] = useState<TabEngine>('basic_pitch')
  const [voicing, setVoicing] = useState<TabVoicing>('standard')
  const [tuning, setTuning] = useState('standard')
  const [position, setPosition] = useState('auto')
  const [sensitivity, setSensitivity] = useState('clean')
  const [beatsPerBar, setBeatsPerBar] = useState(4)

  const [importInfo, setImportInfo] = useState<MidiFileInfo | null>(null)
  const [importTrack, setImportTrack] = useState<number | 'all'>('all')
  const [importOffset, setImportOffset] = useState('0')
  const [importTranspose, setImportTranspose] = useState('0')

  const [synthOn, setSynthOn] = useState(false)
  const [synthVolume, setSynthVolume] = useState(0.85)
  const [synthInstrument, setSynthInstrument] = useState<SynthInstrument>(isBass ? 'bass_electric' : 'acoustic')
  const [renderingLane, setRenderingLane] = useState(false)

  const [autoScroll, setAutoScroll] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [showNames, setShowNames] = useState(false)
  const [clicked, setClicked] = useState<{ string: number; fret: number; pitch: number } | null>(null)

  const staffRef = useRef<HTMLDivElement>(null)
  const duration = playerDuration || tabs?.duration || 0
  const pxPerSec = 110 * zoom

  // ---------- synth wiring ----------
  useEffect(() => {
    if (tabs?.notes) tabSynth.setNotes(tabs.notes)
  }, [tabs?.notes])
  useEffect(() => {
    tabSynth.enabled = synthOn
  }, [synthOn])
  useEffect(() => {
    tabSynth.setVolume(synthVolume)
  }, [synthVolume])
  useEffect(() => {
    tabSynth.setInstrument(synthInstrument)
  }, [synthInstrument])
  useEffect(() => {
    if (!playing) tabSynth.stopAllVoices()
  }, [playing])
  useEffect(
    () => () => {
      tabSynth.stopAllVoices()
      tabSynth.reset(0)
      tabSynth.enabled = false
      if (isMutedRef.current) {
        setStemMuteRef.current(targetStemRef.current, false)
      }
    },
    []
  )

  // ---------- clock ----------
  const [, tick] = useState(0)
  useEffect(() => {
    if (!playing) return
    let raf = 0
    const loopFn = (): void => {
      tick((n) => (n + 1) % 100000)
      raf = requestAnimationFrame(loopFn)
    }
    raf = requestAnimationFrame(loopFn)
    return () => cancelAnimationFrame(raf)
  }, [playing])
  const pos = getPosition()

  useEffect(() => {
    if (tabs?.notes && playing) tabSynth.updatePlayback(pos, playing, rate)
  }, [pos, playing, tabs?.notes, rate])

  useEffect(() => {
    if (!playing || view !== 'tab' || !autoScroll) return
    const el = staffRef.current
    if (!el) return
    el.scrollLeft = Math.max(0, pos * pxPerSec - el.clientWidth * 0.35)
  }, [pos, playing, view, autoScroll, pxPerSec])

  // ---------- keyboard ----------
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'Escape') {
        e.preventDefault()
        if (importInfo) setImportInfo(null)
        else if (showSettings) setShowSettings(false)
        else handleClose()
      } else if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
        e.preventDefault()
        const delta = (e.shiftKey ? 15 : 5) * (e.code === 'ArrowLeft' ? -1 : 1)
        const next = Math.max(0, Math.min(duration, getPosition() + delta))
        seekTo(next)
        tabSynth.reset(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, handleClose, importInfo, showSettings, duration, getPosition, seekTo])

  // ---------- data ----------
  const applyTabsToSettings = useCallback(
    (data: GuitarTabData | null): void => {
      if (!data) return
      if (data.mode && data.mode !== 'note') setMode(data.mode)
      else if (data.mode === 'note') setMode('poly')
      if (data.voicingStyle === 'standard' || data.voicingStyle === 'barre' || data.voicingStyle === 'power') {
        setVoicing(data.voicingStyle)
      }
      if (data.tuningId) setTuning(data.tuningId)
      if (data.positionAnchor) setPosition(data.positionAnchor)
      if (data.sensitivity) setSensitivity(data.sensitivity)
      if (data.beatsPerBar) setBeatsPerBar(data.beatsPerBar)
      if (data.modelEngine === 'mt3' || data.modelEngine === 'basic_pitch') {
        setModelEngine(data.modelEngine)
      }
    },
    []
  )

  useEffect(() => {
    let unmounted = false
    setLoading(true)
    setErrorMsg(null)
    window.stemkit
      .getTabs(song.videoId, instrument)
      .then((data) => {
        if (unmounted) return
        setTabs(data)
        applyTabsToSettings(data)
        setLoading(false)
      })
      .catch((err) => {
        if (unmounted) return
        setErrorMsg(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    const off = window.stemkit.onTabProgress((ev) => {
      if (ev.videoId === song.videoId && (ev.instrument ?? 'guitar') === instrument) setProgress(ev)
    })
    return () => {
      unmounted = true
      off()
    }
  }, [song.videoId, instrument, applyTabsToSettings])

  const flash = (text: string): void => {
    setNotice(text)
    window.setTimeout(() => setNotice((cur) => (cur === text ? null : cur)), 2800)
  }

  const run = useCallback(
    async (kind: 'analyze' | 'import' | 'rebuild', task: () => Promise<GuitarTabData>): Promise<void> => {
      setBusy(kind)
      setErrorMsg(null)
      setShowSettings(false)
      setProgress({ videoId: song.videoId, instrument, pct: 0, message: 'Starting…' })
      try {
        const res = await task()
        setTabs(res)
        applyTabsToSettings(res)
        if (kind === 'import') setImportInfo(null)
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy(null)
        setProgress(null)
      }
    },
    [song.videoId, instrument, applyTabsToSettings]
  )

  const analyze = (): void => {
    void run('analyze', () =>
      window.stemkit.transcribeTabs(song.videoId, {
        instrument,
        engine: modelEngine,
        mode: isBass ? 'lead' : mode,
        voicing,
        tuning,
        position,
        sensitivity,
        beatsPerBar
      })
    )
  }

  const shiftDownbeat = (delta: number): void => {
    if (!tabs) return
    const bpb = tabs.beatsPerBar ?? beatsPerBar
    const next = (((tabs.downbeatPhase ?? 0) + delta) % bpb + bpb) % bpb
    void run('rebuild', () => window.stemkit.rebuildTabs(song.videoId, instrument, { downbeatPhase: next }))
  }

  const changeBeatsPerBar = (bpb: number): void => {
    setBeatsPerBar(bpb)
    if (tabs) void run('rebuild', () => window.stemkit.rebuildTabs(song.videoId, instrument, { beatsPerBar: bpb }))
  }

  const openImport = async (): Promise<void> => {
    try {
      const info = await window.stemkit.pickMidiFile()
      if (!info) return
      const melodic = info.tracks.filter((t) => !t.isDrum)
      setImportTrack(melodic.length === 1 ? melodic[0].index : 'all')
      setImportOffset('0')
      setImportTranspose('0')
      setImportInfo(info)
      setShowSettings(false)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const runImport = (): void => {
    if (!importInfo) return
    const midiPath = importInfo.path
    const track = importTrack
    const offset = parseFloat(importOffset) || 0
    const transpose = parseInt(importTranspose, 10) || 0
    void run('import', () =>
      window.stemkit.importTabMidi(song.videoId, { instrument, midiPath, track, offset, transpose, tuning, position })
    )
  }

  const exportMidi = async (): Promise<void> => {
    try {
      const res = await window.stemkit.exportTabMidi(song.videoId, instrument)
      if (res.saved) flash('MIDI file saved')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const exportText = async (): Promise<void> => {
    try {
      const res = await window.stemkit.exportTabAscii(song.videoId, instrument)
      if (res.saved) flash('Text tab saved')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    }
  }

  const copyText = (): void => {
    if (!tabs?.asciiTab) return
    void navigator.clipboard.writeText(tabs.asciiTab).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  const laneId = SYNTH_LANE_FOR[instrument]
  const laneInMixer = !!buffers[laneId]

  const addToMixer = async (): Promise<void> => {
    if (!tabs?.notes.length || renderingLane) return
    setRenderingLane(true)
    try {
      const buf = await renderNotesToBuffer(tabs.notes, synthInstrument, duration || tabs.duration)
      addSynthLane(laneId, buf)
      flash(`${instLabel} synth lane added to the mixer`)
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setRenderingLane(false)
    }
  }

  const pluck = (stringNum: number, fret: number, pitch: number, dur = 0.75, vel = 0.9): void => {
    tabSynth.auditionNote(pitch, dur, vel)
    setClicked({ string: stringNum, fret, pitch })
    window.setTimeout(() => setClicked((c) => (c && c.string === stringNum && c.fret === fret ? null : c)), 600)
  }

  const seek = (t: number): void => {
    const next = Math.max(0, Math.min(duration, t))
    seekTo(next)
    tabSynth.reset(next)
  }

  // ---------- derived ----------
  const isSolo = solos.has(targetStem)
  const stemVolume = vols[targetStem] ?? 1

  const strings = useMemo(() => {
    if (tabs?.tuning?.length) return tabs.tuning
    return tuningOptions.find((t) => t.id === tuning)?.strings ?? tuningOptions[0].strings
  }, [tabs?.tuning, tuning, tuningOptions])
  const pitches = useMemo(() => {
    if (tabs?.tuningPitches?.length) return tabs.tuningPitches
    return tuningOptions.find((t) => t.id === tuning)?.pitches ?? tuningOptions[0].pitches
  }, [tabs?.tuningPitches, tuning, tuningOptions])

  const activeNotes = useMemo(() => {
    if (!tabs?.notes) return []
    return tabs.notes.filter((n) => n.start <= pos && pos <= Math.max(n.start + 0.1, n.end))
  }, [tabs?.notes, pos])

  const currentChord = useMemo(() => {
    if (!tabs?.chords?.length) return activeNotes[0]?.chord ?? null
    return tabs.chords.find((c) => c.start <= pos && pos < c.end)?.name ?? null
  }, [tabs?.chords, pos, activeNotes])

  const currentBar = useMemo(() => tabs?.measures.find((m) => m.start <= pos && pos < m.end) ?? null, [tabs?.measures, pos])

  const staffWidth = Math.max(900, duration * pxPerSec + 80)
  const staffHeight = STAFF_TOP + strings.length * STRING_GAP + 26

  // static layers are memoised so the per-frame re-render only touches the playhead and overlays
  const gridLayer = useMemo(() => {
    if (!tabs) return null
    const beats = tabs.beats ?? []
    const chords = tabs.chords ?? []
    return (
      <>
        {beats.map((b, i) => (
          <div key={`b${i}`} className="absolute top-8 bottom-4 border-l border-white/[0.06] pointer-events-none" style={{ left: b * pxPerSec }} />
        ))}
        {tabs.measures.map((m) => (
          <div key={`m${m.number}`} className="absolute top-0 bottom-0 pointer-events-none" style={{ left: m.start * pxPerSec }}>
            <div className="absolute top-7 bottom-3 border-l border-white/25" />
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                setLoop({ start: m.start, end: m.end })
              }}
              title="Loop this bar"
              className="pointer-events-auto absolute top-1 left-1 px-1.5 h-5 rounded text-[10px] font-mono font-semibold text-white/40 hover:text-amber-200 hover:bg-amber-400/15 cursor-pointer"
            >
              {m.number}
            </button>
          </div>
        ))}
        {chords.map((c, i) => (
          <span
            key={`c${i}`}
            className="absolute top-1 px-1.5 h-5 rounded bg-amber-400/15 text-amber-200 font-bold text-[11px] font-mono border border-amber-400/25 flex items-center pointer-events-none"
            style={{ left: c.start * pxPerSec + 26 }}
          >
            {c.name}
          </span>
        ))}
        {strings.map((name, i) => (
          <div key={`s${i}`} className="absolute left-0 right-0 border-b border-white/15 pointer-events-none" style={{ top: STAFF_TOP + i * STRING_GAP }}>
            <span className="sticky left-0 z-20 -translate-y-1/2 w-7 h-5 bg-[#0c0e09] border-r border-white/15 text-[11px] font-mono font-bold text-amber-300 flex items-center justify-center">
              {name}
            </span>
          </div>
        ))}
      </>
    )
  }, [tabs, pxPerSec, strings, setLoop])

  const notesLayer = useMemo(() => {
    if (!tabs) return null
    return tabs.notes.map((n, idx) => {
      const top = STAFF_TOP + (n.string - 1) * STRING_GAP
      const left = n.start * pxPerSec
      const width = Math.max(0, (n.end - n.start) * pxPerSec - 12)
      const glyph = n.articulation ? ARTICULATION_GLYPH[n.articulation] : ''
      return (
        <div key={idx} className="absolute z-10 -translate-y-1/2" style={{ top, left }}>
          {width > 14 && <div className="absolute left-3 h-[3px] rounded-r bg-amber-300/25 top-1/2 -translate-y-1/2" style={{ width }} />}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              pluck(n.string, n.fret, n.pitch, Math.max(0.4, n.end - n.start), n.amplitude || 0.85)
            }}
            title={`${midiToName(n.pitch)} · string ${n.string} fret ${n.fret} · ${fmtTime(n.start)}${n.chord ? ` · ${n.chord}` : ''}`}
            className="relative -translate-x-1/2 min-w-[22px] h-[22px] px-1 rounded-md bg-zinc-800 text-amber-200 border border-amber-400/30 font-mono text-[12px] font-bold flex items-center justify-center hover:scale-125 hover:bg-amber-500/30 transition-transform cursor-pointer"
          >
            {glyph && <span className="text-[9px] text-amber-400/80 mr-0.5">{glyph}</span>}
            {n.fret}
          </button>
        </div>
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, pxPerSec])

  const barPhaseLabel = tabs ? `beat ${(tabs.downbeatPhase ?? 0) + 1} of ${tabs.beatsPerBar ?? 4}` : ''

  // ---------- render ----------
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#0b0d09] text-white select-none overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-amber-500/[0.06] via-transparent to-black pointer-events-none" />

      {/* window drag strip */}
      <div className="drag-region h-9 w-full shrink-0 flex items-center justify-between px-4 border-b border-white/[0.06] bg-black/40 relative z-30">
        <div className="w-24 shrink-0" />
        <div className="flex items-center gap-2 text-[11px] font-mono font-medium text-white/40 uppercase tracking-wider">
          <Icon className="w-3.5 h-3.5 text-amber-400/80" />
          <span>{instLabel} tab stage</span>
        </div>
        <button
          onClick={handleClose}
          className="no-drag flex items-center gap-1.5 px-3 py-1 rounded-lg glass hover:bg-white/10 text-white/70 hover:text-white text-xs transition-colors cursor-pointer"
          title="Back to the mixer (Esc)"
        >
          <XIcon className="w-3.5 h-3.5" />
          <span>Close</span>
        </button>
      </div>

      {/* header */}
      <header className="relative z-20 flex items-center justify-between gap-4 px-6 py-3 border-b border-white/10 bg-[#0e110b]/90 backdrop-blur-md">
        <div className="flex items-center gap-4 min-w-0">
          <Thumb videoId={song.videoId} className="w-12 h-12 rounded-xl object-cover ring-1 ring-white/10 shadow-md shrink-0" />
          <div className="min-w-0">
            <h1 className="text-base font-bold text-white truncate max-w-xl leading-tight">{song.title}</h1>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-400/20 text-amber-300 border border-amber-400/30">
                <Icon className="w-3 h-3" />
                {instLabel} tab
              </span>
              {tabs && (
                <>
                  <span
                    className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-white/5 text-white/70 border border-white/10"
                    title={tabs.engine ?? tabs.model ?? ''}
                  >
                    {modeLabel(tabs.mode, tabs.source)}
                  </span>
                  <span className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-white/5 text-white/70 border border-white/10">
                    {Math.round(tabs.bpm)} BPM · {tabs.beatsPerBar ?? 4}/4
                  </span>
                  <span className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-white/5 text-white/70 border border-white/10">
                    {tabs.notesCount.toLocaleString()} notes · {tabs.measures.length} bars
                  </span>
                  {tabs.chords && tabs.chords.length > 0 && (
                    <span className="px-2 py-0.5 rounded-md text-[11px] font-mono bg-white/5 text-white/70 border border-white/10">
                      {new Set(tabs.chords.map((c) => c.name)).size} chords
                    </span>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {tabs && (
            <div className="flex items-center rounded-xl p-1 bg-white/5 border border-white/10 text-xs">
              {(
                [
                  ['tab', 'Tab'],
                  ['fretboard', 'Fretboard'],
                  ['text', 'Text']
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setView(id)}
                  className={`no-drag px-3 py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                    view === id ? 'bg-amber-400 text-black font-semibold shadow-sm' : 'text-white/60 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => void openImport()}
            disabled={!!busy}
            className="no-drag glass hover:bg-white/10 px-3 py-2 rounded-xl text-xs font-medium text-white/80 hover:text-white border border-white/15 flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-40"
            title="Build the tab from a MIDI file (Guitar Pro / DAW export, or a MIDI you downloaded)"
          >
            <ImportIcon className="w-3.5 h-3.5" />
            <span>Import MIDI</span>
          </button>
          {tabs && (
            <>
              <button
                onClick={() => void exportMidi()}
                className="no-drag glass hover:bg-white/10 px-3 py-2 rounded-xl text-xs font-medium text-white/80 hover:text-white border border-white/15 flex items-center gap-1.5 transition-all cursor-pointer"
                title="Export a multi-track MIDI file (one track per string)"
              >
                <DownloadIcon className="w-3.5 h-3.5" />
                <span>.mid</span>
              </button>
              <button
                onClick={() => void exportText()}
                className="no-drag glass hover:bg-white/10 px-3 py-2 rounded-xl text-xs font-medium text-white/80 hover:text-white border border-white/15 flex items-center gap-1.5 transition-all cursor-pointer"
                title="Export the text tablature"
              >
                <DownloadIcon className="w-3.5 h-3.5" />
                <span>.txt</span>
              </button>
              <button
                onClick={() => setShowSettings((v) => !v)}
                className={`no-drag glass hover:bg-white/10 p-2 rounded-xl border border-white/15 transition-all cursor-pointer ${
                  showSettings ? 'bg-amber-400/20 text-amber-300 border-amber-400/30' : 'text-white/70 hover:text-white'
                }`}
                title="Engine, tuning and position settings"
              >
                <GearIcon className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      </header>

      {notice && (
        <div className="absolute top-24 right-6 z-40 px-4 py-2 rounded-xl bg-emerald-500/90 text-black font-semibold text-xs shadow-lg">
          {notice}
        </div>
      )}

      {/* settings drawer */}
      {showSettings && tabs && (
        <div className="absolute top-[100px] right-6 z-40 w-[380px] glass rounded-2xl border border-white/20 p-5 shadow-2xl space-y-3.5 bg-[#0f120c]/95">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-2">
              <GearIcon className="w-3.5 h-3.5 text-amber-400" />
              Analysis settings
            </h3>
            <button onClick={() => setShowSettings(false)} className="text-white/50 hover:text-white cursor-pointer">
              <XIcon className="w-4 h-4" />
            </button>
          </div>
          {!isBass && (
            <Select
              label="Transcription mode"
              value={mode}
              onChange={(v) => setMode(v as EngineMode)}
              options={GUITAR_MODES}
              hint={GUITAR_MODES.find((m) => m.id === mode)?.desc}
            />
          )}
          {!isBass && mode === 'poly' && (
            <Select
              label="Neural model"
              value={modelEngine}
              onChange={(v) => setModelEngine(v as TabEngine)}
              options={[
                { id: 'basic_pitch', label: 'Basic Pitch (Fast, ONNX)' },
                { id: 'mt3', label: 'MR-MT3 Transformer (Accurate)' }
              ]}
              hint={
                modelEngine === 'mt3'
                  ? 'Multi-instrument autoregressive transformer that suppresses harmonic overtones.'
                  : 'Lightweight Spotify model running locally on ONNX.'
              }
            />
          )}
          {!isBass && mode === 'chord' && (
            <Select label="Voicings" value={voicing} onChange={(v) => setVoicing(v as TabVoicing)} options={VOICING_OPTIONS} />
          )}
          <Select label={`${instLabel} tuning`} value={tuning} onChange={setTuning} options={tuningOptions} />
          {mode !== 'chord' && <Select label="Hand position" value={position} onChange={setPosition} options={POSITION_OPTIONS} />}
          {mode !== 'chord' && (
            <Select
              label="Detection"
              value={sensitivity}
              onChange={setSensitivity}
              options={SENSITIVITY_OPTIONS}
              hint={SENSITIVITY_OPTIONS.find((s) => s.id === sensitivity)?.desc}
            />
          )}
          <div>
            <label className="block text-[11px] font-semibold text-white/60 mb-1">Beats per bar</label>
            <div className="flex rounded-lg bg-black/50 border border-white/15 p-0.5 w-fit">
              {[4, 3].map((b) => (
                <button
                  key={b}
                  onClick={() => setBeatsPerBar(b)}
                  className={`px-3 h-6 rounded-md text-xs font-semibold cursor-pointer ${
                    beatsPerBar === b ? 'bg-amber-400 text-black' : 'text-white/60 hover:text-white'
                  }`}
                >
                  {b}/4
                </button>
              ))}
            </div>
          </div>
          <button
            onClick={analyze}
            disabled={!!busy}
            className="w-full py-2.5 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 text-black font-semibold text-xs hover:from-amber-300 hover:to-amber-400 transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer disabled:opacity-40"
          >
            <RefreshIcon className="w-3.5 h-3.5" />
            Re-analyze the {instrument} stem
          </button>
          <p className="text-[10px] text-white/35 leading-relaxed">
            Bars are tracked on the full mix. If bar 1 starts on the wrong beat, use the bar-start arrows in the footer instead of re-analyzing.
          </p>
        </div>
      )}

      {/* MIDI import modal */}
      {importInfo && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-6" onClick={() => setImportInfo(null)}>
          <div className="w-full max-w-lg glass rounded-2xl border border-white/15 p-6 shadow-2xl space-y-4 bg-[#0f120c]/95" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <ImportIcon className="w-4 h-4 text-amber-400" />
                  Import MIDI as {instrument} tab
                </h2>
                <p className="text-[11px] text-white/45 mt-0.5 truncate" title={importInfo.path}>
                  {importInfo.path.split(/[\\/]/).pop()} · {fmtTime(importInfo.duration)} · ~{Math.round(importInfo.bpm)} BPM
                </p>
              </div>
              <button onClick={() => setImportInfo(null)} className="text-white/40 hover:text-white p-1 rounded-lg hover:bg-white/10 cursor-pointer">
                <XIcon className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block text-[11px] font-semibold text-white/60 mb-1.5">Track</label>
              <div className="max-h-56 overflow-y-auto space-y-1 pr-1">
                <label className="flex items-center gap-2.5 rounded-lg px-3 py-2 bg-white/[0.04] hover:bg-white/[0.07] cursor-pointer border border-white/5">
                  <input type="radio" name="miditrack" checked={importTrack === 'all'} onChange={() => setImportTrack('all')} className="accent-amber-400" />
                  <span className="text-xs text-white/85">All melodic tracks merged</span>
                </label>
                {importInfo.tracks.map((t) => (
                  <label
                    key={t.index}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 border border-white/5 ${
                      t.isDrum ? 'opacity-40 cursor-not-allowed' : 'bg-white/[0.04] hover:bg-white/[0.07] cursor-pointer'
                    }`}
                  >
                    <input
                      type="radio"
                      name="miditrack"
                      disabled={t.isDrum}
                      checked={importTrack === t.index}
                      onChange={() => setImportTrack(t.index)}
                      className="accent-amber-400"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs text-white/85 truncate">
                        {t.name}
                        <span className="text-white/35"> · {t.programName}</span>
                      </span>
                      <span className="block text-[10px] font-mono text-white/40">
                        {t.noteCount} notes · {t.pitchLow}–{t.pitchHigh} · {fmtTime(t.start)}–{fmtTime(t.end)}
                        {t.isDrum ? ' · drums' : ''}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-white/60 mb-1">Offset (s)</label>
                <input
                  type="number"
                  step="0.05"
                  value={importOffset}
                  onChange={(e) => setImportOffset(e.target.value)}
                  className="no-drag w-full bg-black/50 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
                  title="Shift the MIDI in time so it lines up with the song (positive = later)"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-white/60 mb-1">Transpose</label>
                <input
                  type="number"
                  step="1"
                  value={importTranspose}
                  onChange={(e) => setImportTranspose(e.target.value)}
                  className="no-drag w-full bg-black/50 border border-white/15 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-amber-400"
                  title="Semitones. Octaves are corrected automatically to fit the instrument."
                />
              </div>
              <Select label="Tuning" value={tuning} onChange={setTuning} options={tuningOptions} />
            </div>
            <p className="text-[10px] text-white/35 leading-relaxed">
              Notes outside the {instrument}'s range are shifted by octaves to fit; the fingering solver then picks positions. Bars come from the MIDI file's own tempo map.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setImportInfo(null)} className="px-4 py-2 rounded-xl text-xs font-medium text-white/60 hover:text-white hover:bg-white/5 cursor-pointer">
                Cancel
              </button>
              <button
                onClick={runImport}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-amber-400 to-amber-500 text-black hover:from-amber-300 hover:to-amber-400 shadow-md flex items-center gap-1.5 cursor-pointer"
              >
                <ImportIcon className="w-3.5 h-3.5" />
                Import
              </button>
            </div>
          </div>
        </div>
      )}

      {/* body */}
      <div className="relative z-10 flex-1 flex flex-col min-h-0 overflow-hidden">
        {loading ? (
          <div className="h-full flex flex-col items-center justify-center gap-4 text-center">
            <Icon className="w-12 h-12 text-amber-400 animate-pulse" />
            <p className="text-sm text-white/60">Looking for saved {instrument} tablature…</p>
          </div>
        ) : busy ? (
          <div className="h-full flex flex-col items-center justify-center max-w-md mx-auto text-center px-4">
            <div className="w-16 h-16 rounded-2xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center mb-6 shadow-xl">
              <Icon className="w-8 h-8 text-amber-400 animate-bounce" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">
              {busy === 'import' ? 'Importing MIDI' : busy === 'rebuild' ? 'Rebuilding bars' : `Transcribing ${instrument}`}
            </h2>
            <p className="text-xs text-white/50 mb-6 leading-relaxed">
              {busy === 'analyze'
                ? isBass
                  ? 'Tracking the bass pitch contour, finding onsets, checking octaves against the spectrum and solving fingerings.'
                  : mode === 'chord'
                    ? 'Decoding the chord progression on the beat grid and placing voicings at the strums in the audio.'
                    : 'Running the transcription model, anchoring octaves to the pitch contour and solving fingerings.'
                : 'This only takes a moment.'}
            </p>
            <div className="w-full bg-white/10 rounded-full h-2.5 overflow-hidden p-0.5 border border-white/10 mb-3">
              <div
                className="bg-gradient-to-r from-amber-400 to-amber-500 h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.max(4, progress?.pct ?? 0)}%` }}
              />
            </div>
            <p className="text-xs font-mono text-amber-300/80">
              {progress?.message ?? 'Working…'} ({progress?.pct ?? 0}%)
            </p>
          </div>
        ) : !tabs ? (
          <div className="h-full flex flex-col items-center justify-center max-w-lg mx-auto text-center px-6 overflow-y-auto">
            <div className="w-20 h-20 rounded-3xl bg-amber-400/10 border border-amber-400/20 flex items-center justify-center mb-5 shadow-2xl shrink-0">
              <Icon className="w-10 h-10 text-amber-400" />
            </div>
            <h2 className="text-2xl font-bold text-white mb-2">{instLabel} tablature</h2>
            <p className="text-sm text-white/60 mb-5 leading-relaxed">
              {isBass
                ? 'Transcribes the isolated bass stem with a pitch tracker built for the low register, then solves a comfortable fingering on the beat grid of the song.'
                : 'Transcribes the isolated guitar stem into a playable tab synced to the song. Pick the engine that matches the part: riffs, single-note leads or strummed chords.'}
            </p>
            {errorMsg && (
              <div className="w-full mb-4 p-3 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs text-left">{errorMsg}</div>
            )}
            <div className="w-full glass p-5 rounded-2xl border border-white/10 mb-4 text-left space-y-3">
              {!isBass && (
                <Select
                  label="Engine"
                  value={mode}
                  onChange={(v) => setMode(v as EngineMode)}
                  options={GUITAR_MODES}
                  hint={GUITAR_MODES.find((m) => m.id === mode)?.desc}
                />
              )}
              {!isBass && mode === 'chord' && (
                <Select label="Voicings" value={voicing} onChange={(v) => setVoicing(v as TabVoicing)} options={VOICING_OPTIONS} />
              )}
              <div className="grid grid-cols-2 gap-3">
                <Select label={`${instLabel} tuning`} value={tuning} onChange={setTuning} options={tuningOptions} />
                {mode !== 'chord' ? (
                  <Select label="Hand position" value={position} onChange={setPosition} options={POSITION_OPTIONS} />
                ) : (
                  <div />
                )}
              </div>
            </div>
            <button
              onClick={analyze}
              className="w-full px-6 py-3.5 rounded-xl bg-gradient-to-r from-amber-400 to-amber-500 text-black font-semibold text-sm hover:from-amber-300 hover:to-amber-400 transition-all shadow-lg hover:shadow-amber-500/25 cursor-pointer flex items-center justify-center gap-2"
            >
              <Icon className="w-4 h-4 text-black" />
              Transcribe {instrument} stem
            </button>
            <button
              onClick={() => void openImport()}
              className="mt-3 text-xs text-white/50 hover:text-amber-300 flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <ImportIcon className="w-3.5 h-3.5" />
              …or import a MIDI file instead
            </button>
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
            {errorMsg && (
              <div className="mx-6 mt-3 p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/30 text-rose-300 text-xs flex items-center justify-between gap-3">
                <span>{errorMsg}</span>
                <button onClick={() => setErrorMsg(null)} className="text-rose-200/70 hover:text-white cursor-pointer">
                  <XIcon className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {(view === 'tab' || view === 'fretboard') && (
              <div className={`px-6 pt-3 pb-3 shrink-0 ${view === 'fretboard' ? 'flex-1 flex flex-col justify-center' : ''}`}>
                <div className="max-w-6xl mx-auto w-full">
                  <div className="flex items-center justify-between h-7 mb-1.5 gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[11px] font-semibold text-white/50 uppercase tracking-wider shrink-0">Fretboard</span>
                      {currentBar && (
                        <span className="text-[11px] font-mono text-white/35 shrink-0">bar {currentBar.number}</span>
                      )}
                      {currentChord && (
                        <span className="h-6 px-2.5 rounded-md text-xs font-mono font-bold bg-amber-300 text-black flex items-center shrink-0">{currentChord}</span>
                      )}
                      <div className="flex items-center gap-1 overflow-hidden">
                        {activeNotes.slice(0, 8).map((n, i) => (
                          <span key={`${n.string}-${n.fret}-${i}`} className="h-6 px-2 rounded-md text-[11px] font-mono font-bold bg-amber-400/90 text-black flex items-center shrink-0">
                            {strings[n.string - 1]}·{n.fret}
                          </span>
                        ))}
                        {clicked && activeNotes.length === 0 && (
                          <span className="h-6 px-2 rounded-md text-[11px] font-mono font-bold bg-amber-400 text-black flex items-center shrink-0">
                            {midiToName(clicked.pitch)}
                          </span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => setShowNames((v) => !v)}
                      className={`no-drag px-2 h-6 rounded-md text-[11px] font-medium border cursor-pointer ${
                        showNames ? 'bg-amber-400/20 text-amber-200 border-amber-400/30' : 'text-white/40 border-white/10 hover:text-white'
                      }`}
                    >
                      Note names
                    </button>
                  </div>
                  <Fretboard
                    strings={strings}
                    pitches={pitches}
                    isBass={isBass}
                    activeNotes={activeNotes}
                    clicked={clicked}
                    showNames={showNames}
                    tall={view === 'fretboard'}
                    onPluck={(s, f, p) => pluck(s, f, p)}
                  />
                </div>
              </div>
            )}

            {view === 'tab' && (
              <div
                ref={staffRef}
                className="flex-1 overflow-x-auto overflow-y-auto bg-[#0c0e09] relative cursor-crosshair px-0 py-2 select-none border-t border-white/[0.06]"
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect()
                  const x = e.clientX - rect.left + e.currentTarget.scrollLeft
                  seek(x / pxPerSec)
                }}
              >
                <div className="relative" style={{ width: staffWidth, height: staffHeight }}>
                  {loop && (
                    <div
                      className="absolute top-0 bottom-0 bg-amber-300/[0.07] border-x border-amber-300/40 pointer-events-none"
                      style={{ left: loop.start * pxPerSec, width: Math.max(2, (loop.end - loop.start) * pxPerSec) }}
                    />
                  )}
                  {gridLayer}
                  {notesLayer}
                  {/* active overlay */}
                  {activeNotes.map((n, i) => (
                    <div
                      key={`a${n.string}-${n.start}-${i}`}
                      className="absolute z-20 -translate-y-1/2 -translate-x-1/2 min-w-[24px] h-6 px-1 rounded-md bg-amber-400 text-black border border-white font-mono text-[12px] font-bold flex items-center justify-center shadow-md shadow-amber-400/50 pointer-events-none"
                      style={{ top: STAFF_TOP + (n.string - 1) * STRING_GAP, left: n.start * pxPerSec }}
                    >
                      {n.fret}
                    </div>
                  ))}
                  <div
                    className="absolute top-6 bottom-2 w-0.5 bg-amber-400 z-30 pointer-events-none shadow-[0_0_8px_rgba(251,191,36,0.8)]"
                    style={{ left: pos * pxPerSec }}
                  >
                    <div className="w-3 h-3 -ml-[5px] -top-1.5 absolute bg-amber-400 rounded-full border-2 border-white shadow-md" />
                  </div>
                </div>
              </div>
            )}

            {view === 'text' && (
              <div className="flex-1 overflow-auto bg-[#080906] p-6 font-mono text-xs text-amber-200/90 leading-relaxed select-text">
                <div className="max-w-5xl mx-auto space-y-3">
                  <div className="flex items-center justify-between border-b border-white/10 pb-3">
                    <span className="text-white/60">
                      Text tablature · 16th-note grid on tracked beats · h = hammer-on, p = pull-off, / = slide
                    </span>
                    <button
                      onClick={copyText}
                      className="px-3 py-1.5 rounded-lg bg-amber-400/20 text-amber-300 hover:bg-amber-400/30 font-medium transition-all flex items-center gap-1.5 cursor-pointer"
                    >
                      {copied ? <CheckIcon className="w-3.5 h-3.5 text-emerald-400" /> : <CopyIcon className="w-3.5 h-3.5" />}
                      <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                  <pre className="p-4 rounded-xl bg-black/40 border border-white/10 overflow-x-auto whitespace-pre font-mono">{tabs.asciiTab}</pre>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* footer transport */}
      <footer className="relative z-20 px-6 py-3 bg-[#0e110b] border-t border-white/10 flex flex-col gap-2.5">
        <div className="flex items-center gap-3 w-full">
          <button
            onClick={togglePlay}
            disabled={duration <= 0}
            className="no-drag w-10 h-10 rounded-full bg-amber-400 text-black hover:bg-amber-300 flex items-center justify-center shadow-lg shadow-amber-400/20 transition-all cursor-pointer disabled:opacity-40 shrink-0"
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
          >
            {playing ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5 ml-0.5" />}
          </button>
          <span className="text-xs font-mono text-white/50 w-12 text-right tabular-nums">{fmtTime(pos)}</span>
          <div
            className="no-drag flex-1 h-4 flex items-center cursor-pointer group"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              const rect = e.currentTarget.getBoundingClientRect()
              seek(((e.clientX - rect.left) / rect.width) * duration)
            }}
            onPointerMove={(e) => {
              if (e.buttons !== 1) return
              const rect = e.currentTarget.getBoundingClientRect()
              seek(((e.clientX - rect.left) / rect.width) * duration)
            }}
          >
            <div className="w-full h-1.5 rounded-full bg-white/10 relative overflow-hidden">
              {loop && duration > 0 && (
                <div
                  className="absolute inset-y-0 bg-amber-300/40"
                  style={{ left: `${(loop.start / duration) * 100}%`, width: `${((loop.end - loop.start) / duration) * 100}%` }}
                />
              )}
              <div className="h-full bg-gradient-to-r from-amber-400 to-amber-500 rounded-full" style={{ width: `${duration > 0 ? (pos / duration) * 100 : 0}%` }} />
            </div>
          </div>
          <span className="text-xs font-mono text-white/50 w-12 tabular-nums">{fmtTime(duration)}</span>
        </div>

        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-wrap">
            <PracticeControls rate={rate} onRate={setRate} loop={loop} onLoop={setLoop} getPosition={getPosition} duration={duration} accent="amber" />

            <button
              onClick={() => setAutoScroll((v) => !v)}
              className={`no-drag px-2.5 h-7 rounded-xl text-[11px] font-medium border transition-all cursor-pointer flex items-center gap-1.5 ${
                autoScroll ? 'bg-amber-400/20 text-amber-300 border-amber-400/40' : 'glass text-white/40 hover:text-white border-white/10'
              }`}
              title="Follow the playhead"
            >
              <span className={`w-1.5 h-1.5 rounded-full ${autoScroll ? 'bg-amber-400' : 'bg-white/30'}`} />
              Follow
            </button>

            <div className="no-drag flex items-center rounded-xl bg-white/[0.05] border border-white/10 p-0.5" title="Zoom">
              <button onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} className="w-6 h-6 rounded-lg text-white/60 hover:text-white cursor-pointer text-sm">
                −
              </button>
              <span className="text-[10px] font-mono text-white/50 w-9 text-center">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.25).toFixed(2)))} className="w-6 h-6 rounded-lg text-white/60 hover:text-white cursor-pointer text-sm">
                +
              </button>
            </div>

            {tabs && (
              <div className="no-drag flex items-center rounded-xl bg-white/[0.05] border border-white/10 p-0.5" title="Which tracked beat starts bar 1. Nudge if the bar lines are off by a beat.">
                <button onClick={() => shiftDownbeat(-1)} disabled={!!busy} className="w-6 h-6 rounded-lg text-white/60 hover:text-white cursor-pointer flex items-center justify-center disabled:opacity-40">
                  <ChevronLeftIcon className="w-3.5 h-3.5" />
                </button>
                <span className="text-[10px] font-mono text-white/50 px-1 whitespace-nowrap">bar start · {barPhaseLabel}</span>
                <button onClick={() => shiftDownbeat(1)} disabled={!!busy} className="w-6 h-6 rounded-lg text-white/60 hover:text-white cursor-pointer flex items-center justify-center disabled:opacity-40">
                  <ChevronRightIcon className="w-3.5 h-3.5" />
                </button>
                <span className="w-px h-4 bg-white/10 mx-0.5" />
                {[4, 3].map((b) => (
                  <button
                    key={b}
                    onClick={() => changeBeatsPerBar(b)}
                    disabled={!!busy}
                    className={`px-1.5 h-6 rounded-lg text-[10px] font-mono cursor-pointer disabled:opacity-40 ${
                      (tabs.beatsPerBar ?? 4) === b ? 'bg-amber-400 text-black font-bold' : 'text-white/50 hover:text-white'
                    }`}
                  >
                    {b}/4
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 bg-[#12160d] border border-white/15 rounded-xl px-2 py-1">
              <button
                onClick={() => setSynthOn((v) => !v)}
                className={`no-drag px-2.5 h-6 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer flex items-center gap-1.5 ${
                  synthOn ? 'bg-amber-400 text-black border-amber-300' : 'glass text-white/60 hover:text-white border-white/15'
                }`}
                title="Play the transcribed notes with a synth in sync with the song"
              >
                <MusicNoteIcon className="w-3.5 h-3.5" />
                Synth {synthOn ? 'on' : 'off'}
              </button>
              <select
                value={synthInstrument}
                onChange={(e) => setSynthInstrument(e.target.value as SynthInstrument)}
                className="no-drag bg-black/60 border border-white/15 rounded-lg px-2 h-6 text-[11px] text-amber-200 focus:outline-none cursor-pointer"
                title="Synth tone"
              >
                {SYNTH_INSTRUMENTS.map((inst) => (
                  <option key={inst.id} value={inst.id} className="bg-[#12140e] text-white">
                    {inst.name}
                  </option>
                ))}
              </select>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={synthVolume}
                onChange={(e) => setSynthVolume(parseFloat(e.target.value))}
                className="no-drag w-14 accent-amber-400 h-1.5 cursor-pointer"
                title={`Synth volume ${Math.round(synthVolume * 100)}%`}
              />
              <button
                onClick={() => void addToMixer()}
                disabled={renderingLane || !tabs}
                className={`no-drag px-2.5 h-6 rounded-lg text-[11px] font-semibold border transition-all cursor-pointer flex items-center gap-1.5 disabled:opacity-40 ${
                  laneInMixer ? 'bg-emerald-500/20 text-emerald-200 border-emerald-500/30' : 'glass text-white/70 hover:text-white border-white/15'
                }`}
                title="Render the tab with this synth tone into a lane in the mixer (mute the original and play along, or export it as WAV)"
              >
                <MixerIcon className="w-3.5 h-3.5" />
                {renderingLane ? 'Rendering…' : laneInMixer ? 'Update mixer lane' : 'Add to mixer'}
              </button>
            </div>

            <button
              onClick={() => {
                if (!isSolo && solos.size > 0) solos.forEach((s) => s !== targetStem && toggleStemSolo(s))
                toggleStemSolo(targetStem)
              }}
              className={`no-drag px-2.5 h-7 rounded-xl text-[11px] font-medium border transition-all cursor-pointer flex items-center gap-1.5 ${
                isSolo ? 'bg-amber-400/20 text-amber-300 border-amber-400/40' : 'glass text-white/70 hover:text-white border-white/10'
              }`}
              title={`Solo the ${instrument} stem`}
            >
              <Icon className="w-3.5 h-3.5" />
              Solo
            </button>
            <button
              onClick={() => toggleStemMute(targetStem)}
              className={`no-drag px-2.5 h-7 rounded-xl text-[11px] font-medium border transition-all cursor-pointer flex items-center gap-1.5 ${
                isMuted ? 'bg-rose-500/20 text-rose-300 border-rose-500/40' : 'glass text-white/70 hover:text-white border-white/10'
              }`}
              title={`Mute the original ${instrument} to play along`}
            >
              {isMuted ? <VolumeMuteIcon className="w-3.5 h-3.5" /> : <VolumeIcon className="w-3.5 h-3.5" />}
              {isMuted ? 'Muted' : 'Mute'}
            </button>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={stemVolume}
              onChange={(e) => setStemVolume(targetStem, parseFloat(e.target.value))}
              className="no-drag w-20 accent-amber-400 h-1.5 cursor-pointer"
              title={`Original ${instrument} volume ${Math.round(stemVolume * 100)}%`}
            />
          </div>
        </div>
      </footer>
    </div>
  )
}
