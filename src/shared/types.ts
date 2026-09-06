export type StemId = 'vocals' | 'drums' | 'bass' | 'other' | 'piano' | 'guitar' | SynthLaneId

// virtual lanes rendered in the renderer from a tab's MIDI notes; they sit in
// the mixer next to the real stems but never exist on disk
export type SynthLaneId = 'guitar-synth' | 'bass-synth'
export const SYNTH_LANE_FOR: Record<TabInstrument, SynthLaneId> = {
  guitar: 'guitar-synth',
  bass: 'bass-synth'
}

export type TabInstrument = 'guitar' | 'bass'

export const DEFAULT_STEMS: string[] = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

export const MODEL_STANDARD = 'htdemucs_ft'
export const MODEL_EXTENDED = 'bs_roformer'
export const MODEL_ROFORMER = 'bs_roformer'
export const MODEL_DEFAULT = 'bs_roformer'

export interface Song {
  videoId: string
  title: string
  duration: number
  addedAt: number
  model?: string
  stems?: string[]
  took?: number
}

export interface AppSettings {
  shifts: 1 | 2
  // windows + nvidia: separate on the GPU instead of the CPU. The toggle is
  // only rendered when an NVIDIA GPU is detected; enabling it downloads the
  // CUDA build of torch (~2.5GB) on first use
  gpuSplit: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  shifts: 1,
  gpuSplit: false
}

export interface EngineStatus {
  // cuda torch engine (windows + nvidia only)
  gpuDownloading: boolean
  gpuReady: boolean
}

export interface EnvStatus {
  python: { found: boolean; path?: string; version?: string }
  ffmpeg: { found: boolean; path?: string }
  ready: boolean
  bootstrapping: boolean
  updating: boolean
  gpu?: boolean
  // windows only: an NVIDIA GPU was detected (gates the GPU toggle in Settings)
  nvidiaGpu?: boolean
}

export interface EnvEvent {
  message: string
  level: 'info' | 'error' | 'success'
}

export type JobStage = 'metadata' | 'download' | 'convert' | 'separate' | 'finalize'

export interface JobProgress {
  videoId: string
  title?: string
  stage: JobStage
  pct: number
  message?: string
  model?: string
}

export interface JobDone {
  videoId: string
  song: Song
}

export interface JobFailed {
  videoId: string
  message: string
}

export type JobEvent =
  | { kind: 'progress'; data: JobProgress }
  | { kind: 'done'; data: JobDone }
  | { kind: 'failed'; data: JobFailed }

export interface SearchResult {
  videoId: string
  title: string
  channel?: string
  duration?: number
}

export interface UpdateEvent {
  status: 'checking' | 'available' | 'none' | 'progress' | 'downloaded' | 'error'
  version?: string
  pct?: number
}

export interface KaraokeWord {
  word: string
  start: number
  end: number
  probability?: number
}

export interface KaraokeLine {
  start: number
  end: number
  text: string
  words: KaraokeWord[]
}

export interface KaraokeData {
  model?: string
  language?: string
  languageProbability?: number
  duration?: number
  lines: KaraokeLine[]
}

export interface LyricsProgress {
  videoId: string
  pct: number
  message?: string
}

export interface TabNote {
  string: number
  fret: number
  pitch: number
  start: number
  end: number
  amplitude: number
  chord?: string
  articulation?: 'hammer' | 'pull' | 'slide'
}

export interface TabChord {
  start: number
  end: number
  name: string
}

export type TabMode = 'lead' | 'poly' | 'chord' | 'note'
export type TabVoicing = 'standard' | 'barre' | 'power'

export interface TabMeasure {
  number: number
  start: number
  end: number
  chord?: string
  notes: TabNote[]
}

export interface GuitarTabData {
  instrument?: TabInstrument
  // human readable description of what produced the notes
  engine?: string
  model?: string
  modelEngine?: TabEngine
  source?: 'audio' | 'midi'
  bpm: number
  mode?: TabMode
  voicingStyle?: string
  tuning: string[]
  tuningId?: string
  tuningPitches?: number[]
  positionAnchor?: string
  sensitivity?: string
  duration: number
  beatsPerBar?: number
  beats?: number[]
  downbeatPhase?: number
  chords?: TabChord[]
  notesCount: number
  midiPath?: string
  midiFile?: string
  midiTrack?: string
  midiOffset?: number
  transpose?: number
  notes: TabNote[]
  measures: TabMeasure[]
  asciiTab: string
}

