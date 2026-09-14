import { spawn, execFile } from 'child_process'
import { existsSync, writeFileSync, readFileSync, readdirSync, createWriteStream, mkdirSync, chmodSync, unlinkSync, statSync, renameSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app, BrowserWindow, net } from 'electron'
import type { EngineStatus } from '../shared/types'

export interface ToolInfo {
  found: boolean
  path?: string
  version?: string
}

export interface EnvState {
  python: ToolInfo
  ffmpeg: ToolInfo
  jsRuntime?: { kind: 'deno' | 'node'; path: string }
  ready: boolean
  bootstrapping: boolean
  updating: boolean
}

const state: EnvState = {
  python: { found: false },
  ffmpeg: { found: false },
  ready: false,
  bootstrapping: false,
  updating: false
}

export function userDataDir(): string {
  return app.getPath('userData')
}

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''
const VENV_BIN = IS_WIN ? 'Scripts' : 'bin'

/* CUDA torch (the GPU engine swap) works on windows and linux; macOS stays
   on MPS/CPU via the default torch build */
const SUPPORTS_GPU = IS_WIN || process.platform === 'linux'

export function venvDir(): string {
  return join(userDataDir(), 'venv')
}

export function venvPython(): string {
  return join(venvDir(), VENV_BIN, 'python' + EXE)
}

export function venvYtDlp(): string {
  return join(venvDir(), VENV_BIN, 'yt-dlp' + EXE)
}

/* standalone python runtime (python-build-standalone), fetched on demand
   so end users never need python installed */
const PBS_TAG = '20241002'
const PBS_VERSION = '3.11.10'

function runtimeDir(): string {
  return join(userDataDir(), 'python-runtime')
}

function runtimePython(): string {
  return IS_WIN
    ? join(runtimeDir(), 'python', 'python.exe')
    : join(runtimeDir(), 'python', 'bin', 'python3')
}

function runtimeTriple(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (IS_WIN) return `${arch}-pc-windows-msvc-shared`
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  return `${arch}-unknown-linux-gnu`
}

function runtimeArchivePath(): string {
  return join(userDataDir(), `cpython-${PBS_VERSION}-${runtimeTriple()}-install_only.tar.gz`)
}

function runtimeDownloadUrl(): string {
  return (
    `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/` +
    `cpython-${PBS_VERSION}%2B${PBS_TAG}-${runtimeTriple()}-install_only.tar.gz`
  )
}

function ffmpegExtraDir(): string {
  if (IS_WIN) return 'ffmpeg-win'
  if (process.platform === 'darwin') return 'ffmpeg-mac'
  return 'ffmpeg-linux'
}

export function bundledFfmpeg(): string | null {
  const name = 'ffmpeg' + EXE
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'ffmpeg', name)]
    : [join(app.getAppPath(), 'extras', ffmpegExtraDir(), name)]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

export function separateScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python', 'separate.py')
  }
  return join(app.getAppPath(), 'python', 'separate.py')
}

export function roformerScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python', 'roformer.py')
  }
  return join(app.getAppPath(), 'python', 'roformer.py')
}

export function transcribeScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python', 'transcribe.py')
  }
  return join(app.getAppPath(), 'python', 'transcribe.py')
}

export function tabScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python', 'tab_transcribe.py')
  }
  return join(app.getAppPath(), 'python', 'tab_transcribe.py')
}

export function modelsDir(): string {
  return join(userDataDir(), 'models')
}

const ENGINE_DEPS = ['beartype', 'rotary_embedding_torch', 'einops', 'faster_whisper', 'soundfile']
let engineDepsReady = false

let gpuProbe: Promise<boolean> | null = null
let gpuInfo: boolean | undefined

/* informational only: whether the venv's torch can use a GPU (MPS on Apple
   Silicon, CUDA on NVIDIA). Engine choice no longer depends on this — it is
   surfaced in Settings as "GPU acceleration available — fast" vs "not
   available — CPU, slower" */
export function hasGpuAcceleration(): Promise<boolean> {
  // test hook: simulates a CPU-only machine (the Windows path)
  if (process.env.STEMKIT_FORCE_CPU === '1') {
    gpuInfo = false
    return Promise.resolve(false)
  }
  if (!gpuProbe) {
    gpuProbe = runCapture(
      venvPython(),
      [
        '-c',
        'import torch;print(1 if (torch.cuda.is_available() or torch.backends.mps.is_available()) else 0)'
      ],
      30000
    )
      .then((out) => out.trim().endsWith('1'))
      .catch(() => false)
      .then((gpu) => {
        gpuInfo = gpu
        return gpu
      })
  }
  return gpuProbe
}

export function gpuAccelerationInfo(): boolean | undefined {
  return gpuInfo
}

let nvidiaProbe: Promise<boolean> | null = null
let nvidiaInfo: boolean | undefined

/* windows + linux: whether an NVIDIA GPU is present (nvidia-smi ships with
   the driver). Gates the GPU-acceleration toggle in Settings */
export function detectNvidiaGpu(): Promise<boolean> {
  if (!SUPPORTS_GPU) {
    nvidiaInfo = false
    return Promise.resolve(false)
  }
  if (!nvidiaProbe) {
    nvidiaProbe = runCapture(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader'],
      10000
    )
      .then((out) => {
        nvidiaInfo = /nvidia/i.test(out)
        return nvidiaInfo
      })
      .catch(() => {
        nvidiaInfo = false
        return false
      })
  }
  return nvidiaProbe
}

export function nvidiaGpuInfo(): boolean | undefined {
  return nvidiaInfo
}

/* venvs created before the roformer engine lack a few small packages;
   verify and install them once per session */
