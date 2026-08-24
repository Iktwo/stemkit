import { useCallback, useEffect, useMemo, useState } from 'react'
import type { EnvStatus, JobProgress, JobStage, Song } from '../../shared/types'
import { parseVideoId } from '../../shared/url'
import { Sidebar } from './components/Sidebar'
import { Home } from './components/Home'
import { Processing } from './components/Processing'
import { Player } from './components/Player'
import { Setup } from './components/Setup'
import { LogoMark } from './components/Icons'

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

export default function App(): React.ReactElement {
  const [status, setStatus] = useState<EnvStatus | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [job, setJob] = useState<JobProgress | null>(null)
  const [jobError, setJobError] = useState<{ videoId: string; message: string } | null>(null)
  const [lastUrl, setLastUrl] = useState('')
  const [lastModel, setLastModel] = useState('htdemucs')
  const [envLogs, setEnvLogs] = useState<EnvLog[]>([])

  useEffect(() => {
    void window.stemkit.envStatus().then(setStatus)
    void window.stemkit.listSongs().then(setSongs)
    const offJob = window.stemkit.onJobEvent((ev) => {
      if (ev.kind === 'progress') {
        setJobError(null)
        setJob(ev.data)
      } else if (ev.kind === 'done') {
        setJob(null)
        setJobError(null)
        void window.stemkit.listSongs().then(setSongs)
        setActiveId((cur) => cur ?? ev.data.song.videoId)
      } else {
        setJobError({ videoId: ev.data.videoId, message: ev.data.message })
      }
    })
    const offEnv = window.stemkit.onEnvEvent((e) =>
      setEnvLogs((l) => [...l.slice(-300), { message: e.message, level: e.level }])
    )
    return () => {
      offJob()
      offEnv()
    }
  }, [])

  useEffect(() => {
    if (status?.ready && envLogs.length > 0) {
      void window.stemkit.envStatus().then(setStatus)
    }
  }, [status?.ready])

  const startUrl = useCallback(async (url: string, model = 'htdemucs'): Promise<void> => {
    setLastUrl(url)
    setLastModel(model)
    setJobError(null)
    const vid = parseVideoId(url)
    setJob({ videoId: vid ?? '', stage: 'metadata', pct: 0, message: 'Starting…', model })
    await window.stemkit.startJob(url, model)
  }, [])

  const cancelJob = useCallback((): void => {
    void window.stemkit.cancelJob()
    setJob(null)
    setJobError(null)
  }, [])

  const retryJob = useCallback((): void => {
    if (lastUrl) void startUrl(lastUrl, lastModel)
  }, [lastUrl, lastModel, startUrl])

  const updateYtDlp = useCallback(async (): Promise<void> => {
    await window.stemkit.envUpdateYtDlp()
    if (lastUrl) void startUrl(lastUrl, lastModel)
  }, [lastUrl, lastModel, startUrl])

  const deleteSong = useCallback(async (videoId: string): Promise<void> => {
    if (job?.videoId === videoId) return
    if (jobError?.videoId === videoId) setJobError(null)
    await window.stemkit.deleteSong(videoId)
    setSongs(await window.stemkit.listSongs())
    setActiveId((cur) => (cur === videoId ? null : cur))
  }, [job, jobError])

  const activeSong = useMemo(
    () => songs.find((s) => s.videoId === activeId) ?? null,
    [songs, activeId]
  )

  const selectedJob = useMemo(
    () => (job && job.videoId && job.videoId === activeId ? job : null),
    [job, activeId]
  )
  const selectedError = useMemo(
    () => (jobError && jobError.videoId === activeId ? jobError.message : null),
    [jobError, activeId]
  )

  const pendingMap = useMemo(() => {
    const map: Record<string, { label: string; error?: boolean }> = {}
    if (job && job.videoId) {
      map[job.videoId] = { label: stageLabel(job.stage, job.pct) }
    }
    if (jobError) {
      map[jobError.videoId] = { label: 'failed', error: true }
    }
    return map
  }, [job, jobError])

  const displaySongs = useMemo(() => {
    const known = new Set(songs.map((s) => s.videoId))
    const top: Song[] = []
    if (job?.videoId && !known.has(job.videoId)) {
      top.push({
        videoId: job.videoId,
        title: job.title ?? '',
        duration: 0,
        addedAt: 0,
        model: job.model
      })
    }
    if (
      jobError &&
      !known.has(jobError.videoId) &&
      jobError.videoId !== job?.videoId
    ) {
      top.push({ videoId: jobError.videoId, title: '', duration: 0, addedAt: 0 })
    }
    return [...top, ...songs]
  }, [songs, job, jobError])

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

  const busyVideoId = job?.videoId || jobError?.videoId || null

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
        onCancel={cancelJob}
        onRetry={retryJob}
        onUpdateYtDlp={() => void updateYtDlp()}
      />
    )
  } else if (activeSong) {
    main = <Player key={activeSong.videoId} song={activeSong} />
  } else {
    main = <Home busy={!!job} hasSongs={displaySongs.length > 0} onStart={(u, m) => void startUrl(u, m)} />
  }

  return (
    <div className="h-full flex">
      <Sidebar
        songs={displaySongs}
        activeId={activeId}
        busyVideoId={busyVideoId}
        pending={pendingMap}
        onSelect={(id) => setActiveId(id)}
        onDelete={(id) => void deleteSong(id)}
        onAdd={() => setActiveId(null)}
      />
      <main className="flex-1 min-w-0">{main}</main>
    </div>
  )
}
