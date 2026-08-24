const { app, BrowserWindow } = require('electron')
const { createServer } = require('http')
const { createReadStream, existsSync, readFileSync } = require('fs')
const { join, normalize, extname } = require('path')

const ROOT = __dirname
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const server = createServer((req, res) => {
  let p = normalize(join(ROOT, decodeURIComponent((req.url || '/').split('?')[0]) === '/' ? 'index.html' : (req.url || '/').split('?')[0]))
  if (!p.startsWith(ROOT) || !existsSync(p)) p = join(ROOT, 'index.html')
  res.setHeader('Content-Type', MIME[extname(p)] || 'text/html')
  createReadStream(p).pipe(res)
})

app.userAgentFallback = process.env.STRIP_ELECTRON_UA
  ? app.userAgentFallback.replace(/\s?Electron\/[\d.]+\s?/i, '').replace(/\s?StemKit\/[\d.]+\s?/i, '')
  : app.userAgentFallback

app.whenReady().then(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const useLocalhostHost = process.env.HOST_NAME === 'localhost'
  const base = useLocalhostHost ? `http://localhost:${port}` : `http://127.0.0.1:${port}`

  const win = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  win.webContents.on('console-message', (_e, _level, message) => {
    console.log('[renderer]', message)
  })
  await win.loadURL(base + '/index.html?variant=' + (process.env.ORIGIN_PARAM || '0'))
  setTimeout(() => {
    console.log('[harness] done')
    app.quit()
  }, 20000)
})

process.on('exit', () => {
  try { server.close() } catch {}
})