export async function ensureEngineDeps(): Promise<boolean> {
  if (engineDepsReady) return true
  try {
    await runCapture(
      venvPython(),
      ['-c', `import ${ENGINE_DEPS.join(', ')}`],
      20000
    )
    engineDepsReady = true
    return true
  } catch {}
  sendEnvEvent('Preparing engine components…')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        venvPython(),
        ['-m', 'pip', 'install', '-q', 'beartype', 'rotary-embedding-torch', 'einops', 'faster-whisper', 'soundfile'],
        { env: { ...process.env } }
      )
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pip install failed (${code})`))
      )
      child.on('error', reject)
    })
    engineDepsReady = true
    sendEnvEvent('Engine components ready', 'success')
    return true
  } catch (err) {
    sendEnvEvent(
      `Engine components failed: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    )
    return false
  }
}

/* tablature engine:
   - basic-pitch (polyphonic guitar) is installed without its declared deps —
     those pull TensorFlow / CoreML which don't build on every platform — and
     runs on onnxruntime instead, which ships wheels for every OS we target
   - torchcrepe (guitar lead f0 tracking) reuses the venv's torch
   - resampy >= 0.4.3 is required: older releases import pkg_resources, which
     modern setuptools no longer provides, and basic-pitch's pin is stale */
const TAB_ENGINE_DEPS = ['basic_pitch', 'onnxruntime', 'pretty_midi', 'scipy', 'resampy', 'librosa', 'torchcrepe']
let tabDepsReady = false

function pipInstall(args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(venvPython(), ['-m', 'pip', 'install', '-q', ...args], { env: { ...process.env } })
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-600)
    })
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`pip install ${args.join(' ')} failed (${code}): ${stderrTail.trim().split('\n').pop() ?? ''}`))
    )
    child.on('error', reject)
  })
}

export async function ensureTabEngineDeps(): Promise<boolean> {
  if (tabDepsReady) return true
  try {
    await runCapture(
      venvPython(),
      ['-c', `import ${TAB_ENGINE_DEPS.join(', ')}`],
      30000
    )
    tabDepsReady = true
    return true
  } catch {}
  sendEnvEvent('Preparing the tablature engine (one-time download)…')
  try {
    await pipInstall([
      'setuptools',
      'resampy>=0.4.3',
      'pretty-midi',
      'scipy',
      'librosa',
      'mir-eval',
      'scikit-learn',
      'typing-extensions',
      'onnxruntime',
      'torchcrepe'
    ])
    await pipInstall(['--no-deps', 'basic-pitch'])
    await runCapture(venvPython(), ['-c', `import ${TAB_ENGINE_DEPS.join(', ')}`], 30000)
    tabDepsReady = true
    sendEnvEvent('Tablature engine ready', 'success')
    return true
  } catch (err) {
    sendEnvEvent(
      `Tablature engine setup failed: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    )
    return false
  }
}

let mt3DepsReady = false

export async function ensureMt3EngineDeps(): Promise<boolean> {
  if (mt3DepsReady) return true
  try {
    await runCapture(venvPython(), ['-c', 'import mt3_infer'], 30000)
    mt3DepsReady = true
    return true
  } catch {}
  sendEnvEvent('Preparing the MR-MT3 Transformer packages (one-time download)…')
  try {
    await pipInstall(['mt3-infer'])
    await runCapture(venvPython(), ['-c', 'import mt3_infer'], 30000)
    mt3DepsReady = true
    sendEnvEvent('MR-MT3 Transformer engine ready', 'success')
    return true
  } catch (err) {
    sendEnvEvent(
      `MR-MT3 Transformer setup failed: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    )
    return false
  }
}

function cleanVersion(version: string): string {
  return String(version).replace(/^v/, '')
}

async function detectJsRuntime(): Promise<void> {
  const denoPaths = IS_WIN
    ? [
        join(homedir(), '.deno', 'bin', 'deno.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'deno', 'deno.exe')
      ]
    : ['/opt/homebrew/bin/deno', '/usr/local/bin/deno', '/usr/bin/deno', join(homedir(), '.deno/bin/deno')]
  for (const p of denoPaths.filter((p): p is string => !!p && p.length > 0)) {
    if (existsSync(p)) {
      state.jsRuntime = { kind: 'deno', path: p }
      return
    }
  }

  const nodeCandidates: string[] = []
  if (IS_WIN) {
    nodeCandidates.push(
      join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
      join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'nodejs', 'node.exe')
    )
    const nvmHome =
      process.env.NVM_HOME ??
      join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'nvm')
    try {
      for (const ver of readdirSync(nvmHome)) {
        const major = parseInt(cleanVersion(ver).split('.')[0], 10)
        if (!Number.isNaN(major) && major >= 18) {
          nodeCandidates.push(join(nvmHome, ver, 'node.exe'))
        }
      }
    } catch {}
  } else {
    nodeCandidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
    const nvmRoot = join(homedir(), '.nvm/versions/node')
    try {
      for (const ver of readdirSync(nvmRoot)) {
        const major = parseInt(cleanVersion(ver).split('.')[0], 10)
        if (!Number.isNaN(major) && major >= 18) {
          nodeCandidates.push(join(nvmRoot, ver, 'bin', 'node'))
        }
      }
    } catch {}
  }

  let best: { path: string; version: string } | null = null
  for (const p of nodeCandidates) {
    try {
      const out = await runCapture(p, ['-v'], 5000)
      const version = cleanVersion(out.trim())
      const major = parseInt(version.split('.')[0], 10)
      if (Number.isNaN(major) || major < 18) continue
      if (!best || cmpVersions(version, best.version) > 0) best = { path: p, version }
    } catch {
      continue
    }
  }
  if (best) state.jsRuntime = { kind: 'node', path: best.path }
}

function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

export function ytDlpRuntimeArgs(): string[] {
  if (!state.jsRuntime) return []
  return ['--js-runtimes', `${state.jsRuntime.kind}:${state.jsRuntime.path}`]
}

