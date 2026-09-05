"""
StemKit tablature engine.

Turns an isolated guitar / bass stem (or a MIDI file) into playable tablature:

  * beat grid   - tracked on the full mix (drums make this robust), so bars
                  never drift the way a single fixed BPM does
  * lead notes  - monophonic f0 tracking (CREPE on GPU/CPU, pYIN fallback)
                  + onset detection + legato segmentation. Used for bass and
                  single-note guitar lines; far more reliable in the low
                  register than a general polyphonic model
  * poly notes  - Spotify Basic Pitch (ONNX runtime) refined with the f0
                  track (octave-error repair) and a harmonic ghost filter
  * chords      - beat-synchronous chroma + Viterbi chord decoding, strummed
                  at the onsets that are actually in the audio
  * fingering   - Viterbi over (string, fret) candidates with hand-position
                  inertia, so the tab stays in one box instead of jumping
  * midi import - any .mid track becomes a tab through the same solver

Progress and results are emitted as JSON lines on stdout.
"""

import argparse
import itertools
import json
import math
import os
import sys
import warnings
import wave

os.environ.setdefault("OMP_NUM_THREADS", "2")
warnings.filterwarnings("ignore", category=RuntimeWarning)
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

# ---------------------------------------------------------------------------
# tunings / presets
# ---------------------------------------------------------------------------

# high string first (string 1) -> low string last
GUITAR_TUNINGS = {
    "standard": ([64, 59, 55, 50, 45, 40], ["e", "B", "G", "D", "A", "E"]),
    "drop_d": ([64, 59, 55, 50, 45, 38], ["e", "B", "G", "D", "A", "D"]),
    "half_step_down": ([63, 58, 54, 49, 44, 39], ["eb", "Bb", "Gb", "Db", "Ab", "Eb"]),
    "d_standard": ([62, 57, 53, 48, 43, 38], ["d", "A", "F", "C", "G", "D"]),
    "drop_c": ([62, 57, 53, 48, 43, 36], ["d", "A", "F", "C", "G", "C"]),
    "open_d": ([62, 57, 54, 50, 45, 38], ["d", "A", "F#", "D", "A", "D"]),
    "open_g": ([62, 59, 55, 50, 43, 38], ["d", "B", "G", "D", "G", "D"]),
}

BASS_TUNINGS = {
    "standard": ([43, 38, 33, 28], ["G", "D", "A", "E"]),
    "drop_d": ([43, 38, 33, 26], ["G", "D", "A", "D"]),
    "half_step_down": ([42, 37, 32, 27], ["Gb", "Db", "Ab", "Eb"]),
    "d_standard": ([41, 36, 31, 26], ["F", "C", "G", "D"]),
    "5_string": ([43, 38, 33, 28, 23], ["G", "D", "A", "E", "B"]),
    "5_string_drop_a": ([43, 38, 33, 28, 21], ["G", "D", "A", "E", "A"]),
}

POSITION_PRESETS = {"auto": None, "open": 0, "mid": 5, "high": 9, "octave": 12}

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def progress(pct, message):
    emit(type="progress", pct=int(pct), message=message)


def fail(message):
    emit(type="error", message=str(message))
    os._exit(1)


def midi_name(p):
    return f"{NOTE_NAMES[int(p) % 12]}{int(p) // 12 - 1}"


# ---------------------------------------------------------------------------
# audio helpers
# ---------------------------------------------------------------------------

def wav_duration(path):
    try:
        import soundfile as sf
        return float(sf.info(path).duration)
    except Exception:
        try:
            with wave.open(path, "rb") as w:
                return w.getnframes() / float(w.getframerate())
        except Exception:
            return 0.0


def load_mono(path, target_sr=None):
    import numpy as np
    import soundfile as sf

    y, sr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if target_sr and sr != target_sr:
        import librosa
        y = librosa.resample(y, orig_sr=sr, target_sr=target_sr, res_type="soxr_hq")
        sr = target_sr
    return np.ascontiguousarray(y, dtype=np.float32), sr


def pick_torch_device(requested):
    try:
        import torch
    except Exception:
        return "cpu"
    if requested == "cpu":
        return "cpu"
    if requested == "cuda":
        return "cuda" if torch.cuda.is_available() else "cpu"
    if torch.cuda.is_available():
        return "cuda"
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return "mps"
    return "cpu"


# ---------------------------------------------------------------------------
# beat grid
# ---------------------------------------------------------------------------

def track_beats(mix_path, stem_path, duration, beats_per_bar=4):
    """
    Beat times + downbeat phase. Prefers the full mix (drums) and falls back
    to the stem. Beats are extrapolated to cover [0, duration].
    Returns (beats, phase, bpm, source_label).
    """
    import numpy as np
    import librosa

    source = None
    for path, label in ((mix_path, "mix"), (stem_path, "stem")):
        if path and os.path.isfile(path):
            source = (path, label)
            break

    bpm = 120.0
    beats = np.array([], dtype=float)
    phase = 0
    label = "fixed"

    if source:
        try:
            y, sr = load_mono(source[0], target_sr=22050)
            hop = 512
            y_h, y_p = librosa.effects.hpss(y)
            onset_env = librosa.onset.onset_strength(y=y_p, sr=sr, hop_length=hop, aggregate=np.median)
            tempo, beat_frames = librosa.beat.beat_track(
                onset_envelope=onset_env, sr=sr, hop_length=hop, start_bpm=118.0, tightness=110, trim=False
            )
            tempo = float(np.atleast_1d(tempo)[0])
            beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop)
            if len(beats) >= 8:
                ibi = np.median(np.diff(beats))
                if ibi > 0:
                    bpm = 60.0 / ibi
                else:
                    bpm = tempo
                label = source[1]

                # downbeat phase: harmony changes land on downbeats far more
                # often than elsewhere, and downbeats are accented. Decode the
                # chord progression of the mix and vote with the change points.
                score = np.zeros(len(beat_frames))
                try:
                    mix_chords = decode_chords(y, sr, [float(b) for b in beats], "clean")
                    for c in mix_chords[1:]:
                        i = int(np.argmin(np.abs(beats - c["start"])))
                        score[i] += min(4.0, (c["end"] - c["start"]) / ibi)
                    if score.max() > 0:
                        score = score / score.max()
                except Exception:
                    pass
                full_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop)
                accent = np.array([full_env[max(0, min(len(full_env) - 1, f)):min(len(full_env), f + 3)].max() for f in beat_frames])
                if accent.max() > 0:
                    accent = accent / accent.max()
                score = score + 0.35 * accent
                phase_scores = [
                    float(np.mean(score[p::beats_per_bar])) if len(score[p::beats_per_bar]) else 0.0
                    for p in range(beats_per_bar)
                ]
                phase = int(np.argmax(phase_scores))
            else:
                beats = np.array([], dtype=float)
        except Exception as e:
            emit(type="info", message=f"Beat tracking fell back to a fixed grid: {e}")
            beats = np.array([], dtype=float)

    if not (45.0 <= bpm <= 240.0):
        bpm = 120.0

    ibi = 60.0 / bpm
    if len(beats) < 8:
        beats = np.arange(0.0, max(duration, ibi) + ibi, ibi)
        phase = 0
        label = "fixed"
    else:
        # extrapolate to the start and end of the track
        head = []
        t = beats[0] - ibi
        while t > -ibi * 0.5:
            head.append(t)
            t -= ibi
        head = head[::-1]
        tail = []
        t = beats[-1] + ibi
        while t < duration + ibi:
            tail.append(t)
            t += ibi
        # keep the phase consistent after prepending beats
        phase = (phase - len(head)) % beats_per_bar
        beats = np.concatenate([np.array(head), beats, np.array(tail)])
        beats = beats[beats > -1e-6]
        if len(head):
            phase = (phase) % beats_per_bar
    return [round(float(b), 4) for b in beats], phase, round(bpm, 1), label


