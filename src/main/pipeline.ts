import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { readdirSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import {
  venvPython,
  venvYtDlp,
  separateScript,
  transcribeScript,
  tabScript,
  ensureGpuEngine,
  ensureTabEngineDeps,
  getStatus,
  ytDlpRuntimeArgs
} from './env'
import { loadSettings } from './settings'
import {
  songDir,
  stemsDir,
  stemsPresent,
  stemsFor,
  mixWavPath,
  rawDownloadPath,
  upsertSong,
  loadSongs,
  lyricsPath,
  loadLyrics,
  tabPath,
  loadTabs
} from './library'
import { MODEL_EXTENDED, type JobEvent, type JobStage, type KaraokeData, type GuitarTabData } from '../shared/types'
import { parseVideoId } from '../shared/url'
import { cacheThumbnail } from './thumbs'

interface ActiveJob {
  videoId: string
  title?: string
  model: string
  cancelled: boolean
  proc?: ChildProcess
}

interface QueuedItem {
  url: string
  videoId: string
  model: string
  stems?: string[]
  force?: boolean
}

const jobs = new Map<string, ActiveJob>()
const queue: QueuedItem[] = []
let currentRunningJob: ActiveJob | null = null

function send(ev: JobEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('job:event', ev)
  }
}

function progress(
  job: ActiveJob,
  stage: JobStage,
  pct: number,
  message?: string
): void {
  if (!jobs.has(job.videoId) || job.cancelled) return
  send({
    kind: 'progress',
    data: { videoId: job.videoId, stage, pct, message, title: job.title, model: job.model }
  })
}

export function extractVideoId(url: string): string | null {
  return parseVideoId(url)
}

function updateQueuePositions(): void {
  queue.forEach((item, index) => {
    const queuedJob = jobs.get(item.videoId)
    if (queuedJob && !queuedJob.cancelled) {
      progress(queuedJob, 'metadata', 0, `In queue (position #${index + 1})`)
    }
  })
}

