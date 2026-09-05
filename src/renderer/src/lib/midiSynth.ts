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
  {
    id: 'acoustic',
    name: 'Acoustic Steel Pluck',
    desc: 'Crisp pick attack with warm wooden resonance & natural string decay'
  },
  {
    id: 'electric',
    name: 'Electric Clean',
    desc: 'Warm jazz & single-coil clean tone with smooth harmonic sustain'
  },
  {
    id: 'nylon',
    name: 'Classical Nylon',
    desc: 'Mellow round fingerstyle attack with organic wooden body'
  },
  {
    id: 'synth',
    name: 'Chiptune / Lead',
    desc: 'Crisp retro synth lead for precision melody & rhythm practice'
  },
  {
    id: 'bass_electric',
    name: 'Electric Bass (P-Bass)',
    desc: 'Punchy fingerstyle electric bass with deep low-end fundamental'
  },
  {
    id: 'bass_synth',
    name: 'Synth Bass (Moog Sub)',
    desc: 'Heavy analog sub-bass with rich harmonic punch'
  }
]

export function midiToFreq(pitch: number): number {
  return 440 * Math.pow(2, (pitch - 69) / 12)
}

// Noise buffer cache for realistic pick transient
let noiseBuffer: AudioBuffer | null = null
function getNoiseBuffer(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === ctx.sampleRate) {
    return noiseBuffer
  }
  const length = Math.floor(ctx.sampleRate * 0.04) // 40ms noise
  const buf = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < length; i++) {
    // Pink-ish weighted white noise
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.008))
  }
  noiseBuffer = buf
  return buf
}

interface ActiveVoice {
  stop: (when: number) => void
  time: number
}

export class MidiTabSynth {
  private masterGain: GainNode | null = null
  private activeVoices: Set<ActiveVoice> = new Set()
  private scheduledNotes = new Set<string>() // note signature -> scheduled
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

  /**
   * Schedules notes within a lookahead window during synchronized song playback.
   */
  public updatePlayback(songPos: number, isPlaying: boolean, rate = 1): void {
    if (!this.enabled || !isPlaying || this.sortedNotes.length === 0) {
      if (!isPlaying && this.activeVoices.size > 0) {
        this.stopAllVoices()
      }
      return
    }

    const ctx = engine.ensureCtx()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }

    // If playback jumped backwards or forwards by more than 0.3s, reset scheduler
    if (this.lastScheduledPos < 0 || Math.abs(songPos - this.lastScheduledPos) > 0.4) {
      this.reset(songPos)
    }

    const LOOKAHEAD = 0.18 // 180ms lookahead
    const windowStart = Math.max(0, this.lastScheduledPos)
    const windowEnd = songPos + LOOKAHEAD

    // Find notes in the window
    for (const note of this.sortedNotes) {
      if (note.start > windowEnd) break
      if (note.start < windowStart - 0.02) continue

      const noteKey = `${note.pitch}_${note.start.toFixed(3)}_${note.string}`
      if (this.scheduledNotes.has(noteKey)) continue

      this.scheduledNotes.add(noteKey)

      // Time relative to now in AudioContext seconds
      const deltaSec = (note.start - songPos) / rate
      const targetCtxTime = Math.max(ctx.currentTime, ctx.currentTime + deltaSec)
      const noteDuration = Math.max(0.12, (note.end - note.start) / rate)
      const velocity = Math.min(1.2, Math.max(0.3, note.amplitude || 0.8))

      this.triggerVoice(ctx, note.pitch, targetCtxTime, noteDuration, velocity, this.instrument)
    }

    this.lastScheduledPos = windowEnd