def build_measures(beats, phase, beats_per_bar, duration):
    """Measures from the beat grid: each starts at a downbeat."""
    measures = []
    if not beats:
        return measures
    ibi = beats[1] - beats[0] if len(beats) > 1 else 0.5
    # a partial pickup bar before the first downbeat
    first_down = phase
    if first_down > 0 and beats[0] > 0.05:
        measures.append({"start": 0.0, "end": beats[first_down]})
    elif first_down > 0:
        measures.append({"start": 0.0, "end": beats[first_down]})
    elif beats[0] > 0.05:
        measures.append({"start": 0.0, "end": beats[0]})
    i = first_down
    while i < len(beats):
        start = beats[i]
        j = i + beats_per_bar
        end = beats[j] if j < len(beats) else beats[-1] + ibi * (j - (len(beats) - 1))
        if start >= duration:
            break
        measures.append({"start": round(float(start), 4), "end": round(float(min(end, duration + ibi)), 4)})
        i = j
    for n, m in enumerate(measures):
        m["number"] = n + 1
    return measures


def beat_subdivisions(measure_start, measure_end, beats, per_beat=4):
    """Times of the 16th-note columns inside a measure, following the tracked beats."""
    inside = [b for b in beats if measure_start - 1e-6 <= b < measure_end - 1e-6]
    if not inside or abs(inside[0] - measure_start) > 1e-3:
        inside = [measure_start] + inside
    edges = inside + [measure_end]
    cols = []
    for a, b in zip(edges[:-1], edges[1:]):
        for k in range(per_beat):
            cols.append(a + (b - a) * k / per_beat)
    return cols


# ---------------------------------------------------------------------------
# monophonic f0 tracking
# ---------------------------------------------------------------------------

def track_f0(y, sr, fmin, fmax, hop_s, device, octave_up=False):
    """
    Frame-wise fundamental frequency with a confidence.
    Returns (times, f0_hz (nan when unvoiced), confidence, tracker_label).
    `octave_up` presents the audio to the tracker an octave higher (bass lives
    below the sweet spot of most trackers); results are folded back down.
    """
    import numpy as np

    hop = max(1, int(round(hop_s * sr)))
    n_frames = int(math.ceil(len(y) / hop))
    times = np.arange(n_frames) * hop / sr

    forced = os.environ.get("STEMKIT_F0_TRACKER", "").lower() or ("pyin" if octave_up else "")
    try:
        if forced == "pyin":
            raise ImportError("pYIN selected")
        import torch
        import torchcrepe

        dev = pick_torch_device(device)
        declared_sr = sr * 2 if octave_up else sr
        # the full model is ~20x slower than tiny and barely more accurate on
        # clean stems; only worth it when a CUDA GPU makes it free
        model = os.environ.get("STEMKIT_CREPE_MODEL") or ("full" if dev == "cuda" else "tiny")
        audio = torch.from_numpy(y).unsqueeze(0)

        def run(dev_name):
            return torchcrepe.predict(
                audio,
                declared_sr,
                hop_length=hop,
                fmin=max(30.0, fmin * (2 if octave_up else 1)),
                fmax=min(2000.0, fmax * (2 if octave_up else 1)),
                model=model,
                batch_size=1024,
                device=dev_name,
                return_periodicity=True,
            )

        try:
            pitch, periodicity = run(dev)
        except Exception as e:
            if dev != "cpu":
                emit(type="info", message=f"CREPE on {dev} failed ({e}); using CPU")
                pitch, periodicity = run("cpu")
            else:
                raise
        periodicity = torchcrepe.filter.median(periodicity, 5)
        pitch = torchcrepe.filter.median(pitch, 3)
        f0 = pitch.squeeze(0).cpu().numpy().astype(np.float64)
        conf = periodicity.squeeze(0).cpu().numpy().astype(np.float64)
        if octave_up:
            f0 = f0 / 2.0
        n = min(len(f0), n_frames)
        out_f0 = np.full(n_frames, np.nan)
        out_conf = np.zeros(n_frames)
        out_f0[:n] = f0[:n]
        out_conf[:n] = conf[:n]
        return times, out_f0, out_conf, f"CREPE {model} ({dev})"
    except ImportError:
        pass
    except Exception as e:
        emit(type="info", message=f"CREPE unavailable ({e}); using pYIN")

    import librosa

    # pYIN works best around 22 kHz for these registers
    target_sr = 22050
    y2 = librosa.resample(y, orig_sr=sr, target_sr=target_sr, res_type="soxr_hq") if sr != target_sr else y
    stride = 2  # analyse every 20 ms, then expand to the 10 ms grid
    hop2 = max(1, int(round(hop_s * stride * target_sr)))
    frame_length = 4096 if fmin < 60 else 2048
    f0, voiced_flag, voiced_prob = librosa.pyin(
        y2,
        fmin=max(25.0, fmin),
        fmax=fmax,
        sr=target_sr,
        frame_length=frame_length,
        hop_length=hop2,
        fill_na=np.nan,
        center=True,
    )
    f0 = np.repeat(f0, stride)
    voiced_prob = np.repeat(np.nan_to_num(voiced_prob), stride)
    n = min(len(f0), n_frames)
    out_f0 = np.full(n_frames, np.nan)
    out_conf = np.zeros(n_frames)
    out_f0[:n] = f0[:n]
    out_conf[:n] = voiced_prob[:n]
    return times, out_f0, out_conf, "pYIN"


def fix_octaves(notes, y, sr, lowest, highest):
    """
    Pitch trackers sometimes lock onto the 2nd harmonic. For each note compare
    the harmonic series rooted at the detected pitch with the series rooted an
    octave below; if the lower root explains the spectrum better (and actually
    has energy at its fundamental) the note moves down an octave.
    """
    if not notes:
        return notes
    import numpy as np
    import librosa

    hop = 512
    bpo = 36
    fmin_midi = 24
    n_bins = 7 * bpo
    try:
        C = np.abs(librosa.cqt(y, sr=sr, hop_length=hop, fmin=librosa.midi_to_hz(fmin_midi), n_bins=n_bins, bins_per_octave=bpo))
    except Exception:
        return notes
    C = librosa.amplitude_to_db(C, ref=np.max)
    n_frames = C.shape[1]
    harmonics = (0, 12, 19, 24)

    def energy(col, midi):
        b = int(round((midi - fmin_midi) * bpo / 12))
        if b < 1 or b >= n_bins - 1:
            return -80.0
        return float(col[b - 1:b + 2].max())

    def series(col, root):
        vals = [energy(col, root + h) for h in harmonics]
        return sum(vals) / len(vals)

    out = []
    for n in notes:
        f0 = min(n_frames - 1, int(n["start"] * sr / hop) + 1)
        f1 = max(f0 + 1, min(n_frames, int(n["end"] * sr / hop)))
        col = C[:, f0:f1].mean(axis=1)
        floor = float(np.percentile(col, 35))
        p = n["pitch"]
        q = p - 12
        if q >= lowest:
            concurrent_below = any(
                o is not n and o["pitch"] == q and o["start"] < n["end"] and o["end"] > n["start"] for o in notes
            )
            eq, ep = energy(col, q), energy(col, p)
            if not concurrent_below and eq >= floor + 14.0 and eq >= ep - 16.0 and series(col, q) >= series(col, p) - 2.0:
                n = dict(n, pitch=q)
        out.append(n)
    return out


def frame_rms(y, sr, hop):
    import numpy as np
    import librosa

    rms = librosa.feature.rms(y=y, frame_length=hop * 4, hop_length=hop, center=True)[0]
    return rms.astype(np.float64)


