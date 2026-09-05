import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ReactElement
} from 'react'
import type { Song, StemId } from '../../../shared/types'
import { engine, decodePayload, type BufferMap } from './engine'
import type { YouTubeHost } from './youtube'

export type PresetId = 'all' | 'karaoke' | 'acapella' | 'drumnbass'

const bufferCache = new Map<string, Promise<BufferMap>>()

export function clearBufferCache(videoId?: string): void {
  if (videoId) {
    bufferCache.delete(videoId)
  } else {
    bufferCache.clear()
  }
}

export function getDecoded(videoId: string): Promise<BufferMap> {
  let entry = bufferCache.get(videoId)
  if (!entry) {
    entry = window.stemkit
      .getBuffers(videoId)
      .then((payload) => decodePayload(payload))
      .catch((err) => {
        bufferCache.delete(videoId)
        throw err
      })
    bufferCache.set(videoId, entry)
  }
  return entry
}

export interface PlayerContextValue {
  currentSong: Song | null
  playing: boolean
  duration: number
  decoding: boolean
  decodeError: string | null
  buffers: BufferMap
  vols: Partial<Record<StemId, number>>
  mutes: Set<StemId>
  solos: Set<StemId>
  master: number
  preset: PresetId | 'custom'
  getPosition: () => number
  loadSong: (song: Song, autoPlay?: boolean) => Promise<void>
  togglePlay: () => void
  seekTo: (seconds: number) => void
  setStemVolume: (id: StemId, vol: number) => void
  toggleStemMute: (id: StemId) => void
  toggleStemSolo: (id: StemId) => void
  setMasterVolume: (vol: number) => void
  applyPreset: (p: PresetId) => void
  stopAndClose: () => void
  registerHost: (host: YouTubeHost | null) => void
}

const PlayerContext = createContext<PlayerContextValue | null>(null)

