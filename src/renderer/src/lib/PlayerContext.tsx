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
import type { Song, StemId, SynthLaneId } from '../../../shared/types'
import { engine, decodePayload, type BufferMap } from './engine'

export type PresetId = 'all' | 'karaoke' | 'acapella' | 'drumnbass' | 'custom'

export interface LoopRegion {
  start: number
  end: number
}

export const PLAYBACK_RATES = [0.5, 0.65, 0.75, 0.9, 1] as const

export function detectPreset(mutes: Set<StemId>, solos: Set<StemId>): PresetId {
  if (mutes.size === 0 && solos.size === 0) {
    return 'all'
  }
  if (mutes.size === 1 && mutes.has('vocals') && solos.size === 0) {
    return 'karaoke'
  }
  if (mutes.size === 0 && solos.size === 1 && solos.has('vocals')) {
    return 'acapella'
  }
  if (mutes.size === 0 && solos.size === 2 && solos.has('drums') && solos.has('bass')) {
    return 'drumnbass'
  }
  return 'custom'
}

export function getPresetMutesAndSolos(p: PresetId): {
  mutes: Set<StemId>
  solos: Set<StemId>
} {
  const mutes = new Set<StemId>()
  const solos = new Set<StemId>()
  if (p === 'all' || p === 'custom') {
    // all unmuted
  } else if (p === 'karaoke') {
    mutes.add('vocals')
  } else if (p === 'acapella') {
    solos.add('vocals')
  } else if (p === 'drumnbass') {
    solos.add('drums')
    solos.add('bass')
  }
  return { mutes, solos }
}

const MAX_BUFFER_CACHE = 4
const bufferCache = new Map<string, BufferMap>()
const inFlightDecodes = new Map<string, Promise<BufferMap>>()

export function clearBufferCache(videoId?: string): void {
  if (videoId) {
    bufferCache.delete(videoId)
    inFlightDecodes.delete(videoId)
  } else {
    bufferCache.clear()
    inFlightDecodes.clear()
  }
}