def detect_onsets(y, sr, hop, sensitivity):
    import numpy as np
    import librosa

    env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, aggregate=np.median)
    delta = 0.045 if sensitivity == "sensitive" else 0.09
    wait = max(1, int(round(0.06 / (hop / sr))))
    frames = librosa.onset.onset_detect(
        onset_envelope=env,
        sr=sr,
        hop_length=hop,
        backtrack=True,
        delta=delta,
        wait=wait,
        pre_max=3,
        post_max=3,
        pre_avg=int(round(0.1 * sr / hop)),
        post_avg=int(round(0.1 * sr / hop)),
        units="frames",
    )
    strength = env[np.clip(frames, 0, len(env) - 1)] if len(frames) else np.array([])
    return np.asarray(frames, dtype=int), env, strength


def segment_mono_notes(times, f0, conf, rms, onset_frames, sr, hop, sensitivity, min_dur, conf_thresh):
    """
    Turn an f0 contour into discrete notes. A note begins at a detected onset
    or when the pitch moves to a new semitone and stays there (legato);
    it ends when the signal stops being periodic.
    """
    import numpy as np

    n = len(f0)
    midi = np.full(n, np.nan)
    voiced = np.zeros(n, dtype=bool)
    floor = max(1e-5, np.percentile(rms[rms > 0], 20) * 0.6) if np.any(rms > 0) else 1e-5
    peak = max(floor * 4, np.percentile(rms, 97)) if n else 1.0
    for i in range(n):
        if not np.isnan(f0[i]) and f0[i] > 0 and conf[i] >= conf_thresh and rms[i] >= floor:
            midi[i] = 69.0 + 12.0 * math.log2(f0[i] / 440.0)
            voiced[i] = True

    onset_set = set(int(f) for f in onset_frames)
    if n > 3 and rms[:3].max() > floor * 3 and not any(f < 6 for f in onset_set):
        onset_set.add(0)
    unvoiced_end = 4  # frames (~40ms) of silence closes a note
    sustain_frames = 3  # frames a new pitch must hold to count as legato
    jump = 0.62  # semitones

    notes = []
    cur = None  # dict(start, pitches, legato)

    def close(i_end):
        nonlocal cur
        if cur is None:
            return
        p = np.array(cur["pitches"])
        w = np.array(cur["weights"])
        if len(p) == 0:
            cur = None
            return
        order = np.argsort(p)
        cw = np.cumsum(w[order])
        med = p[order][min(len(p) - 1, int(np.searchsorted(cw, cw[-1] / 2.0)))]
        pitch = int(round(float(med)))
        start_t = float(times[cur["start"]])
        end_t = float(times[min(n - 1, i_end)])
        if end_t - start_t >= min_dur:
            amp = float(np.max(rms[cur["start"]:max(cur["start"] + 1, min(n, cur["start"] + 8))]))
            amp = min(1.0, max(0.25, amp / peak))
            notes.append({
                "start": round(start_t, 3),
                "end": round(end_t, 3),
                "pitch": pitch,
                "amplitude": round(amp, 3),
                "legato": cur["legato"],
            })
        cur = None

    silent_run = 0
    last_close = -1
    lookback = 20  # frames: an onset this far back with no note since belongs to this note

    def snapped_start(i):
        for k in range(i, max(last_close, i - lookback) - 1, -1):
            if k in onset_set:
                return k
        return i

    i = 0
    while i < n:
        if voiced[i]:
            silent_run = 0
            is_onset = any((i + d) in onset_set for d in (-1, 0, 1))
            if cur is None:
                cur = {"start": snapped_start(i), "pitches": [midi[i]], "weights": [conf[i]], "legato": False}
            elif is_onset and (i - cur["start"]) >= 3 and not cur.get("onset_used_at", -10) >= i - 2:
                close(i)
                cur = {"start": i, "pitches": [midi[i]], "weights": [conf[i]], "legato": False}
                cur["onset_used_at"] = i
            else:
                ref = float(np.median(cur["pitches"][-6:]))
                if abs(midi[i] - ref) >= jump and (i - cur["start"]) >= 2:
                    # sustained move to a new semitone -> legato note
                    ahead = [midi[k] for k in range(i, min(n, i + sustain_frames)) if voiced[k]]
                    if len(ahead) >= min(sustain_frames, n - i) and all(abs(a - ref) >= jump for a in ahead) \
                            and (max(ahead) - min(ahead)) < 0.9:
                        close(i)
                        cur = {"start": i, "pitches": [midi[i]], "weights": [conf[i]], "legato": True}
                    else:
                        cur["pitches"].append(midi[i])
                        cur["weights"].append(conf[i] * 0.3)
                else:
                    cur["pitches"].append(midi[i])
                    cur["weights"].append(conf[i])
        else:
            if cur is not None:
                silent_run += 1
                if silent_run >= unvoiced_end:
                    close(i - silent_run + 1)
                    last_close = i
                    silent_run = 0
        i += 1
    close(n - 1)

    # merge fragments of the same pitch separated by a tiny gap without an onset
    notes.sort(key=lambda x: x["start"])
    merged = []
    for nt in notes:
        if merged and merged[-1]["pitch"] == nt["pitch"] and nt["start"] - merged[-1]["end"] <= 0.035 \
                and not nt.get("legato") and not any(
                    abs(times[f] - nt["start"]) < 0.02 for f in onset_frames if abs(times[f] - nt["start"]) < 0.02):
            merged[-1]["end"] = max(merged[-1]["end"], nt["end"])
            merged[-1]["amplitude"] = max(merged[-1]["amplitude"], nt["amplitude"])
        else:
            merged.append(nt)

    # articulation labels for legato notes
    prev = None
    for nt in merged:
        if nt.get("legato") and prev is not None:
            d = nt["pitch"] - prev["pitch"]
            if abs(d) >= 3:
                nt["articulation"] = "slide"
            elif d > 0:
                nt["articulation"] = "hammer"
            elif d < 0:
                nt["articulation"] = "pull"
        nt.pop("legato", None)
        prev = nt
    return merged


def transcribe_lead(y, sr, instrument, sensitivity, device, progress_base=10):
    """Monophonic transcription (bass, guitar lead lines)."""
    import numpy as np

    is_bass = instrument == "bass"
    hop_s = 0.01
    hop = int(round(hop_s * sr))
    fmin = 28.0 if is_bass else 70.0
    fmax = 500.0 if is_bass else 1400.0

    progress(progress_base, f"Tracking {'bass' if is_bass else 'guitar'} pitch contour…")
    times, f0, conf, tracker = track_f0(y, sr, fmin, fmax, hop_s, device, octave_up=is_bass)

    progress(progress_base + 30, "Detecting note onsets…")
    onset_frames, env, _ = detect_onsets(y, sr, hop, sensitivity)
    rms = frame_rms(y, sr, hop)
    n = len(f0)
    if len(rms) < n:
        rms = np.pad(rms, (0, n - len(rms)))
    rms = rms[:n]

    conf_thresh = 0.30 if sensitivity == "sensitive" else 0.42
    if tracker == "pYIN":
        conf_thresh = 0.35 if sensitivity == "sensitive" else 0.5
    min_dur = (0.05 if sensitivity == "sensitive" else 0.07) if is_bass else (0.045 if sensitivity == "sensitive" else 0.06)

    progress(progress_base + 40, "Segmenting notes…")
    notes = segment_mono_notes(times, f0, conf, rms, onset_frames, sr, hop, sensitivity, min_dur, conf_thresh)
    progress(progress_base + 48, "Checking octaves against the spectrum…")
    lowest = 28 if is_bass else 40
    notes = fix_octaves(notes, y, sr, lowest, 100)
    return notes, f"{tracker} f0 tracking + onset segmentation"


# ---------------------------------------------------------------------------
# polyphonic transcription (Basic Pitch) + refinement
# ---------------------------------------------------------------------------

