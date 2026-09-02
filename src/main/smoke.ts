import { spawn } from 'child_process'
import { createInterface } from 'readline'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  bootstrap,
  detectTools,
  getStatus,
  venvPython,
  separateScript,
  roformerScript,
  modelsDir,
  bundledFfmpeg,
  ensureEngineDeps
} from './env'

/* self-test mode, driven by STEMKIT_SMOKE=1 (used by the windows-smoke CI
   job): runs the real bootstrap then separates a generated tone through
   both engines and exits 0/1. No window is created */

const LOG_PATH = join(tmpdir(), 'stemkit-smoke.log')

function log(msg: string): void {
  const line = `[smoke] ${new Date().toISOString()} ${msg}`
  console.log(line)
  try {
    appendFileSync(LOG_PATH, line + '\n')
  } catch {}
}

interface ScriptResult {
  ok: boolean
  stems: string[]
  error?: string
}

function runScript(cmd: string, args: string[]): Promise<ScriptResult> {
  return new Promise((resolve) => {
    log(`run: ${cmd} ${args.join(' ')}`)
    const child = spawn(cmd, args, { env: { ...process.env } })
    let error: string | undefined
    const stems: string[] = []
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let parsed: Record<string, unknown>
      try {
        parsed = JSON.parse(line)
      } catch {
        return
      }
      if (parsed.type === 'progress' && typeof parsed.message === 'string') {
        log(parsed.message)
      } else if (parsed.type === 'error') {
        error = String(parsed.message)
      } else if (parsed.type === 'done' && Array.isArray(parsed.stems)) {
        stems.push(...(parsed.stems as unknown[]).map(String))
      }
    })
    let stderr = ''
    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    child.on('close', (code) => {
      if (code === 0 && stems.length > 0) resolve({ ok: true, stems })
      else
        resolve({
          ok: false,
          stems,
          error:
            error ??
            (stderr ? stderr.slice(-500) : undefined) ??
            `exit code ${code}, no stems reported`
        })
    })
    child.on('error', (e) => resolve({ ok: false, stems, error: String(e) }))
  })
}

function generateMix(dest: string): Promise<void> {
  const ffmpeg = bundledFfmpeg()
  if (!ffmpeg) throw new Error('bundled ffmpeg not found')
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      '-y',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
      '-f', 'lavfi', '-i', 'sine=frequency=554:duration=8',
      '-filter_complex', '[0:a][1:a]join=inputs=2:channel_layout=stereo',
      '-ar', '44100',
      dest
    ], { stdio: 'ignore' })
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg mix generation failed (${code})`))
    )
    child.on('error', reject)
  })
}

/* our float32 WAVs are standard 44-byte headers: format 3 (IEEE float), 32 bits */
function isFloat32Wav(path: string): boolean {
  try {
    const b = readFileSync(path)
    return (
      b.length > 44 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.readUInt16LE(20) === 3 &&
      b.readUInt16LE(34) === 32
    )
  } catch {
    return false
  }
}

export async function runSmoke(): Promise<boolean> {
  try {
    writeFileSync(LOG_PATH, '')
  } catch {}
  log(`starting on ${process.platform} ${process.arch}`)
  try {
    await detectTools()
    const status = getStatus()
    log(`ffmpeg: ${status.ffmpeg.found ? status.ffmpeg.path : 'NOT FOUND'}`)

    log('bootstrap starting (runtime download + venv + pip, ~5 min on a fresh machine)')
    if (!(await bootstrap())) {
      log('FAIL: bootstrap did not complete')
      return false
    }
    log('bootstrap ok')

    const dir = join(modelsDir(), '..', 'smoke')
    mkdirSync(dir, { recursive: true })
    const mix = join(dir, 'mix.wav')
    await generateMix(mix)
    log(`mix generated (${existsSync(mix) ? statSync(mix).size : 0} bytes)`)

    // demucs engine (the CPU fallback path every GPU-less machine takes)
    const demucsOut = join(dir, 'stems-demucs')
    const demucs = await runScript(venvPython(), [
      separateScript(),
      '--input', mix,
      '--out', demucsOut,
      '--model', 'htdemucs',
      '--device', 'auto'
    ])
    if (!demucs.ok) {
      log(`FAIL: demucs separation: ${demucs.error}`)
      return false
    }
    log(`demucs stems: ${demucs.stems.join(', ')}`)
    for (const stem of demucs.stems) {
      const p = join(demucsOut, `${stem}.wav`)
      if (!isFloat32Wav(p)) {
        log(`FAIL: ${stem}.wav missing or not float32`)
        return false
      }
    }

    // roformer engine on CPU: validates the vendored model code, extra pip
    // deps and its own checkpoint downloader on this platform
    if (!(await ensureEngineDeps())) {
      log('FAIL: engine components did not install')
      return false
    }
    const roformerOut = join(dir, 'stems-roformer')
    const roformer = await runScript(venvPython(), [
      roformerScript(),
      '--input', mix,
      '--out', roformerOut,
      '--ckpt-dir', modelsDir(),
      '--device', 'auto'
    ])
    if (!roformer.ok) {
      log(`FAIL: roformer separation: ${roformer.error}`)
      return false
    }
    if (!isFloat32Wav(join(roformerOut, 'vocals.wav'))) {
      log('FAIL: vocals.wav missing or not float32')
      return false
    }
    log('roformer vocals ok')

    log('SMOKE RESULT: PASS')
    return true
  } catch (err) {
    log(`FAIL: ${err instanceof Error ? err.stack : String(err)}`)
    return false
  }
}