async function executeJob(job: ActiveJob, url: string, stems?: string[]): Promise<void> {
  currentRunningJob = job
  const videoId = job.videoId
  const startedAt = Date.now()

  const bail = (message: string): never => {
    throw Object.assign(new Error(message), { videoId })
  }

  const settings = loadSettings()
  const useGpu = settings.gpuSplit && process.platform === 'win32'
  const deviceArg = (): string => {
    if (process.platform === 'win32') return useGpu ? 'cuda' : 'cpu'
    return 'auto'
  }

  try {
    const existing = loadSongs().find((s) => s.videoId === videoId)

    mkdirSync(songDir(videoId), { recursive: true })

    let meta: { title: string; duration: number }
    const hasMixWav = existsSync(mixWavPath(videoId))

    if (existing && hasMixWav && existing.title) {
      meta = { title: existing.title, duration: existing.duration || 0 }
      job.title = meta.title
      progress(job, 'metadata', 100, meta.title)
    } else {
      progress(job, 'metadata', 0, 'Reading video info')

      let raw = ''
      await runProcess(job, venvYtDlp(), [...ytDlpRuntimeArgs(), '-J', '--no-playlist', '--skip-download', url], {
        onStdout: (chunk) => {
          raw += chunk
        }
      })
      try {
        const parsed = JSON.parse(raw)
        meta = {
          title: typeof parsed.title === 'string' ? parsed.title : 'Unknown title',
          duration: typeof parsed.duration === 'number' ? Math.round(parsed.duration) : 0
        }
        // Warm thumbnail cache locally for offline library browsing
        void cacheThumbnail(videoId, typeof parsed.thumbnail === 'string' ? parsed.thumbnail : undefined)
      } catch {
        bail('Could not read video metadata')
      }
      if (job.cancelled || !jobs.has(videoId)) return
      job.title = meta!.title
      progress(job, 'metadata', 100, meta!.title)

      progress(job, 'download', 0, 'Downloading audio from YouTube')
      let maxPct = 0
      await runProcess(
        job,
        venvYtDlp(),
        [
          ...ytDlpRuntimeArgs(),
          '-f',
          'bestaudio[ext=m4a]/bestaudio/best',
          '--no-playlist',
          '-o',
          rawDownloadPath(videoId),
          url
        ],
        {
          onStdout: (chunk) => {
            for (const piece of chunk.split(/[\r\n]/)) {
              const m = piece.match(/(\d+(?:\.\d+)?)%/)
              if (m) {
                const pct = parseFloat(m[1])
                if (pct > maxPct && pct <= 100) {
                  maxPct = pct
                  progress(job, 'download', pct)
                }
              }
            }
          }
        }
      )
      if (job.cancelled || !jobs.has(videoId)) return

      const dir = songDir(videoId)
      const rawFile = readdirSync(dir).find((f) => f.startsWith('raw.'))
      if (!rawFile) bail('Download produced no file')
      const rawPath = join(dir, rawFile as string)

      progress(job, 'convert', 0, 'Converting to WAV')
      const ffmpeg = getStatus().ffmpeg.path
      if (!ffmpeg) bail('Something went wrong with the built-in audio tools. Try reinstalling StemKit.')
      await runProcess(job, ffmpeg as string, [
        '-y',
        '-i',
        rawPath,
        '-af',
        'aresample=44100:resampler=soxr',
        '-ar',
        '44100',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        mixWavPath(videoId)
      ])
      rmSync(rawPath, { force: true })
      if (job.cancelled || !jobs.has(videoId)) return
      progress(job, 'convert', 100)
    }

    rmSync(stemsDir(videoId), { recursive: true, force: true })
    mkdirSync(stemsDir(videoId), { recursive: true })
    progress(
      job,
      'separate',
      0,
      'Preparing BS-RoFormer SOTA engine…'
    )

    if (job.cancelled || !jobs.has(videoId)) return
    if (useGpu) {
      if (
        !(await ensureGpuEngine(
          (pct) => progress(job, 'separate', 0, `Downloading GPU engine: ${pct}%`),
          true
        ))
      ) {
        bail('Could not prepare the GPU engine — switch back to CPU in Settings and try again')
      }
    }

    progress(job, 'separate', 0, 'Separating stems')
    let scriptError: string | null = null
    let producedStems: string[] | null = null
    await runProcess(
      job,
      venvPython(),
      [
        separateScript(),
        '--input',
        mixWavPath(videoId),
        '--out',
        stemsDir(videoId),
        '--model',
        job.model,
        '--device',
        deviceArg(),
        '--shifts',
        String(settings.shifts),
        ...(stems?.length ? ['--only', stems.join(',')] : [])
      ],
      {
        onLine: (line) => {
          let parsed: Record<string, unknown>
          try {
            parsed = JSON.parse(line)
          } catch {
            return
          }
          if (parsed.type === 'progress') {
            progress(
              job,
              'separate',
              Number(parsed.pct ?? 0),
              typeof parsed.message === 'string' ? parsed.message : undefined
            )
          } else if (parsed.type === 'error') {
            scriptError = `Separation failed: ${String(parsed.message)}`
          } else if (parsed.type === 'done' && Array.isArray(parsed.stems)) {
            producedStems = (parsed.stems as unknown[]).map(String)
          }
        }
      }
    )
    if (job.cancelled || !jobs.has(videoId)) return
    if (scriptError) bail(scriptError)

    const finalStems: string[] = producedStems ?? []
    if (!stemsPresent(videoId, finalStems)) bail('Separation finished but stem files are missing')

    if (finalStems.includes('vocals')) {
      progress(job, 'finalize', 40, 'Transcribing synchronized karaoke lyrics…')
      try {
        await transcribeLyrics(videoId, 'large-v3-turbo')
      } catch (err) {
        console.warn(`Auto lyric transcription error for ${videoId} (non-fatal):`, err)
      }
    }
    if (job.cancelled || !jobs.has(videoId)) return

    progress(job, 'finalize', 100, 'Adding to library')
    const took = Math.round((Date.now() - startedAt) / 1000)
    const songs = upsertSong({
      videoId,
      title: meta!.title,
      duration: meta!.duration,
      addedAt: existing?.addedAt ?? Date.now(),
      model: job.model,
      stems: finalStems,
      took
    })
    send({ kind: 'done', data: { videoId, song: songs[0] } })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message !== 'cancelled') {
      send({ kind: 'failed', data: { videoId, message } })
    }
  } finally {
    jobs.delete(videoId)
    currentRunningJob = null
    processNextInQueue()
  }
}

