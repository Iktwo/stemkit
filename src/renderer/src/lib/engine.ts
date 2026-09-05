import type { StemId } from '../../../shared/types'

export type BufferMap = Partial<Record<StemId, AudioBuffer>>

/**
 * Fast-path direct WAV PCM / IEEE-float decoder.
 * Bypasses Web Audio decodeAudioData worker thread IPC, format detection, and detachment,
 * allowing instant synchronous/microtask population of AudioBuffers.
 */
function decodeWavFast(raw: Uint8Array, ctx: AudioContext): AudioBuffer | null {
  if (raw.byteLength < 44) return null
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  // 'RIFF' = 0x52494646, 'WAVE' = 0x57415645
  if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
    return null
  }

  let offset = 12
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null
  let dataOffset = 0
  let dataLength = 0

  while (offset + 8 <= raw.byteLength) {
    const chunkId = view.getUint32(offset, false)
    const chunkSize = view.getUint32(offset + 4, true)
    offset += 8

    if (chunkId === 0x666d7420) {
      // 'fmt '
      fmt = {
        format: view.getUint16(offset, true),
        channels: view.getUint16(offset + 2, true),
        sampleRate: view.getUint32(offset + 4, true),
        bitsPerSample: view.getUint16(offset + 14, true)
      }
    } else if (chunkId === 0x64617461) {
      // 'data'
      dataOffset = offset
      dataLength = chunkSize
      break
    }
    offset += chunkSize
  }

  if (!fmt || !dataOffset || dataOffset + dataLength > raw.byteLength) return null

  const channels = fmt.channels
  const sampleRate = fmt.sampleRate

  const byteOffset = raw.byteOffset + dataOffset

  // Case 1: 32-bit float stereo (standard BS-RoFormer output)
  if (fmt.format === 3 && fmt.bitsPerSample === 32 && channels === 2) {
    if (byteOffset % 4 !== 0) return null
    const numFrames = Math.floor(dataLength / 8)
    const floatView = new Float32Array(raw.buffer, byteOffset, numFrames * 2)
    const audioBuf = ctx.createBuffer(2, numFrames, sampleRate)
    const left = audioBuf.getChannelData(0)
    const right = audioBuf.getChannelData(1)
    for (let i = 0, j = 0; i < numFrames; i++, j += 2) {
      left[i] = floatView[j]
      right[i] = floatView[j + 1]
    }
    return audioBuf
  }

  // Case 2: 32-bit float mono
  if (fmt.format === 3 && fmt.bitsPerSample === 32 && channels === 1) {
    if (byteOffset % 4 !== 0) return null
    const numFrames = Math.floor(dataLength / 4)
    const floatView = new Float32Array(raw.buffer, byteOffset, numFrames)
    const audioBuf = ctx.createBuffer(1, numFrames, sampleRate)
    audioBuf.getChannelData(0).set(floatView)
    return audioBuf
  }

  // Case 3: 16-bit PCM stereo
  if (fmt.format === 1 && fmt.bitsPerSample === 16 && channels === 2) {
    if (byteOffset % 2 !== 0) return null
    const numFrames = Math.floor(dataLength / 4)
    const intView = new Int16Array(raw.buffer, byteOffset, numFrames * 2)
    const audioBuf = ctx.createBuffer(2, numFrames, sampleRate)
    const left = audioBuf.getChannelData(0)
    const right = audioBuf.getChannelData(1)
    for (let i = 0, j = 0; i < numFrames; i++, j += 2) {
      left[i] = intView[j] / 32768.0
      right[i] = intView[j + 1] / 32768.0
    }
    return audioBuf
  }

  // Case 4: 16-bit PCM mono
  if (fmt.format === 1 && fmt.bitsPerSample === 16 && channels === 1) {
    if (byteOffset % 2 !== 0) return null
    const numFrames = Math.floor(dataLength / 2)
    const intView = new Int16Array(raw.buffer, byteOffset, numFrames)
    const audioBuf = ctx.createBuffer(1, numFrames, sampleRate)
    const ch = audioBuf.getChannelData(0)
    for (let i = 0; i < numFrames; i++) {
      ch[i] = intView[i] / 32768.0
    }
    return audioBuf
  }

  return null
}