export type TabEngine = 'basic_pitch' | 'mt3'

export interface TabProgress {
  videoId: string
  instrument?: TabInstrument
  pct: number
  message?: string
}

export interface TabTranscribeOptions {
  instrument: TabInstrument
  engine?: TabEngine
  mode?: TabMode
  voicing?: TabVoicing
  tuning?: string
  position?: string
  sensitivity?: string
  beatsPerBar?: number
  downbeatPhase?: number
}

export interface TabRebuildOptions {
  downbeatPhase?: number
  beatsPerBar?: number
}

export interface TabMidiImportOptions {
  instrument: TabInstrument
  midiPath: string
  track: number | 'all'
  offset?: number
  transpose?: number
  tuning?: string
  position?: string
  downbeatPhase?: number
}

export interface MidiTrackInfo {
  index: number
  name: string
  program: number
  programName: string
  isDrum: boolean
  noteCount: number
  pitchLow: string
  pitchHigh: string
  start: number
  end: number
}

export interface MidiFileInfo {
  path: string
  duration: number
  bpm: number
  tracks: MidiTrackInfo[]
}

export interface StemKitApi {
  envStatus(): Promise<EnvStatus>
  envBootstrap(): Promise<boolean>
  envUpdateYtDlp(): Promise<boolean>
  listSongs(): Promise<Song[]>
  deleteSong(videoId: string): Promise<void>
  getBuffers(videoId: string): Promise<Record<string, Uint8Array>>
  exportStem(videoId: string, stem: string): Promise<{ saved: boolean; path?: string }>
  exportAllStems(videoId: string): Promise<{ saved: boolean; path?: string; count?: number }>
  searchYouTube(query: string): Promise<SearchResult[]>
  startJob(url: string, model?: string, stems?: string[], force?: boolean): Promise<{ started: boolean }>
  cancelJob(videoId?: string): Promise<void>
  openExternal(url: string): Promise<void>
  getAppVersion(): Promise<string>
  installUpdate(): void
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getThumb(videoId: string): Promise<string | null>
  enginesStatus(): Promise<EngineStatus>
  fetchEngine(which: 'vocals' | 'ft' | 'gpu'): Promise<void>
  getLyrics(videoId: string): Promise<KaraokeData | null>
  transcribeLyrics(videoId: string, model?: string): Promise<KaraokeData>
  saveLyrics(videoId: string, data: KaraokeData): Promise<boolean>
  getTabs(videoId: string, instrument?: TabInstrument): Promise<GuitarTabData | null>
  transcribeTabs(videoId: string, opts: TabTranscribeOptions): Promise<GuitarTabData>
  rebuildTabs(videoId: string, instrument: TabInstrument, opts: TabRebuildOptions): Promise<GuitarTabData>
  pickMidiFile(): Promise<MidiFileInfo | null>
  importTabMidi(videoId: string, opts: TabMidiImportOptions): Promise<GuitarTabData>
  saveTabs(videoId: string, data: GuitarTabData, instrument?: TabInstrument): Promise<boolean>
  exportTabMidi(videoId: string, instrument?: TabInstrument): Promise<{ saved: boolean; path?: string }>
  exportTabAscii(videoId: string, instrument?: TabInstrument): Promise<{ saved: boolean; path?: string }>
  exportSynthLane(videoId: string, instrument: TabInstrument, wav: Uint8Array): Promise<{ saved: boolean; path?: string }>
  onUpdateEvent(cb: (ev: UpdateEvent) => void): () => void
  onJobEvent(cb: (ev: JobEvent) => void): () => void
  onEnvEvent(cb: (ev: EnvEvent) => void): () => void
  onSettingsChange(cb: (settings: AppSettings) => void): () => void
  onLyricsProgress(cb: (ev: LyricsProgress) => void): () => void
  onTabProgress(cb: (ev: TabProgress) => void): () => void
}