function pyCandidates(): string[] {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    return [
      process.env.STEMKIT_PYTHON,
      join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
      join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
      join(localAppData, 'Programs', 'Python', 'Python310', 'python.exe'),
      join(localAppData, 'Programs', 'Python', 'Python39', 'python.exe'),
      join(programFiles, 'Python312', 'python.exe'),
      join(programFiles, 'Python311', 'python.exe'),
      join(programFiles, 'Python310', 'python.exe'),
      join(programFiles, 'Python39', 'python.exe'),
      join(localAppData, 'Microsoft', 'WindowsApps', 'python3.exe'),
      join(localAppData, 'Microsoft', 'WindowsApps', 'python.exe')
    ].filter((p): p is string => !!p)
  }
  const home = homedir()
  return [
    process.env.STEMKIT_PYTHON,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    '/usr/bin/python3.12',
    '/usr/bin/python3.11',
    '/usr/bin/python3.10',
    join(home, 'opt/anaconda3/bin/python3'),
    join(home, 'anaconda3/bin/python3'),
    join(home, 'miniconda3/bin/python3'),
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.10'
  ].filter((p): p is string => !!p)
}

function ffCandidates(): string[] {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return [
      process.env.STEMKIT_FFMPEG,
      join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe')
    ].filter((p): p is string => !!p)
  }
  const home = homedir()
  return [
    process.env.STEMKIT_FFMPEG,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    join(home, 'opt/anaconda3/bin/ffmpeg'),
    join(home, 'anaconda3/bin/ffmpeg'),
    '/usr/bin/ffmpeg'
  ].filter((p): p is string => !!p)
}

function runCapture(cmd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

interface PyProbe {
  path: string
  version: string
  machine: string
}

/* system pythons on Debian/Ubuntu often lack the venv module
   (python3-venv not installed), which only surfaces later as a cryptic
   "ensurepip is not available" failure. Filter them out up front so the
   private runtime is picked instead */
async function canCreateVenv(candidate: string): Promise<boolean> {
  if (candidate === runtimePython()) return true
  try {
    await runCapture(candidate, ['-m', 'venv', '--help'], 10000)
    return true
  } catch {
    return false
  }
}

export async function detectTools(): Promise<void> {
  const probes: PyProbe[] = []
  const candidates: string[] = []
  if (existsSync(runtimePython())) candidates.push(runtimePython())
  // STEMKIT_FORCE_RUNTIME=1 ignores system python so the private-runtime
  // download path can be exercised on machines that have python installed.
  // On Linux the private runtime is preferred anyway: system pythons are
  // commonly missing python3-venv and are PEP 668 externally-managed.
  const preferRuntime = process.platform === 'linux' || process.env.STEMKIT_FORCE_RUNTIME === '1'
  if (!preferRuntime) candidates.push(...pyCandidates())
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const out = await runCapture(candidate, [
        '-c',
        'import sys,platform;print("%d.%d %s"%(*sys.version_info[:2],platform.machine()))'
      ])
      const [version, machine] = out.trim().split(/\s+/)
      const minor = parseInt(version.split('.')[1], 10)
      const major = parseInt(version.split('.')[0], 10)
      if (major === 3 && minor >= 10 && minor <= 12) {
        if (process.platform === 'darwin' && process.arch === 'arm64' && machine !== 'arm64') {
          continue
        }
        if (await canCreateVenv(candidate)) {
          probes.push({ path: candidate, version, machine: machine ?? 'unknown' })
        }
      }
    } catch {
      continue
    }
  }
  // Linux fallback: no usable python yet (no runtime, system lacks venv
  // module) — still probe system pythons so the error path can name one.
  // bootstrap() below will prefer downloading the private runtime.
  if (probes.length === 0 && preferRuntime) {
    for (const candidate of pyCandidates()) {
      if (!existsSync(candidate) || candidates.includes(candidate)) continue
      try {
        const out = await runCapture(candidate, [
          '-c',
          'import sys,platform;print("%d.%d %s"%(*sys.version_info[:2],platform.machine()))'
        ])
        const [version] = out.trim().split(/\s+/)
        const minor = parseInt(version.split('.')[1], 10)
        const major = parseInt(version.split('.')[0], 10)
        if (major > 3 || (major === 3 && minor >= 10 && minor <= 12)) {
          probes.push({ path: candidate, version, machine: 'no-venv-module' })
        }
      } catch {
        continue
      }
    }
  }
  probes.sort((a, b) => {
    const aArm = a.machine === 'arm64' ? 0 : 1
    const bArm = b.machine === 'arm64' ? 0 : 1
    if (aArm !== bArm) return aArm - bArm
    return parseInt(b.version.split('.')[1], 10) - parseInt(a.version.split('.')[1], 10)
  })
  const best = probes[0]
  if (best) {
    state.python = { found: true, path: best.path, version: best.version }
  } else {
    state.python = { found: false }
  }

  const bundled = bundledFfmpeg()
  if (bundled) {
    state.ffmpeg = { found: true, path: bundled }
  } else {
    for (const candidate of ffCandidates()) {
      if (!existsSync(candidate)) continue
      try {
        await runCapture(candidate, ['-version'])
        state.ffmpeg = { found: true, path: candidate }
        break
      } catch {
        continue
      }
    }
  }

  await detectJsRuntime()
}

function sendEnvEvent(
  message: string,
  level: 'info' | 'error' | 'success' = 'info',
  pct?: number,
  detail?: string
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('env:event', { message, level, pct, detail })
  }
}

