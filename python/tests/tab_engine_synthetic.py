"""
Ground-truth check for the tablature engine on synthetic material.

Renders a bass groove, a pentatonic guitar lead and a strummed chord
progression with Karplus-Strong plucks (plus a click track "mix" for beat
tracking), runs tab_transcribe.py on each and reports note / chord accuracy.

    python python/tests/tab_engine_synthetic.py [--python /path/to/venv/python]

Needs the tab engine dependencies (see ensureTabEngineDeps in src/main/env.ts).
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(HERE, "..", "tab_transcribe.py")
SR = 44100
BPM = 112.0
BEAT = 60.0 / BPM
BARS = 8


def pluck(freq, dur, decay=0.996, bright=0.5, amp=0.8):
    n = int(dur * SR)
    period = int(round(SR / freq))
    buf = (np.random.rand(period) * 2 - 1) * amp
    out = np.zeros(n, dtype=np.float32)
    for i in range(n):
        out[i] = buf[i % period]
        buf[i % period] = decay * (bright * buf[i % period] + (1 - bright) * buf[(i + 1) % period])
    return out * np.exp(-np.linspace(0, 6.0 * dur / max(dur, 0.6), n))


def place(track, sig, t):
    i = int(t * SR)
    j = min(len(track), i + len(sig))
    track[i:j] += sig[: j - i]


def midi_freq(p):
    return 440.0 * 2 ** ((p - 69) / 12)


def build(out_dir):
    import soundfile as sf

    rng = np.random.default_rng(3)
    np.random.seed(7)  # pluck excitation noise; keeps the run deterministic
    dur = BARS * 4 * BEAT + 1.0
    n = int(dur * SR)
    truth = {"bpm": BPM}

    bass = np.zeros(n, dtype=np.float32)
    truth["bass"] = []
    for bar in range(BARS):
        root = [45, 42, 38, 40][bar % 4]
        pattern = [root, root, root + 7, root, root + 12, root + 7, root, root + 5] if bar % 2 == 0 else \
                  [root, root + 7, root, root + 7, root + 12, root + 10, root + 7, root + 5]
        for k, p in enumerate(pattern):
            t = bar * 4 * BEAT + k * BEAT / 2
            place(bass, pluck(midi_freq(p), BEAT / 2 * 0.9 + 0.15, decay=0.9985, bright=0.35, amp=0.7), t)
            truth["bass"].append({"pitch": p, "start": round(t, 3), "end": round(t + BEAT * 0.45, 3)})

    lead = np.zeros(n, dtype=np.float32)
    truth["lead"] = []
    scale = [57, 60, 62, 64, 67, 69, 72, 74, 76]
    t, i = 0.0, 0
    while t < BARS * 4 * BEAT - BEAT:
        p = scale[(i * 3 + (i // 4)) % len(scale)]
        d = BEAT if i % 3 == 0 else BEAT / 2
        place(lead, pluck(midi_freq(p), d * 0.95 + 0.1, decay=0.997, bright=0.5, amp=0.6), t)
        truth["lead"].append({"pitch": p, "start": round(t, 3), "end": round(t + d * 0.95, 3)})
        t += d
        i += 1

    chords = np.zeros(n, dtype=np.float32)
    truth["chords"] = []
    shapes = {"A": [-1, 0, 2, 2, 2, 0], "F#m": [2, 4, 4, 2, 2, 2], "D": [-1, -1, 0, 2, 3, 2], "E": [0, 2, 2, 1, 0, 0]}
    open_p = [40, 45, 50, 55, 59, 64]
    for bar in range(BARS):
        name = ["A", "F#m", "D", "E"][bar % 4]
        truth["chords"].append({"name": name, "start": round(bar * 4 * BEAT, 3), "end": round((bar + 1) * 4 * BEAT, 3)})
        for off in (0.0, 1.5, 2.0, 3.5):
            t0 = bar * 4 * BEAT + off * BEAT
            for s, f in enumerate(shapes[name]):
                if f >= 0:
                    place(chords, pluck(midi_freq(open_p[s] + f), 0.9, decay=0.998, bright=0.45, amp=0.28), t0 + s * 0.012)

    mix = bass * 0.9 + lead * 0.6 + chords * 0.8
    for bar in range(BARS):
        for b in range(4):
            i0 = int((bar * 4 * BEAT + b * BEAT) * SR)
            tt = np.arange(int(0.12 * SR)) / SR
            mix[i0:i0 + len(tt)] += np.sin(2 * np.pi * (60 + 80 * np.exp(-tt * 40)) * tt) * np.exp(-tt * 25) * (1.0 if b in (0, 2) else 0.4)
            if b in (1, 3):
                sn = int(0.08 * SR)
                mix[i0:i0 + sn] += rng.standard_normal(sn) * np.exp(-np.arange(sn) / SR * 60) * 0.5
    mix = mix / max(1.0, np.abs(mix).max()) * 0.9

    for name, sig in (("bass", bass), ("lead", lead), ("chords", chords)):
        sf.write(os.path.join(out_dir, f"{name}.wav"), np.stack([sig, sig], axis=1), SR, subtype="FLOAT")
    sf.write(os.path.join(out_dir, "mix.wav"), np.stack([mix, mix], axis=1), SR, subtype="PCM_16")
    return truth


def run_engine(python, args):
    proc = subprocess.run([python, ENGINE, *args], capture_output=True, text=True)
    err = [json.loads(l)["message"] for l in proc.stdout.splitlines() if l.startswith('{"type": "error"')]
    if proc.returncode != 0 or err:
        raise RuntimeError(err[0] if err else proc.stderr[-800:])


def note_f1(pred, ref, tol=0.06):
    used, tp = set(), 0
    for p in pred:
        for i, r in enumerate(ref):
            if i not in used and r["pitch"] == p["pitch"] and abs(r["start"] - p["start"]) <= tol:
                used.add(i)
                tp += 1
                break
    prec, rec = tp / max(1, len(pred)), tp / max(1, len(ref))
    return prec, rec, 2 * prec * rec / max(1e-9, prec + rec)


def chord_accuracy(chords, ref, step=0.1):
    t, hits, total = 0.0, 0, 0
    end = max(r["end"] for r in ref)
    while t < end:
        rn = next((r["name"] for r in ref if r["start"] <= t < r["end"]), None)
        pn = next((c["name"] for c in chords if c["start"] <= t < c["end"]), None)
        if rn:
            total += 1
            hits += pn == rn
        t += step
    return hits / max(1, total)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--keep", action="store_true", help="keep the generated audio")
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="stemkit-tabtest-")
    truth = build(tmp)
    mix = os.path.join(tmp, "mix.wav")
    ok = True

    def check(label, value, minimum, hard=True):
        nonlocal ok
        flag = "ok " if value >= minimum else ("LOW" if hard else "warn")
        if value < minimum and hard:
            ok = False
        print(f"  [{flag}] {label}: {value:.3f} (min {minimum})")

    print("bass · lead engine")
    out = os.path.join(tmp, "bass.json")
    run_engine(args.python, ["--input", os.path.join(tmp, "bass.wav"), "--mix", mix, "--out", out, "--instrument", "bass"])
    data = json.load(open(out))
    print(f"  engine: {data['engine']} · bpm {data['bpm']} · phase {data['downbeatPhase']}")
    check("note F1", note_f1(data["notes"], truth["bass"])[2], 0.9)
    check("bpm within 1%", 1.0 if abs(data["bpm"] - BPM) / BPM < 0.01 else 0.0, 1.0)
    # downbeat detection is a heuristic (chord-change votes + accents); the UI
    # exposes a one-click override, so a miss here is a warning, not a failure
    check("downbeat phase == 0", 1.0 if data["downbeatPhase"] == 0 else 0.0, 1.0, hard=False)

    for mode, minimum in (("poly", 0.9), ("lead", 0.85)):
        print(f"guitar · {mode}")
        out = os.path.join(tmp, f"lead_{mode}.json")
        run_engine(args.python, ["--input", os.path.join(tmp, "lead.wav"), "--mix", mix, "--out", out, "--instrument", "guitar", "--mode", mode])
        data = json.load(open(out))
        print(f"  engine: {data['engine']}")
        check("note F1", note_f1(data["notes"], truth["lead"])[2], minimum)

    print("guitar · chord")
    out = os.path.join(tmp, "chords.json")
    run_engine(args.python, ["--input", os.path.join(tmp, "chords.wav"), "--mix", mix, "--out", out, "--instrument", "guitar", "--mode", "chord"])
    data = json.load(open(out))
    check("chord accuracy", chord_accuracy(data["chords"], truth["chords"]), 0.9)
    strums = len(set(n["start"] for n in data["notes"]))
    check("strum count within 15%", 1.0 if abs(strums - 32) <= 5 else 0.0, 1.0)

    print("midi import")
    import pretty_midi
    pm = pretty_midi.PrettyMIDI(initial_tempo=BPM)
    inst = pretty_midi.Instrument(program=27, name="Clean Guitar")
    for nt in truth["lead"]:
        inst.notes.append(pretty_midi.Note(velocity=90, pitch=nt["pitch"], start=nt["start"], end=nt["end"]))
    pm.instruments.append(inst)
    midi_path = os.path.join(tmp, "lead.mid")
    pm.write(midi_path)
    out = os.path.join(tmp, "midi.json")
    run_engine(args.python, ["--from-midi", midi_path, "--midi-track", "0", "--input", os.path.join(tmp, "lead.wav"), "--out", out, "--instrument", "guitar"])
    data = json.load(open(out))
    check("note F1", note_f1(data["notes"], truth["lead"])[2], 0.99)

    if not args.keep:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)
    else:
        print("material kept in", tmp)
    print("PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