    // Housekeep scheduledNotes set to prevent memory growth
    if (this.scheduledNotes.size > 1500) {
      this.scheduledNotes.clear()
    }
  }

  /**
   * Immediately audition a note (e.g. clicking a tab note or fret).
   */
  public auditionNote(pitch: number, duration = 0.7, velocity = 0.85): void {
    const ctx = engine.ensureCtx()
    if (ctx.state === 'suspended') {
      void ctx.resume()
    }
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
    const master = this.ensureMaster(ctx)
    const freq = midiToFreq(pitch)
    if (freq <= 0 || isNaN(freq)) return

    const voiceGain = ctx.createGain()
    voiceGain.connect(master)

    // Voice envelope configuration based on pitch
    // Lower strings ring longer, high strings ring shorter
    const naturalDecay = Math.max(0.8, 3.2 - (pitch - 40) * 0.04)
    const activeDuration = Math.min(duration * 1.5, naturalDecay)

    const oscillators: OscillatorNode[] = []
    let noiseSource: AudioBufferSourceNode | null = null

    if (instrument === 'acoustic') {
      // Acoustic Guitar Pluck:
      // 1. Transient pick click (filtered noise burst)
      const noise = ctx.createBufferSource()
      noise.buffer = getNoiseBuffer(ctx)
      const noiseFilter = ctx.createBiquadFilter()
      noiseFilter.type = 'bandpass'
      noiseFilter.frequency.setValueAtTime(Math.min(3800, freq * 4), startTime)
      noiseFilter.Q.setValueAtTime(3.0, startTime)

      const noiseGain = ctx.createGain()
      noiseGain.gain.setValueAtTime(velocity * 0.28, startTime)
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.025)

      noise.connect(noiseFilter)
      noiseFilter.connect(noiseGain)
      noiseGain.connect(voiceGain)
      noise.start(startTime)
      noiseSource = noise

      // 2. Harmonic body: Triangle (fundamental) + Sawtooth (rich overtones)
      const osc1 = ctx.createOscillator()
      osc1.type = 'triangle'
      osc1.frequency.setValueAtTime(freq, startTime)

      const osc2 = ctx.createOscillator()
      osc2.type = 'sawtooth'
      osc2.frequency.setValueAtTime(freq, startTime)
      osc2.detune.setValueAtTime(1.8, startTime) // slight natural string chorus

      const osc2Gain = ctx.createGain()
      osc2Gain.gain.setValueAtTime(0.35, startTime)

      // 3. Dynamic Low-Pass Filter: Bright at attack, fast damping of high overtones
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.Q.setValueAtTime(3.5, startTime)
      const startCutoff = Math.min(10000, Math.max(1200, freq * 7))
      const endCutoff = Math.max(350, freq * 1.4)
      filter.frequency.setValueAtTime(startCutoff, startTime)
      filter.frequency.exponentialRampToValueAtTime(endCutoff, startTime + 0.18)

      // 4. Acoustic Body Cavity Resonator (240Hz wooden box bump)
      const bodyFilter = ctx.createBiquadFilter()
      bodyFilter.type = 'peaking'
      bodyFilter.frequency.setValueAtTime(240, startTime)
      bodyFilter.Q.setValueAtTime(1.8, startTime)
      bodyFilter.gain.setValueAtTime(3.2, startTime)

      osc1.connect(filter)
      osc2.connect(osc2Gain)
      osc2Gain.connect(filter)
      filter.connect(bodyFilter)
      bodyFilter.connect(voiceGain)

      osc1.start(startTime)
      osc2.start(startTime)
      oscillators.push(osc1, osc2)
    } else if (instrument === 'electric') {
      // Clean Electric Tone:
      const osc1 = ctx.createOscillator()
      osc1.type = 'sine'
      osc1.frequency.setValueAtTime(freq, startTime)

      const osc2 = ctx.createOscillator()
      osc2.type = 'triangle'
      osc2.frequency.setValueAtTime(freq, startTime)
      osc2.detune.setValueAtTime(-2.2, startTime)

      const osc2Gain = ctx.createGain()
      osc2Gain.gain.setValueAtTime(0.4, startTime)

      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(Math.min(3800, freq * 3.5), startTime)
      filter.Q.setValueAtTime(2.0, startTime)

      osc1.connect(filter)
      osc2.connect(osc2Gain)
      osc2Gain.connect(filter)
      filter.connect(voiceGain)

      osc1.start(startTime)
      osc2.start(startTime)
      oscillators.push(osc1, osc2)
    } else if (instrument === 'nylon') {
      // Classical Nylon Tone:
      const osc = ctx.createOscillator()
      osc.type = 'triangle'
      osc.frequency.setValueAtTime(freq, startTime)

      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(Math.min(2200, freq * 2.5), startTime)
      filter.Q.setValueAtTime(1.2, startTime)

      osc.connect(filter)
      filter.connect(voiceGain)
      osc.start(startTime)
      oscillators.push(osc)
    } else if (instrument === 'bass_electric') {
      // Electric Bass (P-Bass style finger pluck):
      // 1. Soft finger transient
      const noise = ctx.createBufferSource()
      noise.buffer = getNoiseBuffer(ctx)
      const noiseFilter = ctx.createBiquadFilter()
      noiseFilter.type = 'bandpass'
      noiseFilter.frequency.setValueAtTime(Math.min(1600, freq * 5), startTime)
      noiseFilter.Q.setValueAtTime(2.0, startTime)

      const noiseGain = ctx.createGain()
      noiseGain.gain.setValueAtTime(velocity * 0.2, startTime)
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, startTime + 0.02)

      noise.connect(noiseFilter)
      noiseFilter.connect(noiseGain)
      noiseGain.connect(voiceGain)
      noise.start(startTime)
      noiseSource = noise

      // 2. Fundamental sine + warm triangle overtone
      const osc1 = ctx.createOscillator()
      osc1.type = 'sine'
      osc1.frequency.setValueAtTime(freq, startTime)

      const osc2 = ctx.createOscillator()
      osc2.type = 'triangle'
      osc2.frequency.setValueAtTime(freq, startTime)

      const osc2Gain = ctx.createGain()
      osc2Gain.gain.setValueAtTime(0.45, startTime)

      // 3. Lowpass filter with punchy attack
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.Q.setValueAtTime(2.5, startTime)
      const startCutoff = Math.min(2400, Math.max(700, freq * 6))
      const endCutoff = Math.max(250, freq * 2.2)
      filter.frequency.setValueAtTime(startCutoff, startTime)
      filter.frequency.exponentialRampToValueAtTime(endCutoff, startTime + 0.12)

      // 4. Sub-bass / punch resonance boost at 85Hz
      const subBoost = ctx.createBiquadFilter()
      subBoost.type = 'peaking'
      subBoost.frequency.setValueAtTime(85, startTime)
      subBoost.Q.setValueAtTime(1.4, startTime)
      subBoost.gain.setValueAtTime(4.0, startTime)

      osc1.connect(filter)
      osc2.connect(osc2Gain)
      osc2Gain.connect(filter)
      filter.connect(subBoost)
      subBoost.connect(voiceGain)

      osc1.start(startTime)
      osc2.start(startTime)
      oscillators.push(osc1, osc2)
    } else if (instrument === 'bass_synth') {
      // Synth Bass (Analog Moog-style sub):
      const osc1 = ctx.createOscillator()
      osc1.type = 'sawtooth'
      osc1.frequency.setValueAtTime(freq, startTime)

      const osc2 = ctx.createOscillator()
      osc2.type = 'square'
      osc2.frequency.setValueAtTime(freq, startTime)
      osc2.detune.setValueAtTime(-3.0, startTime)

      const osc2Gain = ctx.createGain()
      osc2Gain.gain.setValueAtTime(0.5, startTime)

      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.Q.setValueAtTime(5.0, startTime)
      filter.frequency.setValueAtTime(Math.min(1800, freq * 8), startTime)
      filter.frequency.exponentialRampToValueAtTime(Math.max(160, freq * 1.5), startTime + 0.15)

      osc1.connect(filter)
      osc2.connect(osc2Gain)
      osc2Gain.connect(filter)
      filter.connect(voiceGain)

      osc1.start(startTime)
      osc2.start(startTime)
      oscillators.push(osc1, osc2)
    } else {
      // Chiptune / Synth:
      const osc = ctx.createOscillator()
      osc.type = 'square'
      osc.frequency.setValueAtTime(freq, startTime)

      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.setValueAtTime(Math.min(5000, freq * 4), startTime)

      osc.connect(filter)
      filter.connect(voiceGain)
      osc.start(startTime)
      oscillators.push(osc)
    }

    // Main Amplitude Envelope
    const baseAmp = velocity * 0.35
    voiceGain.gain.setValueAtTime(0.0001, startTime)
    // Quick 2.5ms attack to avoid audio pop
    voiceGain.gain.linearRampToValueAtTime(baseAmp, startTime + 0.0025)

    // Exponential decay down to quiet ring
    const stopTime = startTime + activeDuration
    voiceGain.gain.exponentialRampToValueAtTime(0.0005, stopTime)

    // Schedule stop
    const voiceRecord: ActiveVoice = {
      time: startTime,
      stop: (when: number) => {
        try {
          voiceGain.gain.cancelScheduledValues(when)
          voiceGain.gain.setValueAtTime(voiceGain.gain.value, when)
          voiceGain.gain.linearRampToValueAtTime(0.0001, when + 0.03)
          setTimeout(() => {
            for (const o of oscillators) {
              try {
                o.stop()
                o.disconnect()
              } catch {}
            }
            if (noiseSource) {
              try {
                noiseSource.stop()
                noiseSource.disconnect()
              } catch {}
            }
            voiceGain.disconnect()
          }, 45)
        } catch {}
      }
    }

    this.activeVoices.add(voiceRecord)

    // Auto-cleanup on finish
    setTimeout(
      () => {
        this.activeVoices.delete(voiceRecord)
        for (const o of oscillators) {
          try {
            o.stop()
            o.disconnect()
          } catch {}
        }
        if (noiseSource) {
          try {
            noiseSource.stop()
            noiseSource.disconnect()
          } catch {}
        }
        try {
          voiceGain.disconnect()
        } catch {}
      },
      Math.max(50, (stopTime - ctx.currentTime + 0.06) * 1000)
    )
  }
}

export const tabSynth = new MidiTabSynth()