export async function refreshReady(): Promise<boolean> {
  const marker = join(venvDir(), '.ready')
  if (!existsSync(marker) || !existsSync(venvPython()) || !existsSync(venvYtDlp())) {
    state.ready = false
    return false
  }

  // Fast check: inspect pyvenv.cfg for incompatible python versions (e.g. legacy 3.9)
  try {
    const cfgPath = join(venvDir(), 'pyvenv.cfg')
    if (existsSync(cfgPath)) {
      const cfg = readFileSync(cfgPath, 'utf8')
      const versionMatch = cfg.match(/version\s*=\s*(\d+)\.(\d+)/)
      if (versionMatch) {
        const major = parseInt(versionMatch[1], 10)
        const minor = parseInt(versionMatch[2], 10)
        if (major === 3 && minor < 10) {
          sendEnvEvent('Healing outdated Python environment…')
          rmSync(venvDir(), { recursive: true, force: true })
          state.ready = false
          return false
        }
      }
    }
  } catch {}

  // Test the venv's python actually runs (e.g. dynamic link / architecture mismatch)
  try {
    const out = await runCapture(
      venvPython(),
      ['-c', 'import sys,platform;print("%d.%d %s"%(*sys.version_info[:2],platform.machine()))'],
      10000
    )
    const [version, machine] = out.trim().split(/\s+/)
    const [major, minor] = version.split('.').map((x) => parseInt(x, 10))
    const archOk = !(process.platform === 'darwin' && process.arch === 'arm64' && machine !== 'arm64')
    if (major !== 3 || minor < 10 || minor > 12 || !archOk) {
      sendEnvEvent('Healing outdated Python environment…')
      rmSync(venvDir(), { recursive: true, force: true })
      state.ready = false
      return false
    }
  } catch {
    try { unlinkSync(marker) } catch {}
    state.ready = false
    return false
  }

  state.ready = true
  return true
}

function downloadTo(
  url: string,
  dest: string,
  label: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    // download into <dest>.part so an interrupted fetch can resume and a
    // partial file is never mistaken for the real one; rename on success
    const part = dest + '.part'
    const base = existsSync(part) ? statSync(part).size : 0
    let lastPct = -1
    let lastFine = -1
    const req = net.request({
      url,
      redirect: 'follow',
      ...(base > 0 ? { headers: { Range: `bytes=${base}-` } } : {})
    })
    req.on('response', (res) => {
      if (res.statusCode === 416 && base > 0) {
        // the .part already holds the whole file (killed right before the rename)
        renameSync(part, dest)
        onProgress?.(100)
        resolve()
        return
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        reject(new Error(`${label} download failed (HTTP ${res.statusCode})`))
        return
      }
      const resumed = res.statusCode === 206 && base > 0
      const start = resumed ? base : 0
      const total = start + Number(res.headers['content-length'] ?? 0)
      const out = createWriteStream(part, { flags: resumed ? 'append' : 'w' })
      let done = 0
      // downloads surfaced in the UI (with an onProgress observer) report
      // finer-grained progress than the plain setup-log ones
      const step = onProgress ? 2 : 10
      res.on('data', (chunk: Buffer) => {
        done += chunk.length
        out.write(chunk)
        if (total > 0) {
          const pct = Math.floor(((start + done) / total) * 100)
          const mbDone = ((start + done) / (1024 * 1024)).toFixed(1)
          const mbTotal = (total / (1024 * 1024)).toFixed(1)
          const detail = `${mbDone} / ${mbTotal} MB`
          if (pct >= lastPct + step) {
            lastPct = pct
            sendEnvEvent(`${label}: ${pct}%`, 'info', pct, detail)
          }
          if (onProgress && pct > lastFine) {
            lastFine = pct
            onProgress(pct)
          }
        }
      })
      res.on('end', () =>
        out.end(() => {
          try {
            renameSync(part, dest)
            onProgress?.(100)
            resolve()
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
      )
      res.on('error', (e) => {
        out.close()
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    })
    req.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
    req.end()
  })
}

/* BS-RoFormer SOTA model weights (~700MB). Fetched during first-run setup
   so that the app is 100% offline-ready. If skipped or deleted, separate.py
   will download it on demand with live progress emits. */
export function defaultModelCached(): boolean {
  try {
    const defaultCacheDir = join(
      homedir(),
      '.cache',
      'bs-roformer-infer',
      'roformer-model-bs-roformer-sw-by-jarredou'
    )
    const ckpt = join(defaultCacheDir, 'BS-Rofo-SW-Fixed.ckpt')
    const cfg = join(defaultCacheDir, 'BS-Rofo-SW-Fixed.yaml')
    return existsSync(ckpt) && existsSync(cfg) && statSync(ckpt).size > 600000000
  } catch {
    return false
  }
}

let defaultModelPromise: Promise<boolean> | null = null
const defaultModelListeners = new Set<(pct: number, detail?: string) => void>()

export function ensureDefaultModel(onProgress?: (pct: number, detail?: string) => void): Promise<boolean> {
  if (onProgress) defaultModelListeners.add(onProgress)
  const detach = (): boolean => {
    if (onProgress) defaultModelListeners.delete(onProgress)
    return true
  }

  if (defaultModelCached()) {
    detach()
    return Promise.resolve(true)
  }

  if (!defaultModelPromise) {
    defaultModelPromise = new Promise<boolean>((resolve) => {
      sendEnvEvent('Downloading BS-RoFormer SOTA model (~700MB, one time)', 'info', 0)

      const pyCode = `
import json, sys
try:
    import bs_roformer.download as bsdl
    from bs_roformer import ensure_model_assets, DEFAULT_MODEL
    from bs_roformer.model_registry import MODEL_REGISTRY

    entry = MODEL_REGISTRY.get(DEFAULT_MODEL)
    search_dirs = bsdl.models_search_dirs()
    for base in search_dirs:
        ckpt = base / entry.slug / entry.checkpoint
        cfg = base / entry.slug / entry.config
        if ckpt.exists() and cfg.exists() and ckpt.stat().st_size > 600000000:
            print(json.dumps({"type": "done", "pct": 100}), flush=True)
            sys.exit(0)

    class ProgressTqdm(bsdl.tqdm):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self._last_report = 0.0

        def update(self, n=1):
            super().update(n)
            if self.total:
                import time
                pct = int(min(99, (self.n / self.total) * 100))
                now = time.time()
                if now - self._last_report >= 0.25 or pct == 99:
                    self._last_report = now
                    print(json.dumps({"type": "progress", "pct": pct, "done": self.n, "total": self.total}), flush=True)

    bsdl.tqdm = ProgressTqdm
    ensure_model_assets(DEFAULT_MODEL)
    print(json.dumps({"type": "done", "pct": 100}), flush=True)
except Exception as e:
    print(json.dumps({"type": "error", "error": str(e)}), flush=True)
    sys.exit(1)
`

      const child = spawn(venvPython(), ['-c', pyCode], {
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      })

      let lastPct = 0
      let stderrTail = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split(/[\r\n]+/)) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const ev = JSON.parse(trimmed)
            if (ev.type === 'progress') {
              const pct = Number(ev.pct ?? 0)
              if (pct >= lastPct) {
                lastPct = pct
                const mbDone = ((ev.done ?? 0) / (1024 * 1024)).toFixed(1)
                const mbTotal = ((ev.total ?? 0) / (1024 * 1024)).toFixed(1)
                const detail = `${mbDone} / ${mbTotal} MB`
                sendEnvEvent(`Downloading BS-RoFormer model: ${pct}%`, 'info', pct, detail)
                for (const listener of defaultModelListeners) listener(pct, detail)
              }
            } else if (ev.type === 'done') {
              sendEnvEvent('BS-RoFormer model ready', 'success', 100)
              for (const listener of defaultModelListeners) listener(100, 'Model ready')
            }
          } catch {}
        }
      })

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-1000)
      })

      child.on('close', (code) => {
        if (code === 0) {
          resolve(true)
        } else {
          sendEnvEvent(
            `BS-RoFormer model download deferred (${stderrTail.slice(0, 100).trim() || `code ${code}`}); it will download before first split`,
            'info'
          )
          resolve(false)
        }
      })

      child.on('error', (err) => {
        sendEnvEvent(`BS-RoFormer model download error: ${err.message}`, 'info')
        resolve(false)
      })
    }).finally(() => {
      defaultModelPromise = null
    })
  }

  return defaultModelPromise.then(detach)
}

