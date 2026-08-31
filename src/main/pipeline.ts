import { spawn, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { readdirSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import {
  venvPython,
  venvYtDlp,
  separateScript,
  getStatus,
  ytDlpRuntimeArgs
} from './env'
import {
  songDir,
  stemsDir,
  stemsPresent,
  stemsFor,
  mixWavPath,
  rawDownloadPath,
  upsertSong,
  loadSongs
} from './library'
import type { JobEvent, JobStage } from '../shared/types'
import { MODEL_FINE, MODEL_EXTENDED } from '../shared/types'
import { parseVideoId } from '../shared/url'

interface ActiveJob {
  videoId: string
  title?: string
  model: string
  cancelled: boolean
  proc?: ChildProcess
}

const jobs = new Map<string, ActiveJob>()

const MAX_CONCURRENT_SEPARATIONS = 2
let activeSeparations = 0
const separationWaiters: Array<() => void> = []

function acquireSeparation(): Promise<() => void> {
  if (activeSeparations < MAX_CONCURRENT_SEPARATIONS) {
    activeSeparations++
    return Promise.resolve(releaseSeparation)
  }
  return new Promise((resolve) => {
    separationWaiters.push(() => {
      activeSeparations++
      resolve(releaseSeparation)
    })
  })
}

function releaseSeparation(): void {
  activeSeparations--
  separationWaiters.shift()?.()
}

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

export async function startJob(
  rawUrl: string,
  requestedModel = 'htdemucs',
  stems?: string[]
): Promise<void> {
  // the fine-tuned model has no piano/guitar sources, fall back to the 6s engine
  const model =
    requestedModel === MODEL_FINE && stems?.some((s) => s === 'guitar' || s === 'piano')
      ? MODEL_EXTENDED
      : requestedModel
  const url = rawUrl.trim()
  const videoId = parseVideoId(url)
  if (!videoId) {
    send({ kind: 'failed', data: { videoId: '', message: 'Could not parse a YouTube URL or video id out of that' } })
    return
  }
  if (jobs.has(videoId)) {
    send({ kind: 'failed', data: { videoId, message: 'This song is already being processed' } })
    return
  }

  const job: ActiveJob = { videoId, model, cancelled: false }
  jobs.set(videoId, job)

  const bail = (message: string): never => {
    throw Object.assign(new Error(message), { videoId })
  }

  try {
    const existing = loadSongs().find((s) => s.videoId === videoId)
    const covered =
      existing &&
      existing.model === model &&
      !!existing.stems?.length &&
      (stems?.length ? stems.every((s) => existing.stems!.includes(s)) : true)
    if (covered && stemsPresent(videoId, stemsFor(existing))) {
      send({ kind: 'done', data: { videoId, song: existing } })
      return
    }
    if (existing && (existing.model !== model || !stemsPresent(videoId, stemsFor(existing)))) {
      rmSync(songDir(videoId), { recursive: true, force: true })
    }

    mkdirSync(songDir(videoId), { recursive: true })
    progress(job, 'metadata', 0, 'Reading video info')

    let raw = ''
    await runProcess(job, venvYtDlp(), [...ytDlpRuntimeArgs(), '-J', '--no-playlist', '--skip-download', url], {
      onStdout: (chunk) => {
        raw += chunk
      }
    })
    let meta: { title: string; duration: number }
    try {
      const parsed = JSON.parse(raw)
      meta = {
        title: typeof parsed.title === 'string' ? parsed.title : 'Unknown title',
        duration: typeof parsed.duration === 'number' ? Math.round(parsed.duration) : 0
      }
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

    mkdirSync(stemsDir(videoId), { recursive: true })
    progress(
      job,
      'separate',
      0,
      job.model === 'htdemucs_6s'
        ? 'Waiting for a free engine slot…'
        : 'Waiting for a free engine slot… (first runs also download models)'
    )

    const release = await acquireSeparation()
    try {
      if (job.cancelled || !jobs.has(videoId)) return
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
          'auto',
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

      const finalStems = producedStems ?? []
      if (!stemsPresent(videoId, finalStems)) bail('Separation finished but stem files are missing')

      progress(job, 'finalize', 100, 'Adding to library')
      const songs = upsertSong({
        videoId,
        title: meta!.title,
        duration: meta!.duration,
        addedAt: existing?.addedAt ?? Date.now(),
        model: job.model,
        stems: finalStems
      })
      send({ kind: 'done', data: { videoId, song: songs[0] } })
    } finally {
      release()
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message !== 'cancelled') {
      send({ kind: 'failed', data: { videoId, message } })
    }
  } finally {
    jobs.delete(videoId)
  }
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
    return entries
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
  const targets = videoId
    ? ([jobs.get(videoId)].filter(Boolean) as ActiveJob[])
    : Array.from(jobs.values())
  for (const job of targets) {
    job.cancelled = true
    killTree(job.proc as ChildProcess)
    jobs.delete(job.videoId)
    rmSync(songDir(job.videoId), { recursive: true, force: true })
    send({ kind: 'failed', data: { videoId: job.videoId, message: 'Cancelled' } })
  }
}

export function isBusy(): boolean {
  return jobs.size > 0
}
