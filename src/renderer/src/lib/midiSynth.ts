import type { TabNote } from '../../../shared/types'
import { engine } from './engine'

export type SynthInstrument =
  | 'acoustic'
  | 'electric'
  | 'nylon'
  | 'synth'
  | 'bass_electric'
  | 'bass_synth'

export interface SynthInstrumentOption {
  id: SynthInstrument
  name: string
  desc: string
}

export const SYNTH_INSTRUMENTS: SynthInstrumentOption[] = [
  { id: 'acoustic', name: 'Acoustic steel', desc: 'Pick attack, wooden body, natural string decay' },
  { id: 'electric', name: 'Electric clean', desc: 'Warm single-coil clean tone' },
  { id: 'nylon', name: 'Classical nylon', desc: 'Round fingerstyle attack' },
  { id: 'synth', name: 'Chiptune lead', desc: 'Square-wave lead for rhythm practice' },
  { id: 'bass_electric', name: 'Electric bass', desc: 'Fingerstyle P-bass with deep fundamental' },
  { id: 'bass_synth', name: 'Synth bass', desc: 'Analog sub with a resonant filter' }
]

export function midiToFreq(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12)
}

// Noise buffer cache (per context) for the pick / finger transient
const noiseBuffers = new WeakMap<BaseAudioContext, AudioBuffer>()
function getNoiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseBuffers.get(ctx)
  if (cached) return cached
  const length = Math.floor(ctx.sampleRate * 0.04)
  const buf = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.008))
  }
  noiseBuffers.set(ctx, buf)
  return buf
}

interface ActiveVoice {
  stop: (when: number) => void
  time: number
}

interface Voice {
  sources: AudioScheduledSourceNode[]
  gain: GainNode
  stopTime: number
}

/**
 * Builds one plucked / synth voice into `destination`. Works on both a live
 * AudioContext (play-along) and an OfflineAudioContext (rendering a whole
 * tab into a mixer lane).
 */
function buildVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  pitch: number,
  startTime: number,
  duration: number,
  velocity: number,
  instrument: SynthInstrument
): Voice | null {
  const freq = midiToFreq(pitch)
  if (!(freq > 0)) return null

  const voiceGain = ctx.createGain()
  voiceGain.connect(destination)

  // lower notes ring longer
  const naturalDecay = Math.max(0.8, 3.2 - (pitch - 40) * 0.04)
  const activeDuration = Math.min(duration * 1.5, naturalDecay)
  const sources: AudioScheduledSourceNode[] = []

  const transient = (cutoff: number, q: number, amount: number, decay: number): void => {
    const noise = ctx.createBufferSource()
    noise.buffer = getNoiseBuffer(ctx)
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(cutoff, startTime)
    filter.Q.setValueAtTime(q, startTime)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(velocity * amount, startTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + decay)
    noise.connect(filter)
    filter.connect(gain)
    gain.connect(voiceGain)
    noise.start(startTime)
    sources.push(noise)
  }

  const osc = (type: OscillatorType, detune = 0, gainValue = 1, target: AudioNode): void => {
    const o = ctx.createOscillator()
    o.type = type
    o.frequency.setValueAtTime(freq, startTime)
    if (detune) o.detune.setValueAtTime(detune, startTime)
    if (gainValue !== 1) {
      const g = ctx.createGain()
      g.gain.setValueAtTime(gainValue, startTime)
      o.connect(g)
      g.connect(target)
    } else {
      o.connect(target)
    }
    o.start(startTime)
    sources.push(o)
  }

  const lowpass = (startCutoff: number, endCutoff: number, q: number, sweep: number): BiquadFilterNode => {
    const f = ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.Q.setValueAtTime(q, startTime)
    f.frequency.setValueAtTime(startCutoff, startTime)
    if (endCutoff !== startCutoff) f.frequency.exponentialRampToValueAtTime(endCutoff, startTime + sweep)
    return f
  }

  if (instrument === 'acoustic') {
    transient(Math.min(3800, freq * 4), 3.0, 0.28, 0.025)
    const filter = lowpass(Math.min(10000, Math.max(1200, freq * 7)), Math.max(350, freq * 1.4), 3.5, 0.18)
    const body = ctx.createBiquadFilter()
    body.type = 'peaking'
    body.frequency.setValueAtTime(240, startTime)
    body.Q.setValueAtTime(1.8, startTime)
    body.gain.setValueAtTime(3.2, startTime)
    osc('triangle', 0, 1, filter)
    osc('sawtooth', 1.8, 0.35, filter)
    filter.connect(body)
    body.connect(voiceGain)
  } else if (instrument === 'electric') {
    const filter = lowpass(Math.min(3800, freq * 3.5), Math.min(3800, freq * 3.5), 2.0, 0)
    osc('sine', 0, 1, filter)
    osc('triangle', -2.2, 0.4, filter)
    filter.connect(voiceGain)
  } else if (instrument === 'nylon') {
    const filter = lowpass(Math.min(2200, freq * 2.5), Math.min(2200, freq * 2.5), 1.2, 0)
    osc('triangle', 0, 1, filter)
    filter.connect(voiceGain)
  } else if (instrument === 'bass_electric') {
    transient(Math.min(1600, freq * 5), 2.0, 0.2, 0.02)
    const filter = lowpass(Math.min(2400, Math.max(700, freq * 6)), Math.max(250, freq * 2.2), 2.5, 0.12)
    const sub = ctx.createBiquadFilter()
    sub.type = 'peaking'
    sub.frequency.setValueAtTime(85, startTime)
    sub.Q.setValueAtTime(1.4, startTime)
    sub.gain.setValueAtTime(4.0, startTime)
    osc('sine', 0, 1, filter)
    osc('triangle', 0, 0.45, filter)
    filter.connect(sub)
    sub.connect(voiceGain)
  } else if (instrument === 'bass_synth') {
    const filter = lowpass(Math.min(1800, freq * 8), Math.max(160, freq * 1.5), 5.0, 0.15)
    osc('sawtooth', 0, 1, filter)
    osc('square', -3.0, 0.5, filter)
    filter.connect(voiceGain)
  } else {
    const filter = lowpass(Math.min(5000, freq * 4), Math.min(5000, freq * 4), 1, 0)
    osc('square', 0, 1, filter)
    filter.connect(voiceGain)
  }

  const baseAmp = velocity * 0.35
  voiceGain.gain.setValueAtTime(0.0001, startTime)
  voiceGain.gain.linearRampToValueAtTime(baseAmp, startTime + 0.0025)
  const stopTime = startTime + activeDuration
  voiceGain.gain.exponentialRampToValueAtTime(0.0005, stopTime)
  for (const s of sources) {
    try {
      s.stop(stopTime + 0.05)
    } catch {}
  }
  return { sources, gain: voiceGain, stopTime }
}