/* Mel-band roformer vocals checkpoint. Fetched once per machine when the
   "studio-quality vocals" setting is enabled (explicitly, non-default), and
   awaited by the pipeline so a split never races the download. Non-fatal —
   the lazy download inside roformer.py stays as the fallback. Runs on CPU
   too: the toggle deliberately decouples quality from hardware */
const CKPT_NAME = 'MelBandRoformer.ckpt'
const CKPT_URL =
  'https://huggingface.co/KimberleyJSN/melbandroformer/resolve/main/MelBandRoformer.ckpt'

export function vocalsEnginePath(): string {
  return join(modelsDir(), CKPT_NAME)
}

let vocalsEnginePromise: Promise<boolean> | null = null
const vocalsProgressListeners = new Set<(pct: number) => void>()

export function ensureVocalsEngine(onProgress?: (pct: number) => void): Promise<boolean> {
  if (onProgress) vocalsProgressListeners.add(onProgress)
  const detach = (): boolean => {
    if (onProgress) vocalsProgressListeners.delete(onProgress)
    return true
  }
  if (existsSync(vocalsEnginePath())) {
    detach()
    return Promise.resolve(true)
  }
  if (!vocalsEnginePromise) {
    vocalsEnginePromise = (async () => {
      mkdirSync(modelsDir(), { recursive: true })
      sendEnvEvent('Downloading the vocals engine (~913MB, one time)')
      await downloadTo(CKPT_URL, vocalsEnginePath(), 'vocals engine', (pct) => {
        for (const listener of vocalsProgressListeners) listener(pct)
      })
      sendEnvEvent('Vocals engine ready', 'success')
      return true
    })()
      .catch((err) => {
        sendEnvEvent(
          `Vocals engine download failed: ${err instanceof Error ? err.message : String(err)} — it will download before the first split`,
          'error'
        )
        return false
      })
      .finally(() => {
        vocalsEnginePromise = null
      })
  }
  return vocalsEnginePromise.then(detach)
}

/* htdemucs_ft checkpoint (~320MB, fine-tuned demucs). Fetched through the
   venv's torch-hub (get_model) so the cache location and file naming match
   exactly what separate.py expects at separation time. Progress is parsed
   from the downloader's output and reported via env events */
let ftWeightsPromise: Promise<boolean> | null = null
const ftProgressListeners = new Set<(pct: number) => void>()

// htdemucs_ft is a bag of 4 checkpoints (demucs/remote/htdemucs_ft.yaml);
// torch-hub downloads them one after another, each with its own bar
const FT_BAG_COUNT = 4

function torchHubFetch(model: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      venvPython(),
      ['-c', `from demucs.pretrained import get_model; get_model(${JSON.stringify(model)})`],
      { env: { ...process.env } }
    )
    let lastPct = 0
    let filesDone = 0
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1000)
      for (const piece of chunk.toString().split(/[\r\n]/)) {
        const m = piece.match(/(\d{1,3})%/)
        if (!m) continue
        const pct = Math.min(100, parseInt(m[1], 10))
        if (pct < lastPct) {
          // the next checkpoint's bar wrapped — count the previous as done
          filesDone = Math.min(filesDone + 1, FT_BAG_COUNT - 1)
        }
        lastPct = pct
        const overall = Math.min(
          99,
          Math.round(((filesDone + pct / 100) / FT_BAG_COUNT) * 100)
        )
        sendEnvEvent(`fine-tuned engine: ${overall}%`)
        onProgress?.(overall)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onProgress?.(100)
        resolve()
      } else {
        reject(
          new Error(
            stderrTail.split('\n').filter(Boolean).slice(-1).join('') ||
              `fine-tuned engine download exited ${code}`
          )
        )
      }
    })
  })
}