def transcribe_poly(path, y, sr, sensitivity, device, lowest_pitch, highest_pitch, progress_base=10):
    try:
        from basic_pitch.inference import predict
        from basic_pitch import ICASSP_2022_MODEL_PATH
    except Exception as e:
        fail(
            "The polyphonic engine (Basic Pitch) is not available in the Python environment "
            f"({e}). Re-open the tab stage to reinstall it, or use the Lead mode."
        )

    is_sensitive = sensitivity == "sensitive"
    onset_t = 0.42 if is_sensitive else 0.55
    frame_t = 0.26 if is_sensitive else 0.34
    min_len = 55 if is_sensitive else 80
    fmin = 440.0 * 2 ** ((lowest_pitch - 1 - 69) / 12)
    fmax = 440.0 * 2 ** ((highest_pitch + 1 - 69) / 12)

    progress(progress_base, "Running Basic Pitch polyphonic model…")
    try:
        _, _, raw_notes = predict(
            path,
            model_or_model_path=ICASSP_2022_MODEL_PATH,
            onset_threshold=onset_t,
            frame_threshold=frame_t,
            minimum_note_length=min_len,
            minimum_frequency=fmin,
            maximum_frequency=fmax,
            melodia_trick=True,
        )
    except TypeError:
        _, _, raw_notes = predict(
            path,
            onset_threshold=onset_t,
            frame_threshold=frame_t,
            minimum_note_length=min_len,
            minimum_frequency=fmin,
            maximum_frequency=fmax,
            melodia_trick=True,
        )
    except Exception as e:
        fail(f"Basic Pitch transcription failed: {e}")

    notes = []
    for ev in raw_notes:
        start, end, pitch, amp = float(ev[0]), float(ev[1]), int(round(ev[2])), float(ev[3])
        if end - start < 0.04:
            continue
        notes.append({"start": round(start, 3), "end": round(end, 3), "pitch": pitch, "amplitude": round(min(1.0, max(0.2, amp)), 3)})
    notes.sort(key=lambda x: (x["start"], x["pitch"]))

    # f0 anchor: repair octave errors where the audio is clearly monophonic
    progress(progress_base + 35, "Anchoring against pitch contour…")
    try:
        import numpy as np
        hop_s = 0.01
        times, f0, conf, _ = track_f0(y, sr, max(40.0, fmin), fmax, hop_s, device, octave_up=False)
        midi_track = np.full(len(f0), np.nan)
        ok = (~np.isnan(f0)) & (conf >= 0.55) & (f0 > 0)
        midi_track[ok] = 69.0 + 12.0 * np.log2(f0[ok] / 440.0)

        def track_pitch_between(a, b):
            i0 = int(a / hop_s)
            i1 = max(i0 + 1, int(b / hop_s))
            seg = midi_track[i0:i1]
            seg = seg[~np.isnan(seg)]
            if len(seg) < max(3, 0.4 * (i1 - i0)):
                return None
            return float(np.median(seg))

        fixed = []
        for nt in notes:
            anchor = track_pitch_between(nt["start"], nt["end"])
            if anchor is not None:
                concurrent = [o for o in notes if o is not nt and o["start"] < nt["end"] and o["end"] > nt["start"]]
                if not concurrent:
                    diff = nt["pitch"] - anchor
                    if 11.4 <= abs(diff) <= 12.6:
                        nt = dict(nt, pitch=int(round(anchor)))
            fixed.append(nt)
        notes = fixed
    except Exception as e:
        emit(type="info", message=f"Pitch anchoring skipped: {e}")

    progress(progress_base + 45, "Filtering harmonic ghost notes…")
    notes = filter_harmonics(notes)
    notes = fix_octaves(notes, y, sr, lowest_pitch, highest_pitch)
    notes = [n for n in notes if lowest_pitch <= n["pitch"] <= highest_pitch]
    return notes, "Basic Pitch (ONNX) + f0 anchoring"


def filter_harmonics(notes):
    """Drop weak notes that sit on the overtone series of a concurrent, stronger, lower note."""
    HARMONICS = {12, 19, 24, 28, 31}
    keep = []
    for n in notes:
        ghost = False
        for o in notes:
            if o is n or o["pitch"] >= n["pitch"]:
                continue
            if (n["pitch"] - o["pitch"]) not in HARMONICS:
                continue
            overlap = min(n["end"], o["end"]) - max(n["start"], o["start"])
            if overlap <= 0.03:
                continue
            same_attack = abs(n["start"] - o["start"]) < 0.04
            if n["amplitude"] <= o["amplitude"] * (0.55 if same_attack else 0.7):
                ghost = True
                break
        if not ghost:
            keep.append(n)
    # merge rapid same-pitch fragments
    keep.sort(key=lambda x: (x["pitch"], x["start"]))
    merged = []
    for n in keep:
        if merged and merged[-1]["pitch"] == n["pitch"] and n["start"] - merged[-1]["end"] <= 0.04:
            merged[-1] = dict(merged[-1], end=max(merged[-1]["end"], n["end"]), amplitude=max(merged[-1]["amplitude"], n["amplitude"]))
        else:
            merged.append(dict(n))
    merged.sort(key=lambda x: (x["start"], x["pitch"]))
    return merged


# ---------------------------------------------------------------------------
# chord engine
# ---------------------------------------------------------------------------

CHORD_QUALITIES = {
    "": [0, 4, 7],
    "m": [0, 3, 7],
    "7": [0, 4, 7, 10],
    "maj7": [0, 4, 7, 11],
    "m7": [0, 3, 7, 10],
    "sus2": [0, 2, 7],
    "sus4": [0, 5, 7],
    "5": [0, 7],
}

# open shapes, low E (string 6) -> high e (string 1); -1 = not played
OPEN_SHAPES = {
    "C": [-1, 3, 2, 0, 1, 0], "D": [-1, -1, 0, 2, 3, 2], "E": [0, 2, 2, 1, 0, 0], "G": [3, 2, 0, 0, 0, 3],
    "A": [-1, 0, 2, 2, 2, 0], "F": [1, 3, 3, 2, 1, 1],
    "Am": [-1, 0, 2, 2, 1, 0], "Dm": [-1, -1, 0, 2, 3, 1], "Em": [0, 2, 2, 0, 0, 0],
    "A7": [-1, 0, 2, 0, 2, 0], "B7": [-1, 2, 1, 2, 0, 2], "C7": [-1, 3, 2, 3, 1, 0], "D7": [-1, -1, 0, 2, 1, 2],
    "E7": [0, 2, 0, 1, 0, 0], "G7": [3, 2, 0, 0, 0, 1],
    "Cmaj7": [-1, 3, 2, 0, 0, 0], "Dmaj7": [-1, -1, 0, 2, 2, 2], "Fmaj7": [-1, -1, 3, 2, 1, 0], "Amaj7": [-1, 0, 2, 1, 2, 0],
    "Am7": [-1, 0, 2, 0, 1, 0], "Dm7": [-1, -1, 0, 2, 1, 1], "Em7": [0, 2, 0, 0, 0, 0],
    "Dsus2": [-1, -1, 0, 2, 3, 0], "Asus2": [-1, 0, 2, 2, 0, 0], "Esus4": [0, 2, 2, 2, 0, 0],
    "Dsus4": [-1, -1, 0, 2, 3, 3], "Asus4": [-1, 0, 2, 2, 3, 0],
    "E5": [0, 2, 2, -1, -1, -1], "A5": [-1, 0, 2, 2, -1, -1], "D5": [-1, -1, 0, 2, 3, -1],
}

# movable shapes relative to the barre fret F (low E -> high e)
E_SHAPES = {
    "": [0, 2, 2, 1, 0, 0], "m": [0, 2, 2, 0, 0, 0], "7": [0, 2, 0, 1, 0, 0], "maj7": [0, -1, 1, 1, 0, -1],
    "m7": [0, 2, 0, 0, 0, 0], "sus2": [0, 2, 4, 4, 0, 0], "sus4": [0, 2, 2, 2, 0, 0], "5": [0, 2, 2, -1, -1, -1],
}
A_SHAPES = {
    "": [-1, 0, 2, 2, 2, 0], "m": [-1, 0, 2, 2, 1, 0], "7": [-1, 0, 2, 0, 2, 0], "maj7": [-1, 0, 2, 1, 2, 0],
    "m7": [-1, 0, 2, 0, 1, 0], "sus2": [-1, 0, 2, 2, 0, 0], "sus4": [-1, 0, 2, 2, 3, 0], "5": [-1, 0, 2, 2, -1, -1],
}