export class MidiTabSynth {
  private masterGain: GainNode | null = null
  private activeVoices: Set<ActiveVoice> = new Set()
  private scheduledNotes = new Set<string>()
  private lastScheduledPos = -1
  private sortedNotes: TabNote[] = []

  public enabled = false
  public volume = 0.8
  public instrument: SynthInstrument = 'acoustic'

  private ensureMaster(ctx: AudioContext): GainNode {
    if (!this.masterGain || this.masterGain.context !== ctx) {
      this.masterGain = ctx.createGain()
      this.masterGain.gain.setValueAtTime(this.volume, ctx.currentTime)
      this.masterGain.connect(ctx.destination)
    }
    return this.masterGain
  }

  public setVolume(vol: number): void {
    this.volume = Math.max(0, Math.min(1, vol))
    if (this.masterGain) {
      const ctx = engine.ensureCtx()
      this.masterGain.gain.setTargetAtTime(this.volume, ctx.currentTime, 0.015)
    }
  }

  public setInstrument(inst: SynthInstrument): void {
    this.instrument = inst
  }

  public setNotes(notes: TabNote[]): void {
    this.sortedNotes = [...notes].sort((a, b) => a.start - b.start)
    this.reset()
  }

  public reset(newPos = 0): void {
    this.stopAllVoices()
    this.scheduledNotes.clear()
    this.lastScheduledPos = newPos
  }

  public stopAllVoices(): void {
    const ctx = engine.ensureCtx()
    const now = ctx.currentTime
    for (const voice of this.activeVoices) {
      try {
        voice.stop(now + 0.02)
      } catch {}
    }
    this.activeVoices.clear()
  }