function processNextInQueue(): void {
  if (currentRunningJob !== null || queue.length === 0) return
  const nextItem = queue.shift()
  if (!nextItem) return

  const nextJob = jobs.get(nextItem.videoId)
  if (!nextJob || nextJob.cancelled) {
    processNextInQueue()
    return
  }

  updateQueuePositions()
  void executeJob(nextJob, nextItem.url, nextItem.stems)
}

export async function startJob(
  rawUrl: string,
  model = MODEL_EXTENDED,
  stems?: string[],
  force = false
): Promise<void> {
  const url = rawUrl.trim()
  const videoId = parseVideoId(url)
  if (!videoId) {
    send({ kind: 'failed', data: { videoId: '', message: 'Could not parse a YouTube URL or video id out of that' } })
    return
  }
  if (jobs.has(videoId)) {
    send({ kind: 'failed', data: { videoId, message: 'This song is already being processed or queued' } })
    return
  }

  const existing = loadSongs().find((s) => s.videoId === videoId)
  const covered =
    !force &&
    existing &&
    existing.model === model &&
    !!existing.stems?.length &&
    (stems?.length ? stems.every((s) => existing.stems!.includes(s)) : true)
  if (covered && stemsPresent(videoId, stemsFor(existing))) {
    send({ kind: 'done', data: { videoId, song: existing } })
    return
  }

  const job: ActiveJob = { videoId, model, cancelled: false, title: existing?.title }
  jobs.set(videoId, job)

  if (currentRunningJob !== null) {
    queue.push({ url, videoId, model, stems, force })
    progress(job, 'metadata', 0, `In queue (position #${queue.length})`)
    return
  }

  void executeJob(job, url, stems)
}

export async function reprocessTrack(
  videoId: string,
  model = MODEL_EXTENDED,
  stems?: string[]
): Promise<void> {
  const existing = loadSongs().find((s) => s.videoId === videoId)
  if (!existing || !existsSync(mixWavPath(videoId))) {
    send({ kind: 'failed', data: { videoId, message: 'Track mix file not found' } })
    return
  }

  // Cancel any existing job for this videoId
  cancelJob(videoId)

  const job: ActiveJob = { videoId, model, cancelled: false, title: existing.title }
  jobs.set(videoId, job)

  if (currentRunningJob !== null) {
    queue.push({ url: '', videoId, model, stems, force: true })
    progress(job, 'metadata', 0, `In queue (position #${queue.length})`)
    return
  }

  void executeJob(job, '', stems)
}

function runProcess(
  job: ActiveJob,
  cmd: string,
  args: string[],
  opts: { onStdout?: (chunk: string) => void; onLine?: (line: string) => void } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (job.cancelled || !jobs.has(job.videoId)) return reject(new Error('cancelled'))
    const child = spawn(cmd, args, { env: { ...process.env } })
    job.proc = child

    let stdoutTail = ''
    let stderrTail = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdoutTail = (stdoutTail + text).slice(-2000)
      opts.onStdout?.(text)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    if (opts.onLine && child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => opts.onLine?.(line))
    }

    child.on('error', reject)
    child.on('close', (code) => {
      if (job.cancelled || !jobs.has(job.videoId)) return reject(new Error('cancelled'))
      if (code === 0) return resolve()
      const detail =
        stderrTail.split('\n').filter(Boolean).slice(-2).join(' — ') ||
        stdoutTail.split('\n').filter(Boolean).slice(-1).join('')
      reject(
        new Error(
          detail
            ? `${cmd.split('/').pop()} exited (${code}): ${detail}`
            : `${cmd.split('/').pop()} exited with code ${code}`
        )
      )
    })
  })
}

export async function searchYouTube(query: string): Promise<
  Array<{ videoId: string; title: string; channel?: string; duration?: number }>
> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const results = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      venvYtDlp(),
      [
        ...ytDlpRuntimeArgs(),
        '--no-warnings',
        '-J',
        '--flat-playlist',
        '--no-playlist',
        `ytsearch15:${trimmed}`
      ],
      { env: { ...process.env } }
    )
    let out = ''
    let err = ''
    child.stdout?.on('data', (c: Buffer) => {
      out += c.toString()
    })
    child.stderr?.on('data', (c: Buffer) => {
      err = (err + c.toString()).slice(-1000)
    })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      reject(new Error('Search timed out'))
    }, 30000)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(err.split('\n').filter(Boolean).slice(-1).join('') || `search exited ${code}`))
    })
  })

  try {
    const data = JSON.parse(results)
    const entries = Array.isArray(data.entries) ? data.entries : []
    const mapped = entries
      .filter((e: Record<string, unknown>) => typeof e.id === 'string' && typeof e.title === 'string')
      .map((e: Record<string, unknown>) => ({
        videoId: e.id as string,
        title: e.title as string,
        channel:
          typeof e.uploader === 'string'
            ? e.uploader
            : typeof e.channel === 'string'
              ? e.channel
              : undefined,
        duration: typeof e.duration === 'number' ? Math.round(e.duration) : undefined
      }))
    return mapped
  } catch {
    return []
  }
}

function killTree(proc: ChildProcess): void {
  if (!proc.pid) return
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'])
    } catch {}
  } else {
    try {
      proc.kill('SIGKILL')
    } catch {}
  }
}

export function cancelJob(videoId?: string): void {
  if (videoId) {
    // Check if in queue
    const qIndex = queue.findIndex((q) => q.videoId === videoId)
    if (qIndex >= 0) {
      queue.splice(qIndex, 1)
      jobs.delete(videoId)
      updateQueuePositions()
      send({ kind: 'failed', data: { videoId, message: 'Cancelled' } })
      return
    }

    // Check if current running job
    const job = jobs.get(videoId)
    if (job) {
      job.cancelled = true
      if (job.proc) killTree(job.proc)
      jobs.delete(job.videoId)
      rmSync(songDir(job.videoId), { recursive: true, force: true })
      send({ kind: 'failed', data: { videoId: job.videoId, message: 'Cancelled' } })
      if (currentRunningJob?.videoId === videoId) {
        currentRunningJob = null
        processNextInQueue()
      }
    }
  } else {
    // Cancel all
    queue.length = 0
    for (const job of jobs.values()) {
      job.cancelled = true
      if (job.proc) killTree(job.proc)
      rmSync(songDir(job.videoId), { recursive: true, force: true })
      send({ kind: 'failed', data: { videoId: job.videoId, message: 'Cancelled' } })
    }
    jobs.clear()
    currentRunningJob = null
  }
}

export function isBusy(): boolean {
  return jobs.size > 0
}

const activeTranscriptions = new Map<string, Promise<KaraokeData>>()

export function sendLyricsProgress(videoId: string, pct: number, message?: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lyrics:progress', { videoId, pct, message })
  }
}

export async function transcribeLyrics(
  videoId: string,
  model = 'large-v3-turbo',
  force = false
): Promise<KaraokeData> {
  const existing = loadLyrics(videoId)
  if (existing && !force) {
    return existing
  }

  const existingInFlight = activeTranscriptions.get(videoId)
  if (existingInFlight) {
    return existingInFlight
  }

  const vocalPath = join(stemsDir(videoId), 'vocals.wav')
  if (!existsSync(vocalPath)) {
    throw new Error('Vocals stem not found. Please split the stems for this song first.')
  }

  const outPath = lyricsPath(videoId)
  const settings = loadSettings()
  const useGpu = settings.gpuSplit && process.platform === 'win32'
  const deviceArg = process.platform === 'win32' ? (useGpu ? 'cuda' : 'cpu') : 'auto'

  const task = new Promise<KaraokeData>((resolve, reject) => {
    sendLyricsProgress(videoId, 0, 'Starting vocal transcription…')

    const child = spawn(
      venvPython(),
      [
        transcribeScript(),
        '--input',
        vocalPath,
        '--out',
        outPath,
        '--model',
        model,
        '--device',
        deviceArg
      ],
      { env: { ...process.env } }
    )

    let scriptError: string | null = null

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        try {
          const parsed = JSON.parse(line)
          if (parsed.type === 'progress') {
            sendLyricsProgress(videoId, Number(parsed.pct ?? 0), parsed.message)
          } else if (parsed.type === 'error') {
            scriptError = String(parsed.message)
          }
        } catch {}
      })
    }

    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000)
    })

    child.on('error', (err) => {
      activeTranscriptions.delete(videoId)
      reject(err)
    })

    child.on('close', (code) => {
      activeTranscriptions.delete(videoId)
      if (code === 0) {
        const loaded = loadLyrics(videoId)
        if (loaded) {
          sendLyricsProgress(videoId, 100, 'Lyrics ready')
          return resolve(loaded)
        }
        return reject(new Error('Transcription finished but lyrics file was not created.'))
      }
      reject(
        new Error(
          scriptError || `Transcription failed with exit code ${code}: ${stderrTail.slice(0, 300)}`
        )
      )
    })
  })

  activeTranscriptions.set(videoId, task)
  return task
}

