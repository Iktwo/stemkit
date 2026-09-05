import type { StemId } from '../../../shared/types'
import { MicIcon, DrumIcon, BassIcon, WaveIcon, PianoIcon, GuitarIcon, MusicNoteIcon } from '../components/Icons'

export interface StemMeta {
  id: StemId
  label: string
  color: string
  icon: React.ReactNode
  // rendered in the app from a tab's MIDI notes rather than separated from the song
  synth?: boolean
}

const ALL_META: Record<StemId, StemMeta> = {
  vocals: { id: 'vocals', label: 'vocals', color: '#A5BD6A', icon: <MicIcon /> },
  drums: { id: 'drums', label: 'drums', color: '#F87171', icon: <DrumIcon /> },
  bass: { id: 'bass', label: 'bass', color: '#60A5FA', icon: <BassIcon /> },
  'bass-synth': { id: 'bass-synth', label: 'bass synth', color: '#93C5FD', icon: <MusicNoteIcon />, synth: true },
  guitar: { id: 'guitar', label: 'guitar', color: '#F472B6', icon: <GuitarIcon /> },
  'guitar-synth': { id: 'guitar-synth', label: 'guitar synth', color: '#F9A8D4', icon: <MusicNoteIcon />, synth: true },
  piano: { id: 'piano', label: 'piano', color: '#FBBF24', icon: <PianoIcon /> },
  other: { id: 'other', label: 'other', color: '#34D399', icon: <WaveIcon /> }
}

// the six stems the separation engine can produce
const PREFERRED_ORDER: StemId[] = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
// mixer lane order, synth lanes right under the stem they were transcribed from
const LANE_ORDER: StemId[] = ['vocals', 'drums', 'bass', 'bass-synth', 'guitar', 'guitar-synth', 'piano', 'other']

export { ALL_META as STEM_INFO, PREFERRED_ORDER, LANE_ORDER }

export function buildStemMeta(available: StemId[]): StemMeta[] {
  return LANE_ORDER.filter((id) => available.includes(id)).map((id) => ALL_META[id])
}
