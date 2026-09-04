import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { release } from 'os'
import { join } from 'path'
import { app, net } from 'electron'
import { userDataDir } from './env'
import { loadSettings } from './settings'

/* GA4 Measurement Protocol (server-side from the main process — the renderer
   stays CSP-isolated and nothing google ever runs in the app). Fill these in
   to enable reporting: GA4 property Measurement ID + a Measurement Protocol
   API secret (GA Admin → Data streams → stream → Measurement Protocol API
   secrets). Values are baked in at build time via STEMKIT_GA_ID /
   STEMKIT_GA_SECRET (see electron.vite.config.ts), with runtime env vars as a
   fallback. With either value missing, track() is a no-op. */
const MEASUREMENT_ID = __STEMKIT_GA_ID__ || process.env.STEMKIT_GA_ID || ''
const API_SECRET = __STEMKIT_GA_SECRET__ || process.env.STEMKIT_GA_SECRET || ''

const OS_NAMES: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux'
}

let sessionStart = 0
let sessionId: string | null = null
let clientId: string | null = null

function clientFile(): string {
  return join(userDataDir(), 'analytics-client.json')
}

function ensureClientId(): string {
  if (clientId) return clientId
  try {
    const raw = readFileSync(clientFile(), 'utf8')
    const data = JSON.parse(raw)
    if (typeof data.clientId === 'string' && data.clientId) clientId = data.clientId
  } catch {}
  if (!clientId) {
    clientId = randomUUID()
    try {
      mkdirSync(userDataDir(), { recursive: true })
      writeFileSync(clientFile(), JSON.stringify({ clientId }, null, 2))
    } catch {}
  }
  return clientId
}

function ensureSessionId(): string {
  // roll a new session when the app has been idle long enough to count as a
  // new visit (GA's default 30 min timeout)
  if (!sessionId || Date.now() - sessionStart > 30 * 60 * 1000) {
    sessionId = randomUUID()
  }
  sessionStart = Date.now()
  return sessionId
}

export function track(
  name: string,
  params: Record<string, string | number | boolean> = {},
  engagementMs = 100
): void {
  if (!MEASUREMENT_ID || !API_SECRET) return
  if (!app.isReady()) return
  // consent is checked at send time so opting out takes effect immediately
  if (!loadSettings().analytics) return

  const flat: Record<string, string | number> = {
    session_id: ensureSessionId(),
    engagement_time_msec: engagementMs,
    app_version: app.getVersion(),
    os: OS_NAMES[process.platform] ?? process.platform,
    os_version: release(),
    arch: process.arch
  }
  for (const [k, v] of Object.entries(params)) {
    if (k.length > 40) continue
    flat[k] = typeof v === 'boolean' ? (v ? 'true' : 'false') : v
  }

  const body = {
    client_id: ensureClientId(),
    // user properties need a one-time registration in GA (Admin → Custom
    // definitions) before they show up as report dimensions
    user_properties: {
      app_version: { value: app.getVersion() },
      os: { value: OS_NAMES[process.platform] ?? process.platform },
      os_version: { value: release() },
      arch: { value: process.arch }
    },
    events: [{ name: name.slice(0, 40), params: flat }]
  }

  void net
    .fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(MEASUREMENT_ID)}&api_secret=${encodeURIComponent(API_SECRET)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000)
      }
    )
    .catch(() => {})
}

/* engagement beacon: GA infers session length from the timestamps between
   events, which for a desktop app with sparse events reads as ~instant. A
   5-minute heartbeat carrying its own interval as engagement time makes
   session duration and average engagement meaningful (heartbeats also keep
   the session alive for long-running windows). track() no-ops without
   credentials or consent, so the timer is effectively free when disabled. */
const HEARTBEAT_MS = 5 * 60 * 1000
setInterval(() => {
  track('session_heartbeat', {}, HEARTBEAT_MS)
}, HEARTBEAT_MS).unref()

const VALID_NAME = /^[a-z][a-z0-9_]{0,39}$/

// events coming from the renderer go through a strict shape check
export function trackFromRenderer(
  name: unknown,
  params: unknown
): void {
  if (typeof name !== 'string' || !VALID_NAME.test(name)) return
  if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) return
  const flat: Record<string, string | number | boolean> = {}
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') flat[k] = v
  }
  track(name, flat)
}