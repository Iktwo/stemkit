import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  MODEL_EXTENDED,
  type EnvStatus,
  type JobProgress,
  type JobStage,
  type Song,
  type UpdateEvent
} from '../../shared/types'
import { parseVideoId } from '../../shared/url'
import { Sidebar } from './components/Sidebar'
import { Home } from './components/Home'
import { Processing } from './components/Processing'
import { Player } from './components/Player'
import { MiniPlayer } from './components/MiniPlayer'
import { Setup } from './components/Setup'
import { LogoMark } from './components/Icons'
import { PlayerProvider, usePlayer, clearBufferCache } from './lib/PlayerContext'

interface EnvLog {
  message: string
  level: string
}

function stageLabel(stage: JobStage, pct: number): string {
  switch (stage) {
    case 'metadata':
      return 'reading info…'
    case 'download':
      return `downloading ${Math.round(pct)}%`
    case 'convert':
      return 'converting…'
    case 'separate':
      return `separating ${Math.round(pct)}%`
    case 'finalize':
      return 'finishing…'
  }
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _drop, ...rest } = map
  return rest
}

function MainApp(): React.ReactElement {
  const [status, setStatus] = useState<EnvStatus | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Record<string, JobProgress>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [lastUrl, setLastUrl] = useState('')
  const [lastModel, setLastModel] = useState(MODEL_EXTENDED)
  const [envLogs, setEnvLogs] = useState<EnvLog[]>([])
  const [update, setUpdate] = useState<UpdateEvent | null>(null)
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined)

  const {
    currentSong,
    playing,
    duration,
    master,
    getPosition,
    togglePlay,
    seekTo,
    setMasterVolume,
    stopAndClose
  } = usePlayer()

  useEffect(() => {
    void window.stemkit.envStatus().then(setStatus)
    void window.stemkit.listSongs().then(setSongs)
    const offJob = window.stemkit.onJobEvent((ev) => {
      if (ev.kind === 'progress') {
        setJobs((prev) => ({ ...prev, [ev.data.videoId]: ev.data }))
        setErrors((prev) => (prev[ev.data.videoId] ? withoutKey(prev, ev.data.videoId) : prev))
      } else if (ev.kind === 'done') {
        clearBufferCache(ev.data.videoId)
        setJobs((prev) => withoutKey(prev, ev.data.videoId))
        setErrors((prev) => withoutKey(prev, ev.data.videoId))
        void window.stemkit.listSongs().then(setSongs)
      } else if (ev.data.message === 'Cancelled') {
        setJobs((prev) => withoutKey(prev, ev.data.videoId))
      } else {
        setJobs((prev) => withoutKey(prev, ev.data.videoId))
        setErrors((prev) => ({ ...prev, [ev.data.videoId]: ev.data.message }))
      }
    })
    const offEnv = window.stemkit.onEnvEvent((e) =>
      setEnvLogs((l) => [...l.slice(-300), { message: e.message, level: e.level }])
    )
    const offUpdate = window.stemkit.onUpdateEvent((e) => setUpdate(e))
    void window.stemkit.getAppVersion().then(setAppVersion)
    return () => {
      offJob()
      offEnv()
      offUpdate()
    }
  }, [])

  useEffect(() => {
    if (status?.ready && envLogs.length > 0) {
      void window.stemkit.envStatus().then(setStatus)
    }
  }, [status?.ready])

  const startUrl = useCallback(
    async (url: string, model = MODEL_EXTENDED, stems?: string[], force = false): Promise<void> => {
      const vid = parseVideoId(url)
      if (!vid) return
      setLastUrl(url)
      setLastModel(model)
      setErrors((prev) => withoutKey(prev, vid))
      setJobs((prev) =>
        prev[vid]
          ? prev
          : { ...prev, [vid]: { videoId: vid, stage: 'metadata', pct: 0, message: 'Starting…', model } }
      )
      await window.stemkit.startJob(url, model, stems, force)
    },
    []
  )

  const handleReprocess = useCallback(
    async (videoId: string, model: string, stems: string[]): Promise<void> => {
      const url = `https://www.youtube.com/watch?v=${videoId}`
      clearBufferCache(videoId)
      if (currentSong?.videoId === videoId) {
        stopAndClose()
      }
      await startUrl(url, model, stems, true)
    },
    [startUrl, currentSong?.videoId, stopAndClose]
  )

  const cancelSelectedJob = useCallback(
    (videoId: string): void => {
      void window.stemkit.cancelJob(videoId)
      setJobs((prev) => withoutKey(prev, videoId))
    },
    []
  )

  const retryJob = useCallback((): void => {
    if (lastUrl) void startUrl(lastUrl, lastModel)
  }, [lastUrl, lastModel, startUrl])

  const updateYtDlp = useCallback(async (): Promise<void> => {
    await window.stemkit.envUpdateYtDlp()
    if (lastUrl) void startUrl(lastUrl, lastModel)
  }, [lastUrl, lastModel, startUrl])

  const deleteSong = useCallback(
    async (videoId: string): Promise<void> => {
      if (jobs[videoId]) return
      if (currentSong?.videoId === videoId) {
        stopAndClose()
      }
      setErrors((prev) => withoutKey(prev, videoId))
      await window.stemkit.deleteSong(videoId)
      setSongs(await window.stemkit.listSongs())
      setActiveId((cur) => (cur === videoId ? null : cur))
    },
    [jobs, currentSong?.videoId, stopAndClose]
  )

  const activeSong = useMemo(
    () => songs.find((s) => s.videoId === activeId) ?? null,
    [songs, activeId]
  )

  const selectedJob = useMemo(
    () => (activeId ? jobs[activeId] ?? null : null),
    [jobs, activeId]
  )
  const selectedError = useMemo(
    () => (activeId ? errors[activeId] ?? null : null),
    [errors, activeId]
  )

  const pendingMap = useMemo(() => {
    const map: Record<string, { label: string; error?: boolean }> = {}
    for (const j of Object.values(jobs)) {
      map[j.videoId] = { label: stageLabel(j.stage, j.pct) }
    }
    for (const [id, message] of Object.entries(errors)) {
      if (!map[id]) {
        map[id] = { label: /already being processed/.test(message) ? 'queued' : 'failed', error: true }
      }
    }
    return map
  }, [jobs, errors])

  const displaySongs = useMemo(() => {
    const known = new Set(songs.map((s) => s.videoId))
    const top: Song[] = []
    for (const j of Object.values(jobs)) {
      if (!known.has(j.videoId)) {
        top.push({
          videoId: j.videoId,
          title: j.title ?? '',
          duration: 0,
          addedAt: 0,
          model: j.model
        })
        known.add(j.videoId)
      }
    }
    for (const id of Object.keys(errors)) {
      if (!known.has(id)) {
        top.push({ videoId: id, title: '', duration: 0, addedAt: 0 })
        known.add(id)
      }
    }
    return [...top, ...songs]
  }, [songs, jobs, errors])

  if (!status) {
    return (
      <div className="h-full flex items-center justify-center">
        <LogoMark className="w-12 h-12 animate-pulse" />
      </div>
    )
  }

  if (!status.ready) {
    return (
      <Setup
        status={status}
        logs={envLogs}
        onInstall={() => {
          void window.stemkit.envBootstrap().then(() => window.stemkit.envStatus().then(setStatus))
        }}
      />
    )
  }

  const selectedIsBusy = !!(selectedJob || selectedError)

  let main: React.ReactElement
  if (selectedIsBusy) {
    main = (
      <Processing
        job={selectedJob}
        error={selectedError}
        botSuspected={
          !!selectedError && /sign in|bot|confirm|unavailable|private/i.test(selectedError)
        }
        onCancel={() => activeId && cancelSelectedJob(activeId)}
        onRetry={retryJob}
        onUpdateYtDlp={() => void updateYtDlp()}
      />
    )
  } else if (activeSong) {
    main = <Player key={activeSong.videoId} song={activeSong} onReprocess={handleReprocess} />
  } else {
    main = (
      <Home
        hasSongs={displaySongs.length > 0}
        songs={displaySongs}
        pending={pendingMap}
        onStart={(u, m, s) => void startUrl(u, m, s)}
        onSelect={(id) => setActiveId(id)}
      />
    )
  }

  // Mini player appears when audio is loaded/active and the user is NOT looking at the full player for that song
  const showMiniPlayer =
    !!currentSong && (activeId !== currentSong.videoId || selectedIsBusy)

  return (
    <div className="h-full flex overflow-hidden">
      <Sidebar
        songs={displaySongs}
        activeId={activeId}
        playingId={currentSong?.videoId}
        isPlaying={playing}
        pending={pendingMap}
        update={update ?? undefined}
        appVersion={appVersion}
        onSelect={(id) => setActiveId(id)}
        onDelete={(id) => void deleteSong(id)}
        onAdd={() => setActiveId(null)}
        onInstallUpdate={() => window.stemkit.installUpdate()}
      />
      <div className="flex-1 min-w-0 flex flex-col h-full overflow-hidden relative">
        <main className="flex-1 min-w-0 overflow-hidden relative">
          {main}
        </main>
        {showMiniPlayer && currentSong && (
          <MiniPlayer
            song={currentSong}
            playing={playing}
            duration={duration}
            getPosition={getPosition}
            onTogglePlay={togglePlay}
            onSeek={seekTo}
            master={master}
            onMaster={setMasterVolume}
            onExpand={() => setActiveId(currentSong.videoId)}
            onClose={stopAndClose}
          />
        )}
      </div>
    </div>
  )
}

export default function App(): React.ReactElement {
  return (
    <PlayerProvider>
      <MainApp />
    </PlayerProvider>
  )
}