export function getDecoded(videoId: string): Promise<BufferMap> {
  const cached = bufferCache.get(videoId)
  if (cached && Object.keys(cached).length > 0) {
    // Refresh LRU order
    bufferCache.delete(videoId)
    bufferCache.set(videoId, cached)
    return Promise.resolve(cached)
  }

  let entry = inFlightDecodes.get(videoId)
  if (!entry) {
    entry = window.stemkit
      .getBuffers(videoId)
      .then((payload) => decodePayload(payload))
      .then((decoded) => {
        inFlightDecodes.delete(videoId)
        if (Object.keys(decoded).length > 0) {
          if (bufferCache.size >= MAX_BUFFER_CACHE) {
            const oldestKey = bufferCache.keys().next().value
            if (oldestKey) bufferCache.delete(oldestKey)
          }
          bufferCache.set(videoId, decoded)
        }
        return decoded
      })
      .catch((err) => {
        inFlightDecodes.delete(videoId)
        throw err
      })
    inFlightDecodes.set(videoId, entry)
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
  preset: PresetId
  // practice tools: tape-style speed (pitch follows) and an A-B loop
  rate: number
  loop: LoopRegion | null
  getPosition: () => number
  loadSong: (song: Song, autoPlay?: boolean) => Promise<void>
  togglePlay: () => void
  seekTo: (seconds: number) => void
  setRate: (rate: number) => void
  setLoop: (loop: LoopRegion | null) => void
  // lanes rendered from a tab's notes; live in the mixer like a stem
  addSynthLane: (id: SynthLaneId, buffer: AudioBuffer) => void
  removeSynthLane: (id: SynthLaneId) => void
  setStemVolume: (id: StemId, vol: number) => void
  toggleStemMute: (id: StemId) => void
  setStemMute: (id: StemId, muted: boolean) => void
  toggleStemSolo: (id: StemId) => void
  setMasterVolume: (vol: number) => void
  applyPreset: (p: PresetId) => void
  stopAndClose: () => void
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
  const [preset, setPreset] = useState<PresetId>('all')
  const [rate, setRateState] = useState(1)
  const [loop, setLoopState] = useState<LoopRegion | null>(null)
  const loopRef = useRef<LoopRegion | null>(null)
  loopRef.current = loop

  const posRef = useRef(0)
  const playingRef = useRef(false)
  const loadTokenRef = useRef(0)
  const presetRef = useRef<PresetId>('all')
  const customMixRef = useRef<{ mutes: Set<StemId>; solos: Set<StemId> } | null>(null)

  const currentSongRef = useRef<Song | null>(null)
  currentSongRef.current = currentSong

  const buffersRef = useRef<BufferMap>({})
  buffersRef.current = buffers

  const masterRef = useRef(0.9)
  masterRef.current = master

  const mutesRef = useRef<Set<StemId>>(new Set())
  mutesRef.current = mutes

  const solosRef = useRef<Set<StemId>>(new Set())
  solosRef.current = solos

  const getPosition = useCallback((): number => {
    if (playingRef.current) return engine.expected()
    return posRef.current
  }, [])

  // Sync engine mix on changes
  useEffect(() => {
    engine.applyMix(vols, mutes, solos, master)
  }, [vols, mutes, solos, master])

  // Monitor playback: wrap the A-B loop and stop at the end of the track
  useEffect(() => {
    if (!playing || duration <= 0) return
    const interval = setInterval(() => {
      const pos = engine.expected()
      const region = loopRef.current
      if (region && region.end > region.start + 0.2 && pos >= region.end - 0.015) {
        posRef.current = region.start
        engine.align(region.start)
        return
      }
      if (pos >= duration) {
        posRef.current = 0
        engine.setPlaying(false, 0)
        playingRef.current = false
        setPlaying(false)
      }
    }, 50)
    return () => clearInterval(interval)
  }, [playing, duration])

  const togglePlay = useCallback((): void => {
    const next = !playingRef.current
    playingRef.current = next
    setPlaying(next)
    if (next) {
      const t = posRef.current
      engine.setPlaying(true, t)
    } else {
      posRef.current = engine.expected()
      engine.setPlaying(false, posRef.current)
    }
  }, [])

  const togglePlayRef = useRef(togglePlay)
  togglePlayRef.current = togglePlay

  const seekTo = useCallback((t: number): void => {
    posRef.current = t
    engine.align(t)
  }, [])

  const setRate = useCallback((r: number): void => {
    engine.setRate(r)
    if (!playingRef.current) posRef.current = engine.expected()
    setRateState(engine.rate)
  }, [])

  const setLoop = useCallback((region: LoopRegion | null): void => {
    const next =
      region && region.end > region.start + 0.2
        ? { start: Math.max(0, region.start), end: region.end }
        : region
    loopRef.current = next
    setLoopState(next)
  }, [])

  const addSynthLane = useCallback((id: SynthLaneId, buffer: AudioBuffer): void => {
    engine.addBuffer(id, buffer)
    setBuffers((prev) => ({ ...prev, [id]: buffer }))
    setVols((prev) => ({ ...prev, [id]: prev[id] ?? 0.9 }))
  }, [])

  const removeSynthLane = useCallback((id: SynthLaneId): void => {
    engine.removeBuffer(id)
    setBuffers((prev) => {
      const { [id]: _drop, ...rest } = prev
      return rest
    })
    setVols((prev) => {
      const { [id]: _drop, ...rest } = prev
      return rest
    })
    setMutes((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      mutesRef.current = next
      return next
    })
    setSolos((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      solosRef.current = next
      return next
    })
  }, [])

  const setStemVolume = useCallback((id: StemId, vol: number): void => {
    setVols((prev) => ({ ...prev, [id]: vol }))
  }, [])

  const toggleStemMute = useCallback((id: StemId): void => {
    setMutes((prev) => {
      const nextMutes = new Set(prev)
      if (nextMutes.has(id)) nextMutes.delete(id)
      else nextMutes.add(id)

      mutesRef.current = nextMutes
      const detected = detectPreset(nextMutes, solosRef.current)
      presetRef.current = detected
      setPreset(detected)
      if (detected === 'custom') {
        customMixRef.current = {
          mutes: new Set(nextMutes),
          solos: new Set(solosRef.current)
        }
      } else if (customMixRef.current) {
        customMixRef.current.mutes.delete(id)
        if (customMixRef.current.mutes.size === 0 && customMixRef.current.solos.size === 0) {
          customMixRef.current = null
        }
      }
      return nextMutes
    })
  }, [])

  const setStemMute = useCallback((id: StemId, muted: boolean): void => {
    setMutes((prev) => {
      const nextMutes = new Set(prev)
      if (muted) nextMutes.add(id)
      else nextMutes.delete(id)

      mutesRef.current = nextMutes
      const detected = detectPreset(nextMutes, solosRef.current)
      presetRef.current = detected
      setPreset(detected)
      if (detected === 'custom') {
        customMixRef.current = {
          mutes: new Set(nextMutes),
          solos: new Set(solosRef.current)
        }
      } else if (customMixRef.current) {
        customMixRef.current.mutes.delete(id)
        if (customMixRef.current.mutes.size === 0 && customMixRef.current.solos.size === 0) {
          customMixRef.current = null
        }
      }
      return nextMutes
    })
  }, [])

  const toggleStemSolo = useCallback((id: StemId): void => {
    setSolos((prev) => {
      const nextSolos = new Set(prev)
      if (nextSolos.has(id)) nextSolos.delete(id)
      else nextSolos.add(id)

      solosRef.current = nextSolos
      const detected = detectPreset(mutesRef.current, nextSolos)
      presetRef.current = detected
      setPreset(detected)
      if (detected === 'custom') {
        customMixRef.current = {
          mutes: new Set(mutesRef.current),
          solos: new Set(nextSolos)
        }
      }
      return nextSolos
    })
  }, [])

  const setMasterVolume = useCallback((vol: number): void => {
    setMaster(vol)
  }, [])

  const applyPreset = useCallback((p: PresetId): void => {
    presetRef.current = p
    setPreset(p)
    if (p === 'custom') {
      if (customMixRef.current) {
        const nextMutes = new Set(customMixRef.current.mutes)
        const nextSolos = new Set(customMixRef.current.solos)
        mutesRef.current = nextMutes
        solosRef.current = nextSolos
        setMutes(nextMutes)
        setSolos(nextSolos)
      } else {
        customMixRef.current = {
          mutes: new Set(mutesRef.current),
          solos: new Set(solosRef.current)
        }
      }
      return
    }
    const { mutes: nextMutes, solos: nextSolos } = getPresetMutesAndSolos(p)
    mutesRef.current = nextMutes
    solosRef.current = nextSolos
    setMutes(nextMutes)
    setSolos(nextSolos)
  }, [])

  const stopAndClose = useCallback((): void => {
    loadTokenRef.current++
    engine.stopAll()
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
    mutesRef.current = new Set()
    solosRef.current = new Set()
    setPreset('all')
    presetRef.current = 'all'
    customMixRef.current = null
    loopRef.current = null
    setLoopState(null)
  }, [])

  const loadSong = useCallback(
    async (song: Song, autoPlay = false): Promise<void> => {
      // If the song is already loaded, don't reset or stop!
      if (currentSongRef.current?.videoId === song.videoId) {
        if (Object.keys(buffersRef.current).length > 0) {
          if (autoPlay && !playingRef.current) {
            togglePlayRef.current()
          }
          return
        }
        if (inFlightDecodes.has(song.videoId)) {
          return
        }
      }

      const token = ++loadTokenRef.current
      engine.stopAll()
      playingRef.current = false
      setPlaying(false)
      posRef.current = 0
      loopRef.current = null
      setLoopState(null)

      // Fast-path: if song is already cached in memory, switch immediately without flashing!
      const cached = bufferCache.get(song.videoId)
      if (cached && Object.keys(cached).length > 0) {
        bufferCache.delete(song.videoId)
        bufferCache.set(song.videoId, cached)

        setCurrentSong(song)
        setBuffers(cached)
        engine.setBuffers(cached)
        const newVols = Object.fromEntries(Object.keys(cached).map((id) => [id, 1]))
        setVols(newVols)
        const d = engine.trackDuration() || song.duration || 0
        setDuration(d)
        setDecodeError(null)
        setDecoding(false)

        const activePreset = presetRef.current
        if (activePreset !== 'custom') {
          const { mutes: activeMutes, solos: activeSolos } = getPresetMutesAndSolos(activePreset)
          mutesRef.current = activeMutes
          solosRef.current = activeSolos
          setMutes(activeMutes)
          setSolos(activeSolos)
          engine.applyMix(newVols, activeMutes, activeSolos, masterRef.current)
        } else {
          const stemKeys = Object.keys(cached) as StemId[]
          let activeSolos = solosRef.current
          if (activeSolos.size > 0 && ![...activeSolos].some((id) => stemKeys.includes(id))) {
            activeSolos = new Set<StemId>()
            solosRef.current = activeSolos
            setSolos(activeSolos)
          }
          let activeMutes = mutesRef.current
          if (stemKeys.length > 0 && stemKeys.every((id) => activeMutes.has(id))) {
            activeMutes = new Set<StemId>()
            mutesRef.current = activeMutes
            setMutes(activeMutes)
            presetRef.current = 'all'
            setPreset('all')
          }
          engine.applyMix(newVols, activeMutes, activeSolos, masterRef.current)
        }

        if (autoPlay && !playingRef.current) {
          playingRef.current = true
          setPlaying(true)
          engine.setPlaying(true, 0)
        }
        return
      }

      setCurrentSong(song)
      setDuration(song.duration || 0)
      setBuffers({})
      setVols({})
      setDecodeError(null)
      setDecoding(true)

      // Respect whatever preset is active (or selected before/during load)
      const currentPreset = presetRef.current
      if (currentPreset !== 'custom') {
        const { mutes: initMutes, solos: initSolos } = getPresetMutesAndSolos(currentPreset)
        mutesRef.current = initMutes
        solosRef.current = initSolos
        setMutes(initMutes)
        setSolos(initSolos)
      }

      try {
        const decoded = await getDecoded(song.videoId)
        if (loadTokenRef.current !== token) return
        setBuffers(decoded)
        engine.setBuffers(decoded)
        const newVols = Object.fromEntries(Object.keys(decoded).map((id) => [id, 1]))
        setVols(newVols)
        const d = engine.trackDuration() || song.duration || 0
        if (d > 0) setDuration(d)
        setDecoding(false)

        // Ensure the active preset (or whatever preset user picked while decoding) is applied to the engine
        const activePreset = presetRef.current
        if (activePreset !== 'custom') {
          const { mutes: activeMutes, solos: activeSolos } = getPresetMutesAndSolos(activePreset)
          mutesRef.current = activeMutes
          solosRef.current = activeSolos
          setMutes(activeMutes)
          setSolos(activeSolos)
          engine.applyMix(newVols, activeMutes, activeSolos, masterRef.current)
        } else {
          const stemKeys = Object.keys(decoded) as StemId[]
          let activeSolos = solosRef.current
          if (activeSolos.size > 0 && ![...activeSolos].some((id) => stemKeys.includes(id))) {
            activeSolos = new Set<StemId>()
            solosRef.current = activeSolos
            setSolos(activeSolos)
          }
          let activeMutes = mutesRef.current
          if (stemKeys.length > 0 && stemKeys.every((id) => activeMutes.has(id))) {
            activeMutes = new Set<StemId>()
            mutesRef.current = activeMutes
            setMutes(activeMutes)
            presetRef.current = 'all'
            setPreset('all')
          }
          engine.applyMix(newVols, activeMutes, activeSolos, masterRef.current)
        }

        if (autoPlay && !playingRef.current) {
          playingRef.current = true
          setPlaying(true)
          engine.setPlaying(true, 0)
        }
      } catch (err) {
        if (loadTokenRef.current !== token) return
        setDecoding(false)
        const msg = err instanceof Error ? err.message : String(err)
        setDecodeError(msg)
      }
    },
    []
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
    rate,
    loop,
    getPosition,
    loadSong,
    togglePlay,
    seekTo,
    setRate,
    setLoop,
    addSynthLane,
    removeSynthLane,
    setStemVolume,
    toggleStemMute,
    setStemMute,
    toggleStemSolo,
    setMasterVolume,
    applyPreset,
    stopAndClose
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