def chord_name(root, quality):
    return NOTE_NAMES[root % 12] + quality


def chord_templates():
    import numpy as np
    names, mats = [], []
    for root in range(12):
        for q, ivs in CHORD_QUALITIES.items():
            v = np.zeros(12)
            for k, iv in enumerate(ivs):
                v[(root + iv) % 12] = 1.0 if k == 0 else (0.85 if iv in (7,) else 0.75)
            names.append(chord_name(root, q))
            mats.append(v / np.linalg.norm(v))
    return names, np.array(mats)


def decode_chords(y, sr, beats, sensitivity):
    """Beat-synchronous chroma + Viterbi decoding. Returns [{start, end, name}]."""
    import numpy as np
    import librosa

    hop = 512
    y_h, _ = librosa.effects.hpss(y)
    chroma = librosa.feature.chroma_cqt(y=y_h, sr=sr, hop_length=hop, bins_per_octave=24, n_octaves=4,
                                        fmin=librosa.note_to_hz("C3"))
    beat_frames = librosa.time_to_frames(np.array(beats), sr=sr, hop_length=hop)
    beat_frames = np.clip(beat_frames, 0, chroma.shape[1] - 1)
    sync = librosa.util.sync(chroma, beat_frames, aggregate=np.median)
    names, templates = chord_templates()
    n_states = len(names)
    T = sync.shape[1]
    if T == 0:
        return []
    # emissions
    emis = np.zeros((n_states, T))
    energy = np.zeros(T)
    for t in range(T):
        c = sync[:, t]
        nrm = np.linalg.norm(c)
        energy[t] = nrm
        emis[:, t] = templates @ (c / nrm) if nrm > 1e-4 else 0.0
    # cosine similarities live in a narrow band, so sharpen them before they
    # compete with the switch penalty; simpler chord qualities get a small prior
    prior = np.zeros(n_states)
    for i, nm in enumerate(names):
        _, q = split_chord_name(nm)
        prior[i] = {"": 0.0, "m": 0.0, "7": -0.45, "maj7": -0.5, "m7": -0.45, "sus2": -0.8, "sus4": -0.8, "5": -1.0}[q]
    beta = 14.0
    log_emis = beta * emis + prior[:, None]
    switch = 3.0 if sensitivity == "sensitive" else 4.2
    trans = np.full((n_states, n_states), -switch)
    np.fill_diagonal(trans, 0.0)
    # viterbi
    dp = np.zeros((n_states, T))
    back = np.zeros((n_states, T), dtype=int)
    dp[:, 0] = log_emis[:, 0]
    for t in range(1, T):
        cand = dp[:, t - 1][:, None] + trans
        back[:, t] = np.argmax(cand, axis=0)
        dp[:, t] = cand[back[:, t], np.arange(n_states)] + log_emis[:, t]
    path = np.zeros(T, dtype=int)
    path[-1] = int(np.argmax(dp[:, -1]))
    for t in range(T - 1, 0, -1):
        path[t - 1] = back[path[t], t]
    # frames -> beat segments
    segs = []
    beat_list = list(beats)
    low_energy = np.percentile(energy, 15) if T else 0
    for t in range(T):
        start = beat_list[t] if t < len(beat_list) else beat_list[-1]
        end = beat_list[t + 1] if t + 1 < len(beat_list) else start + (beat_list[-1] - beat_list[-2] if len(beat_list) > 1 else 0.5)
        name = names[path[t]] if energy[t] > low_energy * 0.6 else None
        if segs and segs[-1]["name"] == name:
            segs[-1]["end"] = round(float(end), 4)
        else:
            segs.append({"start": round(float(start), 4), "end": round(float(end), 4), "name": name})
    # drop one-beat blips between identical chords
    cleaned = []
    for i, s in enumerate(segs):
        if 0 < i < len(segs) - 1 and (s["end"] - s["start"]) < 0.9 * (beat_list[1] - beat_list[0]) * 1.5 \
                and segs[i - 1]["name"] == segs[i + 1]["name"] and s["name"] != segs[i - 1]["name"]:
            continue
        if cleaned and cleaned[-1]["name"] == s["name"]:
            cleaned[-1]["end"] = s["end"]
        else:
            cleaned.append(dict(s))
    return [s for s in cleaned if s["name"]]


def split_chord_name(name):
    root = 1 if len(name) > 1 and name[1] == "#" else 0
    root_name = name[: root + 1]
    return NOTE_NAMES.index(root_name), name[root + 1:]


def voicings_for(name, style, tuning_pitches):
    """All candidate voicings (list of 6 frets low->high, -1 muted) for a chord."""
    root, quality = split_chord_name(name)
    out = []
    n_strings = len(tuning_pitches)
    if n_strings != 6:
        return out
    low_e = tuning_pitches[-1] % 12
    a_str = tuning_pitches[-2] % 12
    if style == "standard" and name in OPEN_SHAPES:
        out.append(OPEN_SHAPES[name])
    if style == "power":
        q = "5"
    else:
        q = quality if quality in E_SHAPES else ("m" if "m" in quality and "maj" not in quality else "")
    fe = (root - low_e) % 12
    fa = (root - a_str) % 12
    for base, shapes in ((fe, E_SHAPES), (fa, A_SHAPES)):
        for off in (0, 12):
            f = base + off
            if f > 14:
                continue
            shape = shapes[q]
            v = [(-1 if s < 0 else f + s) for s in shape]
            if f == 0 and style != "power":
                # open position barre == open chord; fine
                pass
            out.append(v)
    if style != "power" and quality == "5":
        pass
    # dedupe
    seen = set()
    uniq = []
    for v in out:
        key = tuple(v)
        if key not in seen:
            seen.add(key)
            uniq.append(v)
    return uniq


def voicing_position(v):
    fretted = [f for f in v if f > 0]
    return min(fretted) if fretted else 0


