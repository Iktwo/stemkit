import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron'
import { join, normalize, extname } from 'path'
import { existsSync, copyFileSync, writeFileSync, mkdirSync, createReadStream, statSync } from 'fs'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import type {
  AppSettings,
  KaraokeData,
  GuitarTabData,
  TabInstrument,
  TabTranscribeOptions,
  TabRebuildOptions,
  TabMidiImportOptions
} from '../shared/types'
import {
  detectTools,
  bootstrap,
  updateYtDlp,
  refreshReady,
  ensureVocalsEngine,
  ensureFtWeights,
  ensureGpuEngine,
  detectNvidiaGpu,
  nvidiaGpuInfo,
  hasGpuAcceleration,
  gpuAccelerationInfo,
  engineStatus,
  getStatus
} from './env'
import { loadSettings, saveSettings } from './settings'
import { loadSongs, removeSong, stemBuffers, stemsDir, stemsFor, mixWavPath, loadLyrics, saveLyrics, loadTabs, saveTabs, tabMidiPath } from './library'
import {
  startJob,
  cancelJob,
  searchYouTube,
  transcribeLyrics,
  transcribeGuitarTab,
  rebuildGuitarTab,
  importGuitarTabMidi,
  listMidiTracks
} from './pipeline'
import { initUpdater } from './updater'
import { runSmoke } from './smoke'
import { getThumb } from './thumbs'

let mainWindow: BrowserWindow | null = null
let staticServer: Server | null = null

const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}

function startRendererServer(): Promise<string> {
  const root = normalize(join(__dirname, '../renderer'))
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
        let filePath = normalize(join(root, urlPath === '/' ? 'index.html' : urlPath))
        if (!filePath.startsWith(root)) {
          res.statusCode = 403
          res.end()
          return
        }
        if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
          filePath = join(root, 'index.html')
        }
        res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream')
        createReadStream(filePath).pipe(res)
      } catch {
        res.statusCode = 404
        res.end()
      }
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      staticServer = server
      resolve(`http://localhost:${(server.address() as AddressInfo).port}`)
    })
  })
}

function sanitizeName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|]/g, '-').trim()
  return clean.length > 0 ? clean.slice(0, 120) : 'stems'
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b0b10',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    const url = await startRendererServer()
    mainWindow.loadURL(url + '/index.html')
  }
}

