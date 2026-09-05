export type StemId = 'vocals' | 'drums' | 'bass' | 'other' | 'piano' | 'guitar'

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
}

export interface TabMeasure {
  number: number
  start: number
  end: number
  chord?: string
  notes: TabNote[]
}

export interface GuitarTabData {
  instrument?: 'guitar' | 'bass'
  model?: string
  bpm: number
  mode?: 'chord' | 'note'
  voicingStyle?: string
  tuning: string[]
  tuningPitches?: number[]
  positionAnchor?: string
  sensitivity?: string
  duration: number
  notesCount: number
  midiPath?: string
  notes: TabNote[]
  measures: TabMeasure[]
  asciiTab: string
}

export interface TabProgress {
  videoId: string
  instrument?: 'guitar' | 'bass'
  pct: number
  message?: string
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
  getTabs(videoId: string, instrument?: 'guitar' | 'bass'): Promise<GuitarTabData | null>
  transcribeTabs(
    videoId: string,
    tuning?: string,
    position?: string,
    sensitivity?: string,
    mode?: 'chord' | 'note',
    voicing?: string,
    force?: boolean,
    instrument?: 'guitar' | 'bass'
  ): Promise<GuitarTabData>
  saveTabs(videoId: string, data: GuitarTabData, instrument?: 'guitar' | 'bass'): Promise<boolean>
  exportTabMidi(videoId: string, instrument?: 'guitar' | 'bass'): Promise<{ saved: boolean; path?: string }>
  exportTabAscii(videoId: string, instrument?: 'guitar' | 'bass'): Promise<{ saved: boolean; path?: string }>
  onUpdateEvent(cb: (ev: UpdateEvent) => void): () => void
  onJobEvent(cb: (ev: JobEvent) => void): () => void
  onEnvEvent(cb: (ev: EnvEvent) => void): () => void
  onSettingsChange(cb: (settings: AppSettings) => void): () => void
  onLyricsProgress(cb: (ev: LyricsProgress) => void): () => void
  onTabProgress(cb: (ev: TabProgress) => void): () => void
}