def transcribe_chords(y, sr, beats, measures, tuning_pitches, style, sensitivity, duration, progress_base=10):
    """Chord decoding + strum onsets -> notes with chord labels."""
    import numpy as np

    progress(progress_base, "Decoding chord progression…")
    y22 = y
    sr22 = sr
    if sr != 22050:
        import librosa
        y22 = librosa.resample(y, orig_sr=sr, target_sr=22050, res_type="soxr_hq")
        sr22 = 22050
    chords = decode_chords(y22, sr22, beats, sensitivity)
    if not chords:
        return [], chords, "Chord decoder (no harmonic content found)"

    progress(progress_base + 35, "Locating strums…")
    hop = int(round(0.01 * sr))
    onset_frames, env, strength = detect_onsets(y, sr, hop, sensitivity)
    onset_times = [f * hop / sr for f in onset_frames]
    if len(strength):
        thresh = max(float(np.percentile(strength, 25)), float(strength.max()) * 0.12)
        onset_times = [t for t, s in zip(onset_times, strength) if s >= thresh]
    rms = frame_rms(y, sr, hop)
    peak = max(1e-4, float(np.percentile(rms, 97)))

    def chord_at(t):
        for c in chords:
            if c["start"] - 0.03 <= t < c["end"]:
                return c["name"]
        return None

    # a strum at every real onset; a sustained strum on the downbeat of bars with nothing
    strum_times = []
    for t in onset_times:
        if chord_at(t):
            strum_times.append(t)
    for m in measures:
        if not any(m["start"] - 0.05 <= t < m["end"] for t in strum_times):
            if chord_at(m["start"] + 0.02):
                strum_times.append(m["start"])
    strum_times.sort()

    progress(progress_base + 55, "Choosing voicings…")
    notes = []
    prev_voicing = None
    voicing_cache = {}
    for idx, t in enumerate(strum_times):
        name = chord_at(t)
        if not name:
            continue
        key = name
        cands = voicing_cache.get(key)
        if cands is None:
            cands = voicings_for(name, style, tuning_pitches)
            voicing_cache[key] = cands
        if not cands:
            continue
        if prev_voicing is None:
            best = min(cands, key=lambda v: voicing_position(v) * (0.35 if style == "standard" else 0.6))
        else:
            pp = voicing_position(prev_voicing)
            best = min(cands, key=lambda v: abs(voicing_position(v) - pp) * 1.0 + voicing_position(v) * 0.15)
        prev_voicing = best
        next_t = strum_times[idx + 1] if idx + 1 < len(strum_times) else t + 1.5
        end = min(next_t - 0.02, t + 1.6)
        end = max(t + 0.12, end)
        fi = min(len(rms) - 1, int(t / (hop / sr)))
        amp = min(1.0, max(0.3, float(np.max(rms[fi:fi + 8])) / peak)) if len(rms) else 0.8
        for s_idx, fret in enumerate(best):
            if fret < 0:
                continue
            string_num = 6 - s_idx
            pitch = tuning_pitches[string_num - 1] + fret
            notes.append({
                "string": string_num,
                "fret": fret,
                "pitch": pitch,
                "start": round(float(t), 3),
                "end": round(float(end), 3),
                "amplitude": round(amp, 3),
                "chord": name,
            })
    notes.sort(key=lambda x: (x["start"], x["string"]))
    return notes, chords, "Beat-synchronous chroma + Viterbi chords, onset-driven strums"


# ---------------------------------------------------------------------------
# fingering solver
# ---------------------------------------------------------------------------

def candidates_for(pitch, tuning_pitches, max_fret):
    out = []
    for s_idx, open_p in enumerate(tuning_pitches):
        f = pitch - open_p
        if 0 <= f <= max_fret:
            out.append((s_idx + 1, f))
    return out


def solve_fingering(notes, tuning_pitches, forced_position=None, max_fret=22, is_bass=False):
    """
    Viterbi over time slices. State = one (string, fret) assignment per note in
    the slice. Cost = playability of the shape + how far the hand has to move
    from the previous shape (scaled by the time available to move).
    """
    if not notes:
        return []
    notes = sorted(notes, key=lambda n: (n["start"], n["pitch"]))

    # slices: notes attacked together
    slices = []
    cur = [notes[0]]
    for n in notes[1:]:
        if n["start"] - cur[0]["start"] <= 0.03:
            cur.append(n)
        else:
            slices.append(cur)
            cur = [n]
    slices.append(cur)

    def unary(combo):
        frets = [f for _, f in combo]
        fretted = [f for f in frets if f > 0]
        cost = 0.0
        for f in frets:
            cost += f * (0.06 if not is_bass else 0.09)
            if f > 12:
                cost += (f - 12) * (0.25 if not is_bass else 0.4)
        if fretted:
            span = max(fretted) - min(fretted)
            cost += span * 1.4 if span <= 4 else 40.0
            if forced_position is not None:
                lo, hi = forced_position, forced_position + 4
                for f in fretted:
                    if f < lo:
                        cost += (lo - f) * 3.0
                    elif f > hi:
                        cost += (f - hi) * 3.0
        elif forced_position is not None and forced_position > 2:
            cost += 0.8  # open strings are fine but slightly off-box
        strings = [s for s, _ in combo]
        if len(strings) != len(set(strings)):
            cost += 1e6
        return cost

    def hand_pos(combo):
        fretted = [f for _, f in combo if f > 0]
        return min(fretted) if fretted else None

    slice_states = []
    for sl in slices:
        cand_lists = [candidates_for(n["pitch"], tuning_pitches, max_fret) for n in sl]
        if any(len(c) == 0 for c in cand_lists):
            # drop unplayable pitches from the slice
            keep = [(n, c) for n, c in zip(sl, cand_lists) if c]
            if not keep:
                slice_states.append(([], []))
                continue
            sl[:] = [n for n, _ in keep]
            cand_lists = [c for _, c in keep]
        combos = []
        for combo in itertools.product(*cand_lists):
            strings = [s for s, _ in combo]
            if len(strings) != len(set(strings)):
                continue
            u = unary(combo)
            if u < 1e5:
                combos.append((u, combo))
        if not combos:
            # unplayable chord: keep strongest notes that fit
            order = sorted(range(len(sl)), key=lambda i: -sl[i]["amplitude"])
            chosen = []
            used = set()
            for i in order:
                for s, f in sorted(cand_lists[i], key=lambda c: c[1]):
                    if s not in used:
                        used.add(s)
                        chosen.append((i, (s, f)))
                        break
            chosen.sort()
            sl[:] = [sl[i] for i, _ in chosen]
            combos = [(unary([c for _, c in chosen]), tuple(c for _, c in chosen))]
        combos.sort(key=lambda x: x[0])
        combos = combos[:48]
        slice_states.append((combos, sl))

    # viterbi: keep every slice's cost vector so backtracking is a plain walk
    INF = float("inf")
    all_costs = []
    backptr = []
    prev_costs = None
    prev_combos = None
    prev_time = None
    for combos, sl in slice_states:
        if not combos:
            all_costs.append([])
            backptr.append([])
            continue
        t = sl[0]["start"]
        costs = []
        bp = []
        for u, combo in combos:
            pos = hand_pos(combo)
            if prev_costs is None:
                costs.append(u + (pos or 0) * 0.02)
                bp.append(-1)
                continue
            dt = max(0.0, t - prev_time)
            move_w = 1.3 if dt < 0.2 else (0.8 if dt < 0.6 else (0.35 if dt < 1.5 else 0.12))
            best, best_i = INF, -1
            for i, (_, pcombo) in enumerate(prev_combos):
                ppos = hand_pos(pcombo)
                trans = 0.0
                if pos is not None and ppos is not None:
                    trans += abs(pos - ppos) * move_w
                if len(combo) == 1 and len(pcombo) == 1 and dt < 0.35:
                    trans += abs(combo[0][0] - pcombo[0][0]) * 0.18
                    if combo[0][1] > 0 and pcombo[0][1] > 0 and combo[0][0] == pcombo[0][0]:
                        trans -= 0.1
                c = prev_costs[i] + trans
                if c < best:
                    best, best_i = c, i
            costs.append(best + u)
            bp.append(best_i)
        all_costs.append(costs)
        backptr.append(bp)
        prev_costs, prev_combos, prev_time = costs, combos, t

    assigned = []
    choice = None
    for k in range(len(slice_states) - 1, -1, -1):
        combos, sl = slice_states[k]
        if not combos:
            continue
        if choice is None or choice < 0:
            costs_k = all_costs[k]
            choice = int(min(range(len(costs_k)), key=lambda i: costs_k[i]))
        combo = combos[choice][1]
        for n, (s, f) in zip(sl, combo):
            assigned.append(dict(n, string=s, fret=f))
        choice = backptr[k][choice]
    assigned.sort(key=lambda x: (x["start"], x["string"]))
    return assigned


# ---------------------------------------------------------------------------
# ascii + midi
# ---------------------------------------------------------------------------