export function ensureFtWeights(onProgress?: (pct: number) => void): Promise<boolean> {
  if (onProgress) ftProgressListeners.add(onProgress)
  const detach = (): boolean => {
    if (onProgress) ftProgressListeners.delete(onProgress)
    return true
  }
  if (!ftWeightsPromise) {
    ftWeightsPromise = (async () => {
      sendEnvEvent('Downloading the fine-tuned engine (~320MB, one time)')
      await torchHubFetch('htdemucs_ft', (pct) => {
        for (const listener of ftProgressListeners) listener(pct)
      })
      sendEnvEvent('Fine-tuned engine ready', 'success')
      return true
    })()
      .catch((err) => {
        sendEnvEvent(
          `Fine-tuned engine download failed: ${err instanceof Error ? err.message : String(err)} — it will download before the next split`,
          'error'
        )
        return false
      })
      .finally(() => {
        ftWeightsPromise = null
      })
  }
  return ftWeightsPromise.then(detach)
}

/* CUDA build of torch (windows/linux + nvidia). The default bootstrap
   installs the CPU wheel from PyPI (on linux pinned to the cpu index, since
   the default linux wheel would otherwise pull CUDA deps for everyone);
   this swaps in the cu121 build (~2.5GB download) on demand when the
   GPU-acceleration toggle is enabled. It stays installed when the toggle
   goes back off — CUDA torch handles cpu devices fine */
const GPU_TORCH_VERSION = '2.5.1'
const GPU_TORCH_INDEX = 'https://download.pytorch.org/whl/cu121'

let gpuEnginePromise: Promise<boolean> | null = null
const gpuProgressListeners = new Set<(pct: number) => void>()

export function ensureGpuEngine(
  onProgress?: (pct: number) => void,
  requireNvidia = false
): Promise<boolean> {
  if (onProgress) gpuProgressListeners.add(onProgress)
  const detach = (): boolean => {
    if (onProgress) gpuProgressListeners.delete(onProgress)
    return true
  }
  if (!SUPPORTS_GPU) {
    detach()
    return Promise.resolve(false)
  }
  if (!gpuEnginePromise) {
    gpuEnginePromise = (async () => {
      // already swapped in: the venv's torch speaks CUDA, nothing to install
      if (await hasGpuAcceleration()) return true
      // the Settings toggle is gated on NVIDIA detection, but a stale setting
      // or a failed nvidia-smi probe could still land here — don't pull
      // ~2.5GB of CUDA torch on a machine that can't use it
      if (requireNvidia && !(await detectNvidiaGpu())) return false
      sendEnvEvent('Downloading the GPU engine (~2.5GB, one time)')
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          venvPython(),
          [
            '-m',
            'pip',
            'install',
            '--progress-bar',
            'on',
            // required: the CPU torch from bootstrap already satisfies the
            // version spec, so without -U pip would no-op and never swap in
            // the cuda build
            '-U',
            '--no-cache-dir',
            `torch==${GPU_TORCH_VERSION}`,
            `torchaudio==${GPU_TORCH_VERSION}`,
            '--index-url',
            GPU_TORCH_INDEX
          ],
          { env: { ...process.env, PYTHONUNBUFFERED: '1' } }
        )
        let lastPct = 0
        let stderrTail = ''
        const handleChunk = (chunk: Buffer): void => {
          for (const piece of chunk.toString().split(/[\r\n]+/)) {
            const trimmed = piece.trim()
            if (!trimmed) continue
            const progress = parsePipProgress(trimmed)
            if (progress && progress.pct > lastPct) {
              lastPct = Math.min(99, progress.pct)
              sendEnvEvent(`GPU engine: ${lastPct}%`, 'info', lastPct, progress.detail)
              for (const listener of gpuProgressListeners) listener(lastPct)
            } else if (/^(Collecting|Downloading|Installing)/i.test(trimmed)) {
              sendEnvEvent(trimmed.slice(0, 200), 'info')
            }
          }
        }
        child.stdout?.on('data', handleChunk)
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-1000)
          handleChunk(chunk)
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) {
            resolve()
            return
          }
          reject(
            new Error(
              stderrTail.split('\n').filter(Boolean).slice(-1).join('') ||
                `GPU engine install exited ${code}`
            )
          )
        })
      })
      // verify the swap actually took effect: torch must report a cuda build
      // (torch.version.cuda is set by the wheel itself, independent of whether
      // an NVIDIA driver/GPU is present on this machine)
      const swapped = await runCapture(
        venvPython(),
        ['-c', 'import torch;print(1 if torch.version.cuda else 0)'],
        30000
      ).catch(() => '0')
      if (!swapped.trim().startsWith('1')) {
        throw new Error('cuda torch is not active after install (torch.version.cuda unset)')
      }
      // refresh the cached cuda probe so Settings' status lines update
      gpuProbe = null
      gpuInfo = undefined
      void hasGpuAcceleration()
      sendEnvEvent('GPU engine ready', 'success', 100)
      return true
    })()
      .catch((err) => {
        sendEnvEvent(
          `GPU engine install failed: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        )
        return false
      })
      .finally(() => {
        gpuEnginePromise = null
      })
  }
  return gpuEnginePromise.then(detach)
}

/* pip progress bars report absolute sizes ("45.2/2450.0 MB") rather than
   percentages; tqdm-style output reports "%" directly */
function parsePipProgress(line: string): { pct: number; detail: string } | null {
  const sizes = line.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB|kB|KB)/i)
  if (sizes) {
    const unit = sizes[3].toUpperCase()
    const scale = unit === 'GB' ? 1024 : unit === 'KB' ? 1 / 1024 : 1
    const done = parseFloat(sizes[1]) * scale
    const total = parseFloat(sizes[2]) * scale
    if (total > 0) {
      const pct = Math.min(100, Math.round((done / total) * 100))
      const speedMatch = line.match(/([\d.]+\s*(?:GB|MB|kB|KB)\/s)/i)
      const etaMatch = line.match(/(\d+:\d+(?::\d+)?)/)
      const parts = [`${sizes[1]} / ${sizes[2]} ${sizes[3]}`]
      if (speedMatch) parts.push(speedMatch[1])
      if (etaMatch) parts.push(`ETA ${etaMatch[1]}`)
      return { pct, detail: parts.join(' · ') }
    }
  }
  const pct = line.match(/(\d{1,3})%/)
  if (pct) {
    const val = parseInt(pct[1], 10)
    if (val >= 0 && val <= 100) return { pct: val, detail: '' }
  }
  return null
}

export function engineStatus(): EngineStatus {
  return {
    gpuDownloading: gpuEnginePromise !== null,
    gpuReady: SUPPORTS_GPU && gpuInfo === true
  }
}

function extractArchive(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(dest, { recursive: true })
    // GNU tar (e.g. Git for Windows) treats "C:\..." as a remote host and dies
    // with "Cannot connect to C: resolve failed". Prefer Windows built-in bsdtar.
    const sys32Tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    const tarBin = IS_WIN && existsSync(sys32Tar) ? sys32Tar : 'tar'
    const child = spawn(tarBin, ['-xzf', archive, '-C', dest], { stdio: 'ignore' })
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`extract failed (${code})`))
    )
    child.on('error', reject)
  })
}

export async function ensureRuntimePython(): Promise<boolean> {
  if (existsSync(runtimePython())) return true
  try {
    const archive = runtimeArchivePath()
    sendEnvEvent('Downloading Python components (~35MB)', 'info', 0)
    await downloadTo(runtimeDownloadUrl(), archive, 'components', (pct) => {
      sendEnvEvent(`Downloading components: ${pct}%`, 'info', pct)
    })
    sendEnvEvent('Unpacking components', 'info', 100, 'Extracting Python runtime')
    await extractArchive(archive, runtimeDir())
    unlinkSync(archive)
    if (!existsSync(runtimePython())) throw new Error('runtime python missing after extract')
    chmodSync(runtimePython(), 0o755)

    const out = await runCapture(runtimePython(), ['-V'], 15000).catch(() => '')
    if (!/Python 3\./.test(out)) throw new Error(`runtime python not runnable (${out.trim()})`)
    return true
  } catch (err) {
    sendEnvEvent(
      `Setup failed: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    )
    try {
      unlinkSync(runtimeArchivePath())
    } catch {}
    return false
  }
}