app.whenReady().then(async () => {
  // self-test mode for the windows-smoke CI job: bootstrap, separate a
  // generated tone through both engines, exercise the GPU plumbing
  // (cuda fail-fast paths + CUDA engine install), exit 0/1 without a window
  if (process.env.STEMKIT_SMOKE === '1') {
    const ok = await runSmoke()
    app.exit(ok ? 0 : 1)
    return
  }

  // existing install (e.g. right after an update): pre-fetch the engine
  // checkpoints the user opted into, in the background, so the first split
  // doesn't stall on a download. Nothing is fetched while both toggles are
  // off (the defaults)
  if (await refreshReady()) {
    const settings = loadSettings()
    if (settings.gpuSplit) void ensureGpuEngine(undefined, true)
    // warm the informational GPU probe so Settings can show it right away
    void hasGpuAcceleration()
  }

  ipcMain.handle('env:status', async () => {
    await detectTools()
    void detectNvidiaGpu()
    const status = {
      ...getStatus(),
      gpu: gpuAccelerationInfo(),
      nvidiaGpu: nvidiaGpuInfo()
    }
    // the probe results land on a later status call; never blocks ready
    if (status.ready) void hasGpuAcceleration()
    return status
  })

  ipcMain.handle('env:bootstrap', async () => {
    const ok = await bootstrap()
    return ok
  })

  ipcMain.handle('env:update-ytdlp', async () => updateYtDlp())

  ipcMain.handle('library:list', () => loadSongs())
  ipcMain.handle('library:delete', (_e, videoId: string) => removeSong(videoId))
  ipcMain.handle('song:buffers', (_e, videoId: string) => {
    const song = loadSongs().find((s) => s.videoId === videoId)
    return stemBuffers(videoId, song?.stems)
  })

  ipcMain.handle('jobs:start', async (_e, url: string, model?: string, stems?: string[], force?: boolean) => {
    void startJob(url, model, stems, force)
    return { started: true }
  })
  ipcMain.handle('jobs:cancel', (_e, videoId?: string) => cancelJob(videoId))

  ipcMain.handle('stem:export', async (_e, videoId: string, stem: string) => {
    const song = loadSongs().find((s) => s.videoId === videoId)
    const file = join(stemsDir(videoId), `${stem}.wav`)
    if (!existsSync(file)) throw new Error(`Missing stem ${stem}`)
    const result = await dialog.showSaveDialog({
      title: `Export ${stem}`,
      defaultPath: join(app.getPath('downloads'), `${sanitizeName(song?.title ?? videoId)} - ${stem}.wav`),
      filters: [{ name: 'WAV audio', extensions: ['wav'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    copyFileSync(file, result.filePath)
    return { saved: true, path: result.filePath }
  })

  ipcMain.handle('stems:export-all', async (_e, videoId: string) => {
    const song = loadSongs().find((s) => s.videoId === videoId)
    const list = stemsFor(song)
    const dir = stemsDir(videoId)
    for (const name of list) {
      if (!existsSync(join(dir, `${name}.wav`))) throw new Error(`Missing stem ${name}`)
    }
    const result = await dialog.showOpenDialog({
      title: 'Choose export folder',
      buttonLabel: 'Export Here',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { saved: false }
    const target = join(result.filePaths[0], sanitizeName(song?.title ?? videoId))
    mkdirSync(target, { recursive: true })
    for (const name of list) {
      copyFileSync(join(dir, `${name}.wav`), join(target, `${name}.wav`))
    }
    let count = list.length
    const mix = mixWavPath(videoId)
    if (existsSync(mix)) {
      copyFileSync(mix, join(target, `${sanitizeName(song?.title ?? 'full track')}.wav`))
      count += 1
    }
    return { saved: true, path: target, count }
  })

  ipcMain.handle('search:youtube', (_e, query: string) => searchYouTube(query))
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<AppSettings>) => {
    return saveSettings(patch)
  })
  ipcMain.handle('thumb:get', (_e, videoId: string) => getThumb(videoId))
  // the renderer confirms optional-engine downloads explicitly; nothing
  // starts as a side effect of flipping a toggle
  ipcMain.handle('engines:status', () => {
    // warm the cuda probe so gpuReady flips without waiting for a split
    if (getStatus().ready) void hasGpuAcceleration()
    return engineStatus()
  })
  ipcMain.handle('engines:fetch', (_e, which: 'vocals' | 'ft' | 'gpu') => {
    if (which === 'vocals') void ensureVocalsEngine()
    else if (which === 'ft') void ensureFtWeights()
    else void ensureGpuEngine()
  })
  ipcMain.handle('lyrics:get', (_e, videoId: string) => loadLyrics(videoId))
  ipcMain.handle('lyrics:transcribe', (_e, videoId: string, model?: string) => transcribeLyrics(videoId, model, true))
  ipcMain.handle('lyrics:save', (_e, videoId: string, data: KaraokeData) => {
    saveLyrics(videoId, data)
    return true
  })
  ipcMain.handle('tab:get', (_e, videoId: string, instrument?: TabInstrument) =>
    loadTabs(videoId, instrument ?? 'guitar')
  )
  ipcMain.handle('tab:transcribe', (_e, videoId: string, opts: TabTranscribeOptions) =>
    transcribeGuitarTab(videoId, { ...opts, instrument: opts?.instrument ?? 'guitar' })
  )
  ipcMain.handle('tab:rebuild', (_e, videoId: string, instrument: TabInstrument, opts: TabRebuildOptions) =>
    rebuildGuitarTab(videoId, instrument ?? 'guitar', opts ?? {})
  )
  ipcMain.handle('tab:pickMidi', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import MIDI file',
      properties: ['openFile'],
      filters: [{ name: 'MIDI', extensions: ['mid', 'midi'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    return listMidiTracks(result.filePaths[0])
  })
  ipcMain.handle('tab:importMidi', (_e, videoId: string, opts: TabMidiImportOptions) =>
    importGuitarTabMidi(videoId, { ...opts, instrument: opts?.instrument ?? 'guitar' })
  )
  ipcMain.handle(
    'tab:save',
    (_e, videoId: string, data: GuitarTabData, instrument?: TabInstrument) => {
      saveTabs(videoId, data, instrument ?? 'guitar')
      return true
    }
  )
  ipcMain.handle(
    'tab:exportSynth',
    async (_e, videoId: string, instrument: TabInstrument, wav: Uint8Array) => {
      const song = loadSongs().find((s) => s.videoId === videoId)
      const baseName = sanitizeName(song?.title ?? `${instrument}-synth`)
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: `Export ${instrument === 'bass' ? 'Bass' : 'Guitar'} synth track`,
        defaultPath: join(app.getPath('downloads'), `${baseName} - ${instrument} synth.wav`),
        filters: [{ name: 'WAV audio', extensions: ['wav'] }]
      })
      if (canceled || !filePath) return { saved: false }
      writeFileSync(filePath, Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength))
      return { saved: true, path: filePath }
    }
  )
  ipcMain.handle(
    'tab:exportMidi',
    async (_e, videoId: string, instrument?: TabInstrument) => {
      const inst = instrument ?? 'guitar'
      const midiFile = tabMidiPath(videoId, inst)
      if (!existsSync(midiFile)) {
        throw new Error(`MIDI file not found for this ${inst} tab.`)
      }
      const song = loadSongs().find((s) => s.videoId === videoId)
      const baseName = sanitizeName(song?.title ?? `${inst}-tab`)
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: `Export ${inst === 'bass' ? 'Bass' : 'Guitar'} Tab MIDI`,
        defaultPath: `${baseName}-${inst}-tab.mid`,
        filters: [{ name: 'MIDI File', extensions: ['mid'] }]
      })
      if (canceled || !filePath) return { saved: false }
      copyFileSync(midiFile, filePath)
      return { saved: true, path: filePath }
    }
  )
  ipcMain.handle(
    'tab:exportAscii',
    async (_e, videoId: string, instrument?: TabInstrument) => {
      const inst = instrument ?? 'guitar'
      const data = loadTabs(videoId, inst)
      if (!data?.asciiTab) {
        throw new Error(`Tablature not found for this ${inst} track.`)
      }
      const song = loadSongs().find((s) => s.videoId === videoId)
      const baseName = sanitizeName(song?.title ?? `${inst}-tab`)
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: `Export ASCII ${inst === 'bass' ? 'Bass' : 'Guitar'} Tab`,
        defaultPath: `${baseName}-${inst}-tab.txt`,
        filters: [{ name: 'Text Tablature', extensions: ['txt'] }]
      })
      if (canceled || !filePath) return { saved: false }
      writeFileSync(filePath, data.asciiTab, 'utf8')
      return { saved: true, path: filePath }
    }
  )
  initUpdater()
  ipcMain.handle('open-external', (_e, url: string) => {
    if (/^https:\/\/(www\.)?(youtube\.com|youtu\.be)\//.test(url)) {
      shell.openExternal(url)
    }
  })

  await detectTools()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  cancelJob()
  staticServer?.close()
  app.quit()
})