def ascii_tab(notes, measures, beats, string_names, chords=None, beats_per_bar=4, bars_per_line=2):
    if not measures:
        return "\n".join(f"{name:2s}|---|" for name in string_names)
    n_strings = len(string_names)
    cols_per_beat = 4
    col_w = 3
    lines_out = []
    chords = chords or []

    def chord_at(t):
        for c in chords:
            if c["start"] - 0.03 <= t < c["end"]:
                return c["name"]
        return None

    for chunk_start in range(0, len(measures), bars_per_line):
        chunk = measures[chunk_start:chunk_start + bars_per_line]
        header_cells = []
        rows = {s: [] for s in range(1, n_strings + 1)}
        chord_row = []
        for m in chunk:
            cols = beat_subdivisions(m["start"], m["end"], beats, cols_per_beat)
            grid = {s: ["-" * col_w for _ in cols] for s in range(1, n_strings + 1)}
            crow = [" " * col_w for _ in cols]
            m_notes = [n for n in notes if m["start"] - 1e-6 <= n["start"] < m["end"] - 1e-6]
            for n in m_notes:
                ci = min(range(len(cols)), key=lambda i: abs(cols[i] - n["start"]))
                s = n["string"]
                if s not in grid:
                    continue
                if grid[s][ci] != "-" * col_w and ci + 1 < len(cols) and grid[s][ci + 1] == "-" * col_w:
                    ci += 1
                art = n.get("articulation")
                prefix = {"hammer": "h", "pull": "p", "slide": "/"}.get(art, "")
                txt = f"{prefix}{n['fret']}"
                grid[s][ci] = (txt + "-" * col_w)[:col_w]
            last_chord = None
            for i, t in enumerate(cols):
                c = chord_at(t) if chords else None
                if c and c != last_chord:
                    crow[i] = (c + " " * col_w)[:col_w] if len(c) <= col_w else c
                    last_chord = c
            mm = int(m["start"] // 60)
            ss = int(m["start"] % 60)
            header_cells.append(f"Bar {m['number']} [{mm:02d}:{ss:02d}]")
            for s in rows:
                rows[s].append("".join(grid[s]))
            chord_row.append("".join(crow))
        lines_out.append("   " + "   ".join(f"{h:<{len(chord_row[i])}}" for i, h in enumerate(header_cells)))
        if chords and any(c.strip() for c in chord_row):
            lines_out.append("   " + "|" + "|".join(chord_row) + "|")
        for s_idx, name in enumerate(string_names):
            s = s_idx + 1
            lines_out.append(f"{name:2s} |" + "|".join(rows[s]) + "|")
        lines_out.append("")
    return "\n".join(lines_out).rstrip() + "\n"


def export_midi(notes, path, bpm, instrument, tuning_pitches, beats_per_bar=4):
    try:
        import pretty_midi

        pm = pretty_midi.PrettyMIDI(initial_tempo=float(bpm))
        pm.time_signature_changes.append(pretty_midi.TimeSignature(beats_per_bar, 4, 0))
        is_bass = instrument == "bass"
        program = pretty_midi.instrument_name_to_program("Electric Bass (finger)" if is_bass else "Acoustic Guitar (steel)")
        n_strings = len(tuning_pitches)
        label = "Bass" if is_bass else "Guitar"
        tracks = [pretty_midi.Instrument(program=program, name=f"{label} string {s}") for s in range(1, n_strings + 1)]
        for n in notes:
            idx = max(0, min(n_strings - 1, n["string"] - 1))
            vel = int(round(max(28, min(127, n.get("amplitude", 0.8) * 127))))
            tracks[idx].notes.append(pretty_midi.Note(velocity=vel, pitch=int(n["pitch"]), start=float(n["start"]),
                                                      end=float(max(n["start"] + 0.06, n["end"]))))
        for tr in tracks:
            if tr.notes:
                pm.instruments.append(tr)
        pm.write(path)
        return True
    except Exception as e:
        emit(type="info", message=f"MIDI export failed: {e}")
        return False


# ---------------------------------------------------------------------------
# MIDI import
# ---------------------------------------------------------------------------

def list_midi_tracks(path):
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(path)
    tracks = []
    for i, inst in enumerate(pm.instruments):
        if not inst.notes:
            continue
        pitches = [n.pitch for n in inst.notes]
        try:
            program_name = pretty_midi.program_to_instrument_name(inst.program)
        except Exception:
            program_name = f"Program {inst.program}"
        tracks.append({
            "index": i,
            "name": inst.name or program_name,
            "program": int(inst.program),
            "programName": program_name,
            "isDrum": bool(inst.is_drum),
            "noteCount": len(inst.notes),
            "pitchLow": midi_name(min(pitches)),
            "pitchHigh": midi_name(max(pitches)),
            "start": round(float(min(n.start for n in inst.notes)), 2),
            "end": round(float(max(n.end for n in inst.notes)), 2),
        })
    return {
        "duration": round(float(pm.get_end_time()), 2),
        "bpm": round(float(pm.estimate_tempo()), 1) if pm.instruments else 120.0,
        "tracks": tracks,
    }


def notes_from_midi(path, track_sel, offset, transpose, lowest, highest):
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(path)
    chosen = []
    for i, inst in enumerate(pm.instruments):
        if inst.is_drum:
            continue
        if track_sel == "all" or str(i) == str(track_sel):
            chosen.append(inst)
    raw = []
    for inst in chosen:
        for n in inst.notes:
            raw.append((n.start, n.end, n.pitch, n.velocity))
    if not raw:
        fail("The selected MIDI track has no notes.")

    def in_range(shift):
        return sum(1 for _, _, p, _ in raw if lowest <= p + transpose + shift <= highest) / len(raw)

    best_shift = max((0, -12, 12, -24, 24), key=lambda s: (round(in_range(s), 3), -abs(s)))
    notes = []
    for s, e, p, v in raw:
        pitch = p + transpose + best_shift
        if not (lowest <= pitch <= highest):
            continue
        notes.append({
            "start": round(float(s + offset), 3),
            "end": round(float(max(s + 0.05, e) + offset), 3),
            "pitch": int(pitch),
            "amplitude": round(max(0.2, min(1.0, v / 127.0)), 3),
        })
    notes = [n for n in notes if n["end"] > 0]
    for n in notes:
        n["start"] = max(0.0, n["start"])
    notes.sort(key=lambda n: (n["start"], n["pitch"]))

    # grid from the MIDI file itself
    try:
        beats = [round(float(b + offset), 4) for b in pm.get_beats() if b + offset >= 0]
        downs = [round(float(d + offset), 4) for d in pm.get_downbeats() if d + offset >= 0]
        ts = pm.time_signature_changes
        beats_per_bar = int(ts[0].numerator) if ts else 4
        bpm = float(pm.estimate_tempo()) if len(raw) > 4 else 120.0
        if pm.get_tempo_changes()[1].size:
            bpm = float(pm.get_tempo_changes()[1][0])
    except Exception:
        beats, downs, beats_per_bar, bpm = [], [], 4, 120.0
    phase = 0
    if beats and downs:
        try:
            phase = min(range(len(beats)), key=lambda i: abs(beats[i] - downs[0]))
        except ValueError:
            phase = 0
    return notes, beats, phase, beats_per_bar, bpm, best_shift


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Guitar / bass tablature engine")
    parser.add_argument("--input", help="Isolated stem WAV")
    parser.add_argument("--mix", default=None, help="Full mix WAV (for beat tracking)")
    parser.add_argument("--out", help="Output tabs JSON")
    parser.add_argument("--instrument", default="guitar", choices=["guitar", "bass"])
    parser.add_argument("--mode", default="auto", help="auto | lead | poly | chord (bass is always lead)")
    parser.add_argument("--voicing", default="standard", choices=["standard", "barre", "power"])
    parser.add_argument("--tuning", default="standard")
    parser.add_argument("--position", default="auto")
    parser.add_argument("--sensitivity", default="clean")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--beats-per-bar", type=int, default=4)
    parser.add_argument("--from-midi", default=None, help="Build the tab from this MIDI file instead of audio")
    parser.add_argument("--midi-track", default="all")
    parser.add_argument("--midi-offset", type=float, default=0.0)
    parser.add_argument("--transpose", type=int, default=0)
    parser.add_argument("--list-midi-tracks", default=None, help="Print the tracks of a MIDI file and exit")
    parser.add_argument("--downbeat-phase", type=int, default=None, help="Override which tracked beat starts bar 1 (0..beats-per-bar-1)")
    parser.add_argument("--rebuild-from", default=None,
                        help="Reuse the notes/beats of an existing tabs JSON and only rebuild bars, ASCII and MIDI")
    args = parser.parse_args()

    if args.list_midi_tracks:
        try:
            info = list_midi_tracks(args.list_midi_tracks)
        except Exception as e:
            fail(f"Could not read MIDI file: {e}")
        emit(type="tracks", **info)
        os._exit(0)

    if not args.out:
        fail("--out is required")
    if not args.from_midi and not args.rebuild_from and not (args.input and os.path.isfile(args.input)):
        fail(f"Input file does not exist: {args.input}")

    is_bass = args.instrument == "bass"
    tunings = BASS_TUNINGS if is_bass else GUITAR_TUNINGS
    tuning_pitches, tuning_names = tunings.get(args.tuning.lower(), tunings["standard"])
    max_fret = 20 if is_bass else 22
    lowest = min(tuning_pitches)
    highest = max(tuning_pitches) + max_fret
    forced_pos = POSITION_PRESETS.get(args.position.lower(), None)
    sensitivity = "sensitive" if args.sensitivity.lower() == "sensitive" else "clean"
    mode = args.mode.lower()
    if is_bass:
        mode = "lead"
    elif mode in ("auto", "note"):
        mode = "poly"
    if mode not in ("lead", "poly", "chord"):
        mode = "poly"

    duration = wav_duration(args.input) if args.input and os.path.isfile(args.input) else 0.0
    beats_per_bar = max(2, min(7, args.beats_per_bar))

    chords = []
    source = "audio"
    midi_meta = {}

    if args.rebuild_from:
        try:
            with open(args.rebuild_from, "r", encoding="utf-8") as f:
                prev = json.load(f)
        except Exception as e:
            fail(f"Could not read existing tab data: {e}")
        assigned = prev.get("notes", [])
        beats = prev.get("beats") or []
        beats_per_bar = int(prev.get("beatsPerBar") or beats_per_bar)
        if args.beats_per_bar != 4:
            beats_per_bar = max(2, min(7, args.beats_per_bar))
        phase = int(prev.get("downbeatPhase") or 0)
        if args.downbeat_phase is not None:
            phase = args.downbeat_phase % beats_per_bar
        bpm = float(prev.get("bpm") or 120.0)
        duration = float(prev.get("duration") or duration or max((n["end"] for n in assigned), default=0.0))
        chords = prev.get("chords") or []
        source = prev.get("source", "audio")
        engine = prev.get("engine") or prev.get("model") or "StemKit tab engine"
        mode = prev.get("mode", mode)
        tuning_names = prev.get("tuning") or tuning_names
        tuning_pitches = prev.get("tuningPitches") or tuning_pitches
        midi_meta = {k: prev[k] for k in ("midiFile", "midiTrack", "midiOffset", "transpose") if k in prev}
        if not beats:
            beats, phase, bpm, _ = track_beats(None, None, duration, beats_per_bar)
        measures = build_measures(beats, phase, beats_per_bar, duration)
        progress(60, "Rebuilding bars…")
    elif args.from_midi:
        progress(5, "Reading MIDI file…")
        notes, beats, phase, bpb, bpm, shift = notes_from_midi(
            args.from_midi, args.midi_track, args.midi_offset, args.transpose, lowest, highest
        )
        beats_per_bar = bpb or beats_per_bar
        if not duration:
            duration = max((n["end"] for n in notes), default=0.0) + 1.0
        if not beats or len(beats) < 4:
            beats, phase, bpm, _ = track_beats(None, None, duration, beats_per_bar)
        if args.downbeat_phase is not None:
            phase = args.downbeat_phase % beats_per_bar
        bpm = round(bpm, 1)
        measures = build_measures(beats, phase, beats_per_bar, max(duration, max((n["end"] for n in notes), default=0.0)))
        source = "midi"
        midi_meta = {
            "midiFile": os.path.abspath(args.from_midi),
            "midiTrack": args.midi_track,
            "midiOffset": args.midi_offset,
            "transpose": args.transpose + shift,
        }
        engine = "MIDI import"
        mode = "poly" if not is_bass else "lead"
        progress(40, f"Solving fingerings for {len(notes)} notes…")
        assigned = solve_fingering(notes, tuning_pitches, forced_pos, max_fret, is_bass)
    else:
        progress(3, "Loading audio…")
        y, sr = load_mono(args.input)
        if duration <= 0:
            duration = len(y) / sr

        progress(6, "Tracking beats on the full mix…")
        beats, phase, bpm, grid_source = track_beats(args.mix, args.input, duration, beats_per_bar)
        if args.downbeat_phase is not None:
            phase = args.downbeat_phase % beats_per_bar
        measures = build_measures(beats, phase, beats_per_bar, duration)

        if mode == "chord":
            raw, chords, engine = transcribe_chords(
                y, sr, beats, measures, tuning_pitches, args.voicing, sensitivity, duration, progress_base=12
            )
            assigned = raw  # voicings already carry string/fret
        elif mode == "lead":
            raw, engine = transcribe_lead(y, sr, args.instrument, sensitivity, args.device, progress_base=12)
            raw = [n for n in raw if lowest <= n["pitch"] <= highest]
            progress(70, f"Solving fingerings for {len(raw)} notes…")
            assigned = solve_fingering(raw, tuning_pitches, forced_pos, max_fret, is_bass)
        else:
            raw, engine = transcribe_poly(args.input, y, sr, sensitivity, args.device, lowest, highest, progress_base=12)
            progress(72, f"Solving fingerings for {len(raw)} notes…")
            assigned = solve_fingering(raw, tuning_pitches, forced_pos, max_fret, is_bass)
        engine = f"{engine} · beat grid from {grid_source}"

    progress(88, "Rendering tablature…")
    for n in assigned:
        n["string"] = int(n["string"])
        n["fret"] = int(n["fret"])
    for m in measures:
        m["notes"] = [n for n in assigned if m["start"] - 1e-6 <= n["start"] < m["end"] - 1e-6]
        if chords:
            inside = [c["name"] for c in chords if c["start"] < m["end"] and c["end"] > m["start"]]
            if inside:
                # dominant chord of the bar
                best, best_len = None, 0.0
                for c in chords:
                    ov = min(c["end"], m["end"]) - max(c["start"], m["start"])
                    if ov > best_len:
                        best, best_len = c["name"], ov
                m["chord"] = best
    text = ascii_tab(assigned, measures, beats, tuning_names, chords, beats_per_bar)

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    midi_path = os.path.splitext(args.out)[0] + ".mid"
    export_midi(assigned, midi_path, bpm, args.instrument, tuning_pitches, beats_per_bar)

    progress(95, "Writing tablature data…")
    out = {
        "instrument": args.instrument,
        "engine": engine,
        "model": engine,
        "source": source,
        "bpm": bpm,
        "mode": mode,
        "voicingStyle": args.voicing,
        "tuning": tuning_names,
        "tuningId": args.tuning.lower(),
        "tuningPitches": tuning_pitches,
        "positionAnchor": args.position,
        "sensitivity": sensitivity,
        "duration": round(duration, 2),
        "beatsPerBar": beats_per_bar,
        "beats": beats,
        "downbeatPhase": phase,
        "chords": chords,
        "notesCount": len(assigned),
        "midiPath": midi_path if os.path.isfile(midi_path) else None,
        "notes": assigned,
        "measures": measures,
        "asciiTab": text,
        **midi_meta,
    }
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    progress(100, f"{'Bass' if is_bass else 'Guitar'} tablature ready")
    emit(type="done", out=args.out, midi=midi_path, notes_count=len(assigned), bpm=bpm)
    os._exit(0)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover
        fail(f"{type(exc).__name__}: {exc}")