export async function bootstrap(): Promise<boolean> {
  if (state.bootstrapping) return false

  let validPython = false
  if (state.python.found && state.python.path && existsSync(state.python.path)) {
    try {
      const out = await runCapture(
        state.python.path,
        ['-c', 'import sys,platform;print("%d.%d %s"%(*sys.version_info[:2],platform.machine()))'],
        5000
      )
      const [version, machine] = out.trim().split(/\s+/)
      const [major, minor] = version.split('.').map((x) => parseInt(x, 10))
      const archOk = !(process.platform === 'darwin' && process.arch === 'arm64' && machine !== 'arm64')
      if (major === 3 && minor >= 10 && minor <= 12 && archOk) {
        validPython = true
      }
    } catch {}
  }

  if (!validPython) {
    state.python = { found: false }
    const ok = await ensureRuntimePython()
    if (!ok) {
      sendEnvEvent('No suitable python3 found on this machine', 'error')
      return false
    }
    await detectTools()
    if (!state.python.found || !state.python.path) {
      sendEnvEvent('No suitable python3 found on this machine', 'error')
      return false
    }
  }
  state.bootstrapping = true

  try {
    const venv = venvDir()
    const pip = venvPython()

    sendEnvEvent('Preparing workspace')
    if (existsSync(venv)) {
      try {
        rmSync(venv, { recursive: true, force: true })
      } catch {}
    }
    // On Linux the chosen python may lack the venv module (Debian/Ubuntu
    // split it into the python3-venv apt package) even though the version
    // probe passed. Retry once via the private runtime instead of dying.
    const venvWith = (py: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        let stderr = ''
        const child = spawn(py, ['-m', 'venv', '--clear', venv])
        child.stderr?.on('data', (c: Buffer) => {
          stderr += c.toString()
        })
        child.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  `venv creation failed (${code})${stderr ? `: ${stderr.slice(0, 300).trim()}` : ''}`
                )
              )
        )
        child.on('error', reject)
      })
    try {
      await venvWith(state.python.path as string)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/ensurepip|venv/i.test(msg) && state.python.path !== runtimePython()) {
        sendEnvEvent('System python lacks venv support — downloading private runtime instead')
        state.python = { found: false }
        if (!(await ensureRuntimePython())) return false
        await detectTools()
        if (!state.python.found || !state.python.path) {
          sendEnvEvent('No suitable python3 found on this machine', 'error')
          return false
        }
        try {
          await venvWith(state.python.path as string)
        } catch (err2) {
          sendEnvEvent(err2 instanceof Error ? err2.message : String(err2), 'error')
          return false
        }
      } else {
        if (/ensurepip|venv/i.test(msg) && process.platform === 'linux') {
          sendEnvEvent('venv creation failed: install the venv module (e.g. sudo apt install python3-venv) and retry', 'error')
        } else {
          sendEnvEvent(msg, 'error')
        }
        return false
      }
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(pip, ['-m', 'pip', 'install', '-q', '-U', 'pip', 'wheel', 'setuptools'])
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pip upgrade failed (${code})`))
      )
      child.on('error', reject)
    })

    sendEnvEvent('Preparing workspace tools…', 'info')

    const runPipWithProgress = (args: string[], taskLabel: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(pip, ['-m', 'pip', 'install', '--progress-bar', 'on', ...args], {
          env: { ...process.env, PYTHONUNBUFFERED: '1' }
        })
        let currentPkg = ''
        let lastReportedPct = -1
        let stderrTail = ''

        const handleChunk = (chunk: Buffer): void => {
          for (const piece of chunk.toString().split(/[\r\n]+/)) {
            const trimmed = piece.trim()
            if (!trimmed) continue

            const collectMatch = trimmed.match(/Collecting\s+([a-zA-Z0-9_\-]+)/i)
            const downloadMatch = trimmed.match(/Downloading\s+([a-zA-Z0-9_\-]+?)(?:-|\.whl|\.tar|\.zip|\s)/i)
            if (collectMatch) {
              currentPkg = collectMatch[1]
              sendEnvEvent(`Preparing ${currentPkg}…`, 'info')
              continue
            }
            if (downloadMatch) {
              currentPkg = downloadMatch[1]
            }

            if (/^(Installing collected packages|Installing\s)/i.test(trimmed)) {
              sendEnvEvent('Installing downloaded packages…', 'info', 100, 'Unpacking and installing wheels')
              continue
            }
            if (/^Successfully installed/i.test(trimmed)) {
              sendEnvEvent('Packages installed successfully', 'info', 100)
              continue
            }

            const progress = parsePipProgress(trimmed)
            if (progress) {
              if (progress.pct !== lastReportedPct) {
                lastReportedPct = progress.pct
                const pkgLabel = currentPkg ? ` (${currentPkg})` : ''
                sendEnvEvent(
                  `Downloading ${taskLabel}${pkgLabel}: ${progress.pct}%`,
                  'info',
                  progress.pct,
                  progress.detail
                )
              }
            } else if (
              !trimmed.startsWith('Looking in') &&
              !trimmed.startsWith('Using cached') &&
              !trimmed.startsWith('━━━━━━━━')
            ) {
              if (trimmed.startsWith('ERROR') || trimmed.startsWith('error')) {
                sendEnvEvent(trimmed.slice(0, 200), 'error')
              }
            }
          }
        }

        child.stdout?.on('data', handleChunk)
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-1000)
          handleChunk(chunk)
        })

        child.on('close', (code) => {
          if (code === 0) {
            resolve()
          } else {
            const lastErrLine =
              stderrTail.trim().split('\n').filter((l) => l.trim().length > 0).pop() ?? ''
            reject(
              new Error(
                `${taskLabel} install failed (${code})${
                  lastErrLine ? `: ${lastErrLine.slice(0, 200)}` : ''
                }`
              )
            )
          }
        })
        child.on('error', reject)
      })

    // On linux the default PyPI torch wheel is CUDA-enabled and would pull
    // ~2GB of nvidia deps for every user, GPU or not — install the cpu build
    // in its own step (windows/mac defaults are already CPU, so only linux
    // needs the override) and let the GPU toggle swap in cu121 on demand.
    if (process.platform === 'linux') {
      sendEnvEvent('Downloading PyTorch CPU engine (~800MB)', 'info', 0)
      await runPipWithProgress(
        [
          'torch==2.5.1',
          'torchaudio==2.5.1',
          '--index-url',
          'https://download.pytorch.org/whl/cpu'
        ],
        'PyTorch CPU'
      )
    }

    sendEnvEvent('Downloading separation engine packages (~1.5GB)', 'info', 0)
    await runPipWithProgress(
      [
        'demucs==4.0.1',
        'bs-roformer-infer>=0.1.5',
        'torch>=2.5.1',
        'torchaudio>=2.5.1',
        'numpy<2',
        'beartype',
        'rotary-embedding-torch',
        'einops',
        'yt-dlp',
        'faster-whisper',
        'soundfile'
      ],
      'engine packages'
    )

    sendEnvEvent('Installing YouTube challenge solver…', 'info')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(pip, ['-m', 'pip', 'install', '-q', 'yt-dlp-ejs'])
      let lastErr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          const t = line.trim()
          if (/^(Collecting|Downloading|Installing)/i.test(t)) sendEnvEvent(t.slice(0, 200))
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        lastErr = (lastErr + chunk.toString()).slice(-1000)
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve()
        } else {
          const lastErrLine = lastErr.trim().split('\n').filter((l) => l.trim().length > 0).pop() ?? ''
          reject(new Error(`solver install failed (${code})${lastErrLine ? `: ${lastErrLine.slice(0, 200)}` : ''}`))
        }
      })
      child.on('error', reject)
    })

    sendEnvEvent('Ensuring BS-RoFormer SOTA model is ready (~700MB)…', 'info')
    await ensureDefaultModel()

    writeFileSync(join(venv, '.ready'), JSON.stringify({ createdAt: Date.now() }))
    await refreshReady()
    sendEnvEvent('Engine ready', 'success', 100)
    return true
  } catch (err) {
    sendEnvEvent(err instanceof Error ? err.message : String(err), 'error')
    return false
  } finally {
    state.bootstrapping = false
  }
}

export async function updateYtDlp(): Promise<boolean> {
  if (state.updating) return false
  state.updating = true
  try {
    sendEnvEvent('Updating yt-dlp...')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(venvPython(), [
        '-m',
        'pip',
        'install',
        '-q',
        '-U',
        'yt-dlp',
        'yt-dlp-ejs'
      ])
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`code ${code}`))))
      child.on('error', reject)
    })
    sendEnvEvent('yt-dlp updated', 'success')
    return true
  } catch (err) {
    sendEnvEvent(`yt-dlp update failed: ${String(err)}`, 'error')
    return false
  } finally {
    state.updating = false
  }
}

export function getStatus(): EnvState {
  return { ...state }
}
