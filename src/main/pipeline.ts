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
import { parseVideoId } from '../shared/url'

interface ActiveJob {
  videoId: string
  title?: string
  proc?: ChildProcess
  cancelled: boolean
}

let current: ActiveJob | null = null

function send(ev: JobEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('job:event', ev)
  }
}

function progress(
  videoId: string,
  stage: JobStage,
  pct: number,
  message?: string,
  model?: string
): void {
  if (!current || current.videoId !== videoId) return
  send({ kind: 'progress', data: { videoId, stage, pct, message, title: current.title, model } })
}

function fail(message: string): never {
  const videoId = current?.videoId ?? 'unknown'
  const err = new Error(message)
  ;(err as NodeJS.ErrnoException & { videoId?: string }).videoId = videoId
  throw err
}

export function extractVideoId(url: string): string {
  const id = parseVideoId(url)
  if (!id) fail('Could not parse a YouTube URL or video id out of that')
  return id as string
}

function spawnEnv(): NodeJS.ProcessEnv {
  return { ...process.env }
}

function runProcess(
  cmd: string,
  args: string[],
  opts: { onStdout?: (chunk: string) => void; onLine?: (line: string) => void } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!current) return reject(new Error('cancelled'))
    if (current.cancelled) return reject(new Error('cancelled'))
    const child = spawn(cmd, args, { env: spawnEnv() })
    current.proc = child

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
      if (!current || current.cancelled) return reject(new Error('cancelled'))
      if (code === 0) return resolve()
      const detail =
        stderrTail.split('\n').filter(Boolean).slice(-2).join(' — ') ||
        stdoutTail.split('\n').filter(Boolean).slice(-1).join('')
      reject(new Error(detail ? `${cmd.split('/').pop()} exited (${code}): ${detail}` : `exited with code ${code}`))
    })
  })
}

async function fetchMetadata(url: string): Promise<{ title: string; duration: number }> {
  let raw = ''
  await runProcess(venvYtDlp(), [...ytDlpRuntimeArgs(), '-J', '--no-playlist', '--skip-download', url], {
    onStdout: (chunk) => {
      raw += chunk
    }
  })
  try {
    const meta = JSON.parse(raw)
    return {
      title: typeof meta.title === 'string' ? meta.title : 'Unknown title',
      duration: typeof meta.duration === 'number' ? Math.round(meta.duration) : 0
    }
  } catch {
    fail('Could not read video metadata')
  }
}

export async function startJob(rawUrl: string, model = 'htdemucs'): Promise<void> {
  if (current) fail('A job is already running')

  const url = rawUrl.trim()
  const videoId = extractVideoId(url)

  const existing = loadSongs().find((s) => s.videoId === videoId)
  if (existing && existing.model === model && stemsPresent(videoId, stemsFor(existing))) {
    send({ kind: 'done', data: { videoId, song: existing } })
    return
  }
  if (existing && existing.model !== model) {
    rmSync(songDir(videoId), { recursive: true, force: true })
  }

  current = { videoId, cancelled: false }

  try {
    mkdirSync(songDir(videoId), { recursive: true })
    progress(videoId, 'metadata', 0, 'Reading video info', model)

    const meta = await fetchMetadata(url)
    if (!current || current.videoId !== videoId) return
    current.title = meta.title
    progress(videoId, 'metadata', 100, meta.title, model)

    progress(videoId, 'download', 0, 'Downloading audio from YouTube', model)
    let maxPct = 0
    await runProcess(
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
                progress(videoId, 'download', pct, undefined, model)
              }
            }
          }
        }
      }
    )
    if (!current || current.cancelled) return

    const dir = songDir(videoId)
    const rawFile = readdirSync(dir).find((f) => f.startsWith('raw.'))
    if (!rawFile) fail('Download produced no file')
    const rawPath = join(dir, rawFile as string)

    progress(videoId, 'convert', 0, 'Converting to WAV')
    const ffmpeg = getStatus().ffmpeg.path
    if (!ffmpeg) fail('ffmpeg not found — install it with: brew install ffmpeg')
    await runProcess(ffmpeg, [
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
    progress(videoId, 'convert', 100, undefined, model)

    mkdirSync(stemsDir(videoId), { recursive: true })
    progress(
      videoId,
      'separate',
      0,
      model === 'htdemucs_6s'
        ? 'Separating 6 stems incl. piano & guitar'
        : 'Separating stems (first run also downloads the model)',
      model
    )
    let scriptError: string | null = null
    let producedStems: string[] | null = null
    await runProcess(
      venvPython(),
      [
        separateScript(),
        '--input',
        mixWavPath(videoId),
        '--out',
        stemsDir(videoId),
        '--model',
        model,
        '--device',
        'auto'
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
              videoId,
              'separate',
              Number(parsed.pct ?? 0),
              typeof parsed.message === 'string' ? parsed.message : undefined,
              model
            )
          } else if (parsed.type === 'error') {
            scriptError = `Separation failed: ${String(parsed.message)}`
          } else if (parsed.type === 'done' && Array.isArray(parsed.stems)) {
            producedStems = (parsed.stems as unknown[]).map(String)
          }
        }
      }
    )
    if (!current || current.cancelled) return
    if (scriptError) fail(scriptError)

    const finalStems = producedStems ?? []
    if (!stemsPresent(videoId, finalStems)) fail('Separation finished but stem files are missing')

    progress(videoId, 'finalize', 100, 'Adding to library', model)
    const songs = upsertSong({
      videoId,
      title: meta.title,
      duration: meta.duration,
      addedAt: existing?.addedAt ?? Date.now(),
      model,
      stems: finalStems
    })
    send({ kind: 'done', data: { videoId, song: songs[0] } })
  } catch (err) {
    const message =
      err instanceof Error ? err.message : String(err)
    if (message === 'cancelled') {
      rmSync(songDir(videoId), { recursive: true, force: true })
    } else {
      send({ kind: 'failed', data: { videoId, message } })
    }
  } finally {
    current = null
  }
}

export function cancelJob(): void {
  if (!current) return
  current.cancelled = true
  try {
    current.proc?.kill('SIGKILL')
  } catch {}
  const id = current.videoId
  current = null
  rmSync(songDir(id), { recursive: true, force: true })
  send({ kind: 'failed', data: { videoId: id, message: 'Cancelled' } })
}

export function isBusy(): boolean {
  return current !== null
}