export function PlayerProvider({ children }: { children: ReactNode }): ReactElement {
  const [currentSong, setCurrentSong] = useState<Song | null>(null)
  const [playing, setPlaying] = useState(false)
  const [duration, setDuration] = useState(0)
  const [decoding, setDecoding] = useState(false)
  const [decodeError, setDecodeError] = useState<string | null>(null)
  const [buffers, setBuffers] = useState<BufferMap>({})
  const [vols, setVols] = useState<Partial<Record<StemId, number>>>({})
  const [mutes, setMutes] = useState<Set<StemId>>(new Set())
  const [solos, setSolos] = useState<Set<StemId>>(new Set())
  const [master, setMaster] = useState(0.9)
  const [preset, setPreset] = useState<PresetId | 'custom'>('all')

  const posRef = useRef(0)
  const playingRef = useRef(false)
  const hostRef = useRef<YouTubeHost | null>(null)
  const loadTokenRef = useRef(0)

  const getPosition = useCallback((): number => {
    if (playingRef.current) return engine.expected()
    return posRef.current
  }, [])

  // Sync engine mix on changes
  useEffect(() => {
    engine.applyMix(vols, mutes, solos, master)
  }, [vols, mutes, solos, master])

  // Monitor track completion to automatically stop at the end
  useEffect(() => {
    if (!playing || duration <= 0) return
    const interval = setInterval(() => {
      const pos = engine.expected()
      if (pos >= duration) {
        posRef.current = 0
        engine.setPlaying(false, 0)
        playingRef.current = false
        setPlaying(false)
        hostRef.current?.pause()
        hostRef.current?.seek(0)
      }
    }, 200)
    return () => clearInterval(interval)
  }, [playing, duration])

  const registerHost = useCallback((host: YouTubeHost | null): void => {
    hostRef.current = host
  }, [])

  const togglePlay = useCallback((): void => {
    const next = !playingRef.current
    playingRef.current = next
    setPlaying(next)
    if (next) {
      const t = posRef.current
      engine.setPlaying(true, t)
      hostRef.current?.seek(t)
      hostRef.current?.play()
    } else {
      posRef.current = engine.expected()
      engine.setPlaying(false, posRef.current)
      hostRef.current?.pause()
    }
  }, [])

  const seekTo = useCallback((t: number): void => {
    posRef.current = t
    engine.align(t)
    hostRef.current?.seek(t)
  }, [])

  const setStemVolume = useCallback((id: StemId, vol: number): void => {
    setVols((prev) => ({ ...prev, [id]: vol }))
  }, [])

  const toggleStemMute = useCallback((id: StemId): void => {
    setMutes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setPreset('custom')
  }, [])

  const toggleStemSolo = useCallback((id: StemId): void => {
    setSolos((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setPreset('custom')
  }, [])

  const setMasterVolume = useCallback((vol: number): void => {
    setMaster(vol)
  }, [])

  const applyPreset = useCallback(
    (p: PresetId): void => {
      setPreset(p)
      const available = Object.keys(buffers) as StemId[]
      const nextMutes = new Set<StemId>()
      const nextSolos = new Set<StemId>()
      if (p === 'all') {
        // all unmuted
      } else if (p === 'karaoke') {
        if (available.includes('vocals')) nextMutes.add('vocals')
      } else if (p === 'acapella') {
        if (available.includes('vocals')) nextSolos.add('vocals')
      } else if (p === 'drumnbass') {
        if (available.includes('drums')) nextSolos.add('drums')
        if (available.includes('bass')) nextSolos.add('bass')
      }
      setMutes(nextMutes)
      setSolos(nextSolos)
    },
    [buffers]
  )

  const stopAndClose = useCallback((): void => {
    loadTokenRef.current++
    engine.stopAll()
    hostRef.current?.pause()
    hostRef.current?.seek(0)
    playingRef.current = false
    setPlaying(false)
    posRef.current = 0
    setCurrentSong(null)
    setBuffers({})
    setDuration(0)
    setDecoding(false)
    setDecodeError(null)
    setVols({})
    setMutes(new Set())
    setSolos(new Set())
    setPreset('all')
  }, [])

  const loadSong = useCallback(
    async (song: Song, autoPlay = false): Promise<void> => {
      // If the song is already loaded, don't reset or stop!
      if (currentSong?.videoId === song.videoId && Object.keys(buffers).length > 0) {
        if (autoPlay && !playingRef.current) {
          togglePlay()
        }
        return
      }

      const token = ++loadTokenRef.current
      engine.stopAll()
      hostRef.current?.pause()
      hostRef.current?.seek(0)
      playingRef.current = false
      setPlaying(false)
      posRef.current = 0

      setCurrentSong(song)
      setDuration(song.duration || 0)
      setBuffers({})
      setVols({})
      setMutes(new Set())
      setSolos(new Set())
      setPreset('all')
      setDecodeError(null)
      setDecoding(true)

      try {
        const decoded = await getDecoded(song.videoId)
        if (loadTokenRef.current !== token) return
        setBuffers(decoded)
        engine.setBuffers(decoded)
        setVols(Object.fromEntries(Object.keys(decoded).map((id) => [id, 1])))
        const d = engine.trackDuration()
        if (d > 0) setDuration(d)
        setDecoding(false)

        if (autoPlay && !playingRef.current) {
          playingRef.current = true
          setPlaying(true)
          engine.setPlaying(true, 0)
          hostRef.current?.seek(0)
          hostRef.current?.play()
        }
      } catch (err) {
        if (loadTokenRef.current !== token) return
        setDecoding(false)
        setDecodeError(err instanceof Error ? err.message : String(err))
      }
    },
    [currentSong?.videoId, buffers, togglePlay]
  )

  const value: PlayerContextValue = {
    currentSong,
    playing,
    duration,
    decoding,
    decodeError,
    buffers,
    vols,
    mutes,
    solos,
    master,
    preset,
    getPosition,
    loadSong,
    togglePlay,
    seekTo,
    setStemVolume,
    toggleStemMute,
    toggleStemSolo,
    setMasterVolume,
    applyPreset,
    stopAndClose,
    registerHost
  }

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}

export function usePlayer(): PlayerContextValue {
  const ctx = useContext(PlayerContext)
  if (!ctx) {
    throw new Error('usePlayer must be used within a PlayerProvider')
  }
  return ctx
}