export async function decodePayload(
  payload: Record<string, Uint8Array>
): Promise<BufferMap> {
  const ctx = engine.ensureCtx()
  if (ctx.state === 'suspended') {
    void ctx.resume()
  }
  const ids = Object.keys(payload) as StemId[]
  const out: BufferMap = {}

  // Decode all stems concurrently
  await Promise.all(
    ids.map(async (id) => {
      const raw = payload[id]
      if (!raw || raw.byteLength === 0) return

      // Fast path: direct WAV PCM / IEEE-float parsing (~20ms per stem)
      try {
        const direct = decodeWavFast(raw, ctx)
        if (direct) {
          out[id] = direct
          return
        }
      } catch (err) {
        console.warn(`Fast WAV decode failed for ${id}, using fallback:`, err)
      }

      // Fallback path: standard Web Audio decodeAudioData
      const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
      try {
        out[id] = await ctx.decodeAudioData(ab)
      } catch (err) {
        console.error(`Failed to decode stem ${id}:`, err)
      }
    })
  )

  return out
}

export class StemEngine {
  private ctx: AudioContext | null = null
  private buffers: BufferMap = {}
  private gains: Partial<Record<StemId, GainNode>> = {}
  private master: GainNode | null = null
  private sources: AudioBufferSourceNode[] = []
  private playing = false
  private anchorYt = 0
  private anchorCtx = 0
  rate = 1

  ensureCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = 0.9
      this.master.connect(this.ctx.destination)
    }
    return this.ctx
  }

  private getGain(id: StemId): GainNode {
    const ctx = this.ensureCtx()
    let g = this.gains[id]
    if (!g) {
      g = ctx.createGain()
      g.connect(this.master!)
      this.gains[id] = g
    }
    return g
  }

  resume(): void {
    void this.ensureCtx().resume()
  }

  async decode(payload: Record<string, Uint8Array>): Promise<void> {
    const buffers = await decodePayload(payload)
    this.buffers = buffers
  }

  setBuffers(buffers: BufferMap): void {
    this.stopAll()
    this.buffers = buffers
  }

  /** Add or replace one lane without interrupting playback (used for synth lanes). */
  addBuffer(id: StemId, buffer: AudioBuffer): void {
    this.buffers = { ...this.buffers, [id]: buffer }
    if (this.playing) this.align(this.expected())
  }

  removeBuffer(id: StemId): void {
    const { [id]: _drop, ...rest } = this.buffers
    this.buffers = rest
    const gain = this.gains[id]
    if (gain) {
      try {
        gain.disconnect()
      } catch {}
      delete this.gains[id]
    }
    if (this.playing) this.align(this.expected())
  }

  /** Playback speed. Pitch follows (tape-style); re-anchors so the clock stays exact. */
  setRate(rate: number): void {
    const next = Math.min(2, Math.max(0.25, rate))
    if (next === this.rate) return
    const pos = this.expected()
    this.rate = next
    if (this.playing) this.align(pos)
    else this.anchorYt = pos
  }

  hasBuffers(): boolean {
    return Object.keys(this.buffers).length > 0
  }

  isPlaying(): boolean {
    return this.playing
  }

  setPlaying(playing: boolean, time: number): void {
    if (playing) this.resume()
    this.playing = playing
    this.align(time)
  }

  align(time: number): void {
    this.stopSources()
    this.anchorYt = time
    if (!this.ctx || !this.playing || !this.hasBuffers()) return
    const ctx = this.ctx
    const startAt = ctx.currentTime + 0.04
    for (const id of Object.keys(this.buffers) as StemId[]) {
      const buf = this.buffers[id]
      if (!buf) continue
      const gain = this.getGain(id)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.playbackRate.value = this.rate
      src.connect(gain)
      src.start(startAt, Math.min(Math.max(0, time), Math.max(0, buf.duration - 0.01)))
      this.sources.push(src)
    }
    this.anchorCtx = startAt
  }

  expected(): number {
    if (!this.ctx || !this.playing) return this.anchorYt
    return this.anchorYt + (this.ctx.currentTime - this.anchorCtx) * this.rate
  }

  trackDuration(): number {
    let d = 0
    for (const buf of Object.values(this.buffers)) {
      if (buf && buf.duration > d) d = buf.duration
    }
    return d
  }

  applyMix(
    vols: Partial<Record<StemId, number>>,
    mutes: Set<StemId>,
    solos: Set<StemId>,
    masterVol: number
  ): void {
    if (!this.ctx) return
    const now = this.ctx.currentTime
    for (const id of Object.keys(vols) as StemId[]) {
      const audible = !mutes.has(id) && (solos.size === 0 || solos.has(id))
      this.getGain(id).gain.setTargetAtTime(audible ? vols[id] ?? 1 : 0, now, 0.012)
    }
    this.master?.gain.setTargetAtTime(masterVol, now, 0.012)
  }

  stopAll(): void {
    this.playing = false
    this.stopSources()
  }

  private stopSources(): void {
    for (const s of this.sources) {
      try {
        s.stop()
      } catch {}
      try {
        s.disconnect()
      } catch {}
    }
    this.sources = []
  }
}

export const engine = new StemEngine()