const activeTabTranscriptions = new Map<string, Promise<GuitarTabData>>()

export function sendTabProgress(
  videoId: string,
  pct: number,
  message?: string,
  instrument: 'guitar' | 'bass' = 'guitar'
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('tab:progress', { videoId, pct, message, instrument })
  }
}

export async function transcribeGuitarTab(
  videoId: string,
  tuning = 'standard',
  position = 'auto',
  sensitivity = 'clean',
  mode = 'chord',
  voicing = 'standard',
  force = false,
  instrument: 'guitar' | 'bass' = 'guitar'
): Promise<GuitarTabData> {
  const existing = loadTabs(videoId, instrument)
  if (existing && !force) {
    return existing
  }

  const flightKey = `${videoId}_${instrument}`
  const existingInFlight = activeTabTranscriptions.get(flightKey)
  if (existingInFlight) {
    return existingInFlight
  }

  const stemFilename = instrument === 'bass' ? 'bass.wav' : 'guitar.wav'
  const audioPath = join(stemsDir(videoId), stemFilename)
  if (!existsSync(audioPath)) {
    throw new Error(
      `${instrument === 'bass' ? 'Bass' : 'Guitar'} stem not found. Please reprocess this song with the ${instrument} stem selected.`
    )
  }

  const outPath = tabPath(videoId, instrument)
  const settings = loadSettings()
  const useGpu = settings.gpuSplit && process.platform === 'win32'
  const deviceArg = process.platform === 'win32' ? (useGpu ? 'cuda' : 'cpu') : 'auto'

  const task = (async () => {
    const instLabel = instrument === 'bass' ? 'bass' : 'guitar'
    sendTabProgress(videoId, 0, `Checking ${instLabel} tab engine dependencies…`, instrument)
    await ensureTabEngineDeps()

    return new Promise<GuitarTabData>((resolve, reject) => {
      sendTabProgress(videoId, 5, `Starting ${instLabel} transcription…`, instrument)

      const child = spawn(
        venvPython(),
        [
          tabScript(),
          '--input',
          audioPath,
          '--out',
          outPath,
          '--instrument',
          instrument,
          '--mode',
          instrument === 'bass' ? 'note' : mode,
          '--voicing',
          voicing,
          '--tuning',
          tuning,
          '--position',
          position,
          '--sensitivity',
          sensitivity,
          '--device',
          deviceArg
        ],
        { env: { ...process.env } }
      )

      let scriptError: string | null = null

      if (child.stdout) {
        const rl = createInterface({ input: child.stdout })
        rl.on('line', (line) => {
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === 'progress') {
              sendTabProgress(videoId, Number(parsed.pct ?? 0), parsed.message, instrument)
            } else if (parsed.type === 'error') {
              scriptError = String(parsed.message)
            }
          } catch {}
        })
      }

      let stderrTail = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-2000)
      })

      child.on('error', (err) => {
        activeTabTranscriptions.delete(flightKey)
        reject(err)
      })

      child.on('close', (code) => {
        activeTabTranscriptions.delete(flightKey)
        if (code === 0) {
          const loaded = loadTabs(videoId, instrument)
          if (loaded) {
            sendTabProgress(
              videoId,
              100,
              `${instrument === 'bass' ? 'Bass' : 'Guitar'} tablature ready`,
              instrument
            )
            return resolve(loaded)
          }
          return reject(new Error('Transcription finished but tabs file was not created.'))
        }
        reject(
          new Error(
            scriptError || `Tab transcription failed with exit code ${code}: ${stderrTail.slice(0, 300)}`
          )
        )
      })
    })
  })()

  activeTabTranscriptions.set(flightKey, task)
  return task
}