  /** Schedules notes within a lookahead window during synchronized song playback. */
  public updatePlayback(songPos: number, isPlaying: boolean, rate = 1): void {
    if (!this.enabled || !isPlaying || this.sortedNotes.length === 0) {
      if (!isPlaying && this.activeVoices.size > 0) this.stopAllVoices()
      return
    }
    const ctx = engine.ensureCtx()
    if (ctx.state === 'suspended') void ctx.resume()

    if (this.lastScheduledPos < 0 || Math.abs(songPos - this.lastScheduledPos) > 0.4) {
      this.reset(songPos)
    }

    const LOOKAHEAD = 0.18
    const windowStart = Math.max(0, this.lastScheduledPos)
    const windowEnd = songPos + LOOKAHEAD

    for (const note of this.sortedNotes) {
      if (note.start > windowEnd) break
      if (note.start < windowStart - 0.02) continue
      const key = `${note.pitch}_${note.start.toFixed(3)}_${note.string}`
      if (this.scheduledNotes.has(key)) continue
      this.scheduledNotes.add(key)
      const deltaSec = (note.start - songPos) / rate
      const when = Math.max(ctx.currentTime, ctx.currentTime + deltaSec)
      const dur = Math.max(0.12, (note.end - note.start) / rate)
      const velocity = Math.min(1.2, Math.max(0.3, note.amplitude || 0.8))
      this.triggerVoice(ctx, note.pitch, when, dur, velocity, this.instrument)
    }
    this.lastScheduledPos = windowEnd
    if (this.scheduledNotes.size > 1500) this.scheduledNotes.clear()
  }

  /** Immediately audition a note (clicking a tab note or a fret). */
  public auditionNote(pitch: number, duration = 0.7, velocity = 0.85): void {
    const ctx = engine.ensureCtx()
    if (ctx.state === 'suspended') void ctx.resume()
    this.triggerVoice(ctx, pitch, ctx.currentTime, duration, velocity, this.instrument)
  }

  private triggerVoice(
    ctx: AudioContext,
    pitch: number,
    startTime: number,
    duration: number,
    velocity: number,
    instrument: SynthInstrument
  ): void {
    const voice = buildVoice(ctx, this.ensureMaster(ctx), pitch, startTime, duration, velocity, instrument)
    if (!voice) return
    const teardown = (): void => {
      for (const s of voice.sources) {
        try {
          s.stop()
        } catch {}
        try {
          s.disconnect()
        } catch {}
      }
      try {
        voice.gain.disconnect()
      } catch {}
    }
    const record: ActiveVoice = {
      time: startTime,
      stop: (when: number) => {
        try {
          voice.gain.gain.cancelScheduledValues(when)
          voice.gain.gain.setValueAtTime(voice.gain.gain.value, when)
          voice.gain.gain.linearRampToValueAtTime(0.0001, when + 0.03)
        } catch {}
        setTimeout(teardown, 45)
      }
    }
    this.activeVoices.add(record)
    setTimeout(
      () => {
        this.activeVoices.delete(record)
        teardown()
      },
      Math.max(50, (voice.stopTime - ctx.currentTime + 0.1) * 1000)
    )
  }
}

export const tabSynth = new MidiTabSynth()

/**
 * Render a whole tab with the synth into a stereo AudioBuffer, so it can sit
 * in the mixer as a lane alongside the real stems.
 */
export async function renderNotesToBuffer(
  notes: TabNote[],
  instrument: SynthInstrument,
  durationSec: number,
  sampleRate = 44100
): Promise<AudioBuffer> {
  const length = Math.max(1, Math.ceil(Math.max(0.5, durationSec) * sampleRate))
  const ctx = new OfflineAudioContext(2, length, sampleRate)
  const master = ctx.createGain()
  master.gain.value = 0.9
  // tame the peaks of dense strums
  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -8
  limiter.knee.value = 6
  limiter.ratio.value = 6
  limiter.attack.value = 0.003
  limiter.release.value = 0.12
  master.connect(limiter)
  limiter.connect(ctx.destination)
  for (const n of notes) {
    if (n.start >= durationSec) continue
    const dur = Math.max(0.12, n.end - n.start)
    const velocity = Math.min(1.2, Math.max(0.3, n.amplitude || 0.8))
    buildVoice(ctx, master, n.pitch, Math.max(0, n.start), dur, velocity, instrument)
  }
  return ctx.startRendering()
}

/** 16-bit PCM WAV encoder for exporting a rendered lane. */
export function audioBufferToWav(buffer: AudioBuffer): Uint8Array {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const bytesPerSample = 2
  const blockAlign = channels * bytesPerSample
  const dataSize = frames * blockAlign
  const out = new ArrayBuffer(44 + dataSize)
  const view = new DataView(out)
  const writeStr = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, dataSize, true)
  const chans = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]))
      view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true)
      offset += 2
    }
  }
  return new Uint8Array(out)
}
