import argparse
import itertools
import json
import os
import sys
import time
import warnings
import wave

# Prevent OpenMP / thread issues on interpreter shutdown
os.environ["OMP_NUM_THREADS"] = "1"
warnings.filterwarnings("ignore", category=RuntimeWarning)
warnings.filterwarnings("ignore", category=UserWarning)

# Standard E tuning from high to low (String 1 to 6)
# String 1: E4 (64), String 2: B3 (59), String 3: G3 (55), String 4: D3 (50), String 5: A2 (45), String 6: E2 (40)
DEFAULT_TUNING_PITCHES = [64, 59, 55, 50, 45, 40]
DEFAULT_TUNING_NAMES = ["e", "B", "G", "D", "A", "E"]

TUNING_PRESETS = {
    "standard": ([64, 59, 55, 50, 45, 40], ["e", "B", "G", "D", "A", "E"]),
    "drop_d": ([64, 59, 55, 50, 45, 38], ["e", "B", "G", "D", "A", "D"]),
    "half_step_down": ([63, 58, 54, 49, 44, 39], ["eb", "Bb", "Gb", "Db", "Ab", "Eb"]),
    "d_standard": ([62, 57, 53, 48, 43, 38], ["d", "A", "F", "C", "G", "D"]),
    "open_d": ([62, 57, 54, 50, 45, 38], ["d", "A", "F#", "D", "A", "D"]),
    "open_g": ([62, 59, 55, 50, 43, 38], ["d", "B", "G", "D", "G", "D"]),
}

BASS_TUNING_PRESETS = {
    "standard": ([43, 38, 33, 28], ["G", "D", "A", "E"]),
    "drop_d": ([43, 38, 33, 26], ["G", "D", "A", "D"]),
    "half_step_down": ([42, 37, 32, 27], ["Gb", "Db", "Ab", "Eb"]),
    "d_standard": ([41, 36, 31, 26], ["F", "C", "G", "D"]),
    "5_string": ([43, 38, 33, 28, 23], ["G", "D", "A", "E", "B"]),
    "5_string_drop_a": ([43, 38, 33, 28, 21], ["G", "D", "A", "E", "A"]),
}

POSITION_PRESETS = {
    "auto": None,
    "open": 0,    # Frets 0 to 4
    "mid": 5,     # Frets 5 to 9
    "high": 9,    # Frets 9 to 14
    "octave": 12  # Frets 12 to 16
}


def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def fail(message):
    emit(type="error", message=str(message))
    os._exit(1)


def get_wav_duration(path):
    try:
        import soundfile as sf
        info = sf.info(path)
        return float(info.duration)
    except Exception:
        try:
            with wave.open(path, "rb") as w:
                frames = w.getnframes()
                rate = w.getframerate()
                return frames / float(rate)
        except Exception:
            return 0.0


def filter_harmonics_and_clean(raw_notes, min_dur=0.08):
    """
    Filters acoustic overtone artifacts and merges adjacent same-pitch fragments.
    In distorted/electric guitar, strong harmonics at +12 (octave), +19 (octave+fifth),
    and +24 (2 octaves) often trick AMT models into predicting high ghost notes.
    """
    if not raw_notes:
        return []

    # 1. Sort chronologically by start time
    sorted_notes = sorted(raw_notes, key=lambda n: (n[0], n[2]))

    # 2. Filter out microscopic blips
    valid = [n for n in sorted_notes if (n[1] - n[0]) >= min_dur]

    # 3. Suppress overtone ghost notes that overlap with a stronger fundamental
    HARMONIC_INTERVALS = {12, 19, 24, 28}
    clean = []
    for n in valid:
        is_harmonic = False
        n_pitch = int(round(n[2]))
        for other in valid:
            if other is n:
                continue
            other_pitch = int(round(other[2]))
            interval = n_pitch - other_pitch
            if interval in HARMONIC_INTERVALS:
                overlap = min(n[1], other[1]) - max(n[0], other[0])
                if overlap > 0.035:
                    # If other note is lower pitch and of comparable/greater amplitude
                    if n[3] <= other[3] * 1.25:
                        is_harmonic = True
                        break
        if not is_harmonic:
            clean.append(n)

    # 4. Merge rapid sequential fragments of the exact same pitch (gap < 45ms)
    clean.sort(key=lambda x: (int(round(x[2])), x[0]))
    merged = []
    for n in clean:
        n_pitch = int(round(n[2]))
        if merged and int(round(merged[-1][2])) == n_pitch and (n[0] - merged[-1][1]) <= 0.045:
            # Extend note duration
            merged[-1] = (merged[-1][0], max(merged[-1][1], n[1]), n[2], max(merged[-1][3], n[3]))
        else:
            merged.append(n)

    # Final sort chronologically
    merged.sort(key=lambda x: (x[0], x[2]))
    return merged


def get_candidates(pitch, tuning_pitches, max_fret=22):
    cands = []
    for s_idx, open_p in enumerate(tuning_pitches):
        f = pitch - open_p
        if 0 <= f <= max_fret:
            cands.append((s_idx + 1, f))  # 1-indexed: 1 = high E, 6 = low E
    return cands


def solve_position_anchored_tab(note_events, tuning_pitches=DEFAULT_TUNING_PITCHES, forced_position=None, max_fret=22):
    """
    Position-anchored guitar fingering solver.
    Human guitarists play within recognizable 4-fret hand positions (boxes).
    This solver determines the phrase hand anchor and keeps notes strictly within that box,
    enforcing human hand span limits (<= 4 frets) and eliminating erratic neck jumping.
    """
    if not note_events:
        return []

    POSITIONS = [0, 2, 5, 7, 9, 12, 14]

    structured = []
    for n in note_events:
        pitch = int(round(n[2]))
        cands = get_candidates(pitch, tuning_pitches, max_fret)
        if not cands:
            continue
        structured.append({
            "start": round(float(n[0]), 3),
            "end": round(float(n[1]), 3),
            "pitch": pitch,
            "amplitude": round(float(n[3]), 3)
        })

    if not structured:
        return []

    # 1. Cluster notes into time slices (chords / polyphony within 35ms)
    slices = []
    curr_slice = [structured[0]]
    for n in structured[1:]:
        if n["start"] - curr_slice[0]["start"] <= 0.035:
            curr_slice.append(n)
        else:
            slices.append(curr_slice)
            curr_slice = [n]
    if curr_slice:
        slices.append(curr_slice)

    # 2. Partition slices into musical phrases (separated by pauses >= 0.8s)
    phrases = []
    curr_phrase = [slices[0]]
    for s in slices[1:]:
        if s[0]["start"] - curr_phrase[-1][-1]["end"] >= 0.8:
            phrases.append(curr_phrase)
            curr_phrase = [s]
        else:
            curr_phrase.append(s)
    if curr_phrase:
        phrases.append(curr_phrase)

    assigned_notes = []
    prev_P = None
    prev_single_note = None

    for phrase in phrases:
        phrase_notes = [n for s in phrase for n in s]

        if forced_position is not None:
            best_P = forced_position
        else:
            # Score candidate positions P
            pos_scores = {}
            for P in POSITIONS:
                # Natural bias toward lower/open positions (frets 0-4)
                score = P * 0.4
                # Position inertia: strongly discourage hopping between positions for nearby phrases
                if prev_P is not None:
                    score += abs(P - prev_P) * 2.0
                for n in phrase_notes:
                    cands = get_candidates(n["pitch"], tuning_pitches, max_fret)
                    best_dist = float("inf")
                    for s, f in cands:
                        if f == 0:
                            d = 0.2  # Open string is always accessible
                        elif P <= f <= P + 4:
                            d = 0.0  # In-position box
                        elif f < P:
                            d = (P - f) * 2.5
                        else:
                            d = (f - (P + 4)) * 3.5
                        if d < best_dist:
                            best_dist = d
                    score += best_dist
                pos_scores[P] = score

            best_P = min(pos_scores, key=pos_scores.get)
            prev_P = best_P

        # Assign fingerings within the phrase anchored to best_P
        for s in phrase:
            if len(s) == 1:
                n = s[0]
                cands = get_candidates(n["pitch"], tuning_pitches, max_fret)
                if not cands:
                    continue

                def cand_rank(c):
                    s_num, f = c
                    in_box = (f == 0) or (best_P <= f <= best_P + 4)
                    dist = 0.0 if in_box else abs(f - (best_P + 2))
                    # Penalize high frets when in lower positions
                    high_penalty = max(0, f - 5) * 3.0 if best_P <= 2 else 0.0
                    open_bonus = -0.5 if (f == 0 and best_P <= 2) else 0.0
                    # Hand continuity: encourage adjacent frets / strings from immediately previous note
                    trans_cost = 0.0
                    if prev_single_note is not None:
                        ps, pf = prev_single_note
                        if pf > 0 and f > 0:
                            trans_cost = abs(f - pf) * 0.6 + abs(s_num - ps) * 0.3
                    return (0 if in_box else 1, dist + high_penalty + open_bonus + trans_cost, s_num)

                cands.sort(key=cand_rank)
                chosen_s, chosen_f = cands[0]
                prev_single_note = (chosen_s, chosen_f)
                assigned_notes.append({
                    "string": chosen_s,
                    "fret": chosen_f,
                    "pitch": n["pitch"],
                    "start": n["start"],
                    "end": n["end"],
                    "amplitude": n["amplitude"],
                    "pos": best_P
                })
            else:
                # Multi-note chord: ensure strictly playable hand span and unique strings
                note_cands = [get_candidates(n["pitch"], tuning_pitches, max_fret) for n in s]
                valid_combos = []
                for combo in itertools.product(*note_cands):
                    strings = [c[0] for c in combo]
                    if len(strings) != len(set(strings)):
                        continue  # Two notes on same string is impossible
                    frets = [c[1] for c in combo]
                    fretted = [f for f in frets if f > 0]
                    if fretted:
                        span = max(fretted) - min(fretted)
                        if span > 4:
                            continue  # Hand span exceeds 4 frets: impossible
                        hand_pos = min(fretted)
                        pos_shift = abs(hand_pos - best_P)
                        high_fret_penalty = sum(max(0, f - 5) * 3.0 for f in fretted) if best_P <= 2 else 0.0
                        cost = span * 3.0 + pos_shift * 2.0 + high_fret_penalty
                    else:
                        cost = 0.0
                    valid_combos.append((cost, combo))

                if valid_combos:
                    valid_combos.sort(key=lambda x: x[0])
                    best_combo = valid_combos[0][1]
                    for n, (s_num, f_num) in zip(s, best_combo):
                        assigned_notes.append({
                            "string": s_num,
                            "fret": f_num,
                            "pitch": n["pitch"],
                            "start": n["start"],
                            "end": n["end"],
                            "amplitude": n["amplitude"],
                            "pos": best_P
                        })
                else:
                    # If multi-note combo is unplayable within 4 frets (e.g. overtone/bleed):
                    # Keep the strongest note (fundamental/melody) and discard impossible ghost note
                    sorted_by_amp = sorted(s, key=lambda x: x["amplitude"], reverse=True)
                    strongest = sorted_by_amp[0]
                    cands = get_candidates(strongest["pitch"], tuning_pitches, max_fret)
                    if cands:
                        cands.sort(key=lambda c: (
                            0 if (c[1] == 0 or abs(c[1] - best_P) <= 4) else 1,
                            abs(c[1] - best_P)
                        ))
                        chosen_s, chosen_f = cands[0]
                        assigned_notes.append({
                            "string": chosen_s,
                            "fret": chosen_f,
                            "pitch": strongest["pitch"],
                            "start": strongest["start"],
                            "end": strongest["end"],
                            "amplitude": strongest["amplitude"],
                            "pos": best_P
                        })

    assigned_notes.sort(key=lambda x: (x["start"], x["string"]))
    return assigned_notes


def generate_quantized_ascii_tab(notes, string_names=DEFAULT_TUNING_NAMES, bpm=120, total_duration=0):
    """
    Rhythmically quantizes notes onto a 16th-note musical grid (4 beats per bar,
    16 subdivisions per measure) and formats clean 2-measure tab blocks.
    """
    import numpy as np

    if not notes:
        return "\n".join(f"{name} |---|" for name in string_names)

    bpm = max(45.0, min(240.0, bpm))
    beat_dur = 60.0 / bpm
    bar_dur = beat_dur * 4.0
    step_dur = beat_dur / 4.0  # 16th-note step

    max_time = max(total_duration, max((n["end"] for n in notes), default=0.0))
    total_bars = max(1, int(np.ceil(max_time / bar_dur)))

    systems = []
    STEPS_PER_BAR = 16

    for bar_pair in range(0, total_bars, 2):
        b1 = bar_pair
        b2 = bar_pair + 1
        t_start = b1 * bar_dur
        t_end = (b2 + 1) * bar_dur

        bar1_notes = [n for n in notes if b1 * bar_dur <= n["start"] < (b1 + 1) * bar_dur]
        bar2_notes = [n for n in notes if (b1 + 1) * bar_dur <= n["start"] < (b2 + 1) * bar_dur]

        # Build grid for bar 1
        grid1 = {s: ["-"] * STEPS_PER_BAR for s in range(1, 7)}
        for n in bar1_notes:
            rel_t = n["start"] - (b1 * bar_dur)
            step = int(round(rel_t / step_dur))
            step = max(0, min(STEPS_PER_BAR - 1, step))
            grid1[n["string"]][step] = str(n["fret"])

        # Build grid for bar 2
        grid2 = {s: ["-"] * STEPS_PER_BAR for s in range(1, 7)}
        for n in bar2_notes:
            rel_t = n["start"] - ((b1 + 1) * bar_dur)
            step = int(round(rel_t / step_dur))
            step = max(0, min(STEPS_PER_BAR - 1, step))
            grid2[n["string"]][step] = str(n["fret"])

        min_start = int(t_start // 60)
        sec_start = int(t_start % 60)
        min_end = int(min(max_time, t_end) // 60)
        sec_end = int(min(max_time, t_end) % 60)
        header = f"[{min_start:02d}:{sec_start:02d} - {min_end:02d}:{sec_end:02d}] Bar {b1 + 1} - {min(total_bars, b2 + 1)}"

        lines = [header]
        for s_idx, s_name in enumerate(string_names):
            s_num = s_idx + 1
            b1_str = "".join(grid1[s_num])
            b2_str = "".join(grid2[s_num])
            lines.append(f"{s_name:2s} |{b1_str}|{b2_str}|")

        systems.append("\n".join(lines))

    return "\n\n".join(systems)


def export_guitar_tab_midi(assigned_notes, out_midi_path, bpm=120, instrument="guitar", tuning_pitches=None):
    try:
        import pretty_midi

        pm = pretty_midi.PrettyMIDI(initial_tempo=bpm)
        is_bass = (instrument == "bass")
        program_name = "Electric Bass (finger)" if is_bass else "Acoustic Guitar (steel)"
        prog = pretty_midi.instrument_name_to_program(program_name)

        num_strings = len(tuning_pitches) if tuning_pitches else (4 if is_bass else 6)
        label_prefix = "Bass String" if is_bass else "Guitar String"
        instruments = [
            pretty_midi.Instrument(program=prog, name=f"{label_prefix} {s}")
            for s in range(1, num_strings + 1)
        ]

        for n in assigned_notes:
            string_idx = max(0, min(num_strings - 1, n["string"] - 1))
            vel = int(round(max(25, min(127, n.get("amplitude", 0.8) * 127))))
            note = pretty_midi.Note(
                velocity=vel,
                pitch=n["pitch"],
                start=n["start"],
                end=max(n["start"] + 0.06, n["end"])
            )
            instruments[string_idx].notes.append(note)

        for inst in instruments:
            if inst.notes:
                pm.instruments.append(inst)

        pm.write(out_midi_path)
        return True
    except Exception as e:
        warnings.warn(f"Failed to export MIDI: {e}")
        return False


GUITAR_CHORD_VOICINGS = {
    # 6 strings: [low E (6), A (5), D (4), G (3), B (2), high e (1)]
    # -1 means string is not played / muted (x)
    'C':     [-1, 3, 2, 0, 1, 0],
    'C#':    [-1, 4, 3, 1, 2, 1],
    'D':     [-1, -1, 0, 2, 3, 2],
    'D#':    [-1, -1, 1, 3, 4, 3],
    'E':     [0, 2, 2, 1, 0, 0],
    'F':     [1, 3, 3, 2, 1, 1],
    'F#':    [2, 4, 4, 3, 2, 2],
    'G':     [3, 2, 0, 0, 0, 3],
    'G#':    [4, 6, 6, 5, 4, 4],
    'A':     [-1, 0, 2, 2, 2, 0],
    'A#':    [-1, 1, 3, 3, 3, 1],
    'B':     [-1, 2, 4, 4, 4, 2],
    'Cm':    [-1, 3, 5, 5, 4, 3],
    'C#m':   [-1, 4, 6, 6, 5, 4],
    'Dm':    [-1, -1, 0, 2, 3, 1],
    'D#m':   [-1, -1, 1, 3, 4, 2],
    'Em':    [0, 2, 2, 0, 0, 0],
    'Fm':    [1, 3, 3, 1, 1, 1],
    'F#m':   [2, 4, 4, 2, 2, 2],
    'Gm':    [3, 5, 5, 3, 3, 3],
    'G#m':   [4, 6, 6, 4, 4, 4],
    'Am':    [-1, 0, 2, 2, 1, 0],
    'A#m':   [-1, 1, 3, 3, 2, 1],
    'Bm':    [-1, 2, 4, 4, 3, 2],
    'Dmaj7': [-1, -1, 0, 2, 2, 2],
    'Cmaj7': [-1, 3, 2, 0, 0, 0],
    'Fmaj7': [-1, -1, 3, 2, 1, 0],
    'G7':    [3, 2, 0, 0, 0, 1],
    'E7':    [0, 2, 0, 1, 0, 0],
    'A7':    [-1, 0, 2, 0, 2, 0],
    'D7':    [-1, -1, 0, 2, 1, 2],
    'B7':    [-1, 2, 1, 2, 0, 2]
}

GUITAR_BARRE_VOICINGS = {
    'C':   [-1, 3, 5, 5, 5, 3],
    'C#':  [-1, 4, 6, 6, 6, 4],
    'D':   [-1, 5, 7, 7, 7, 5],
    'D#':  [-1, 6, 8, 8, 8, 6],
    'E':   [0, 2, 2, 1, 0, 0],
    'F':   [1, 3, 3, 2, 1, 1],
    'F#':  [2, 4, 4, 3, 2, 2],
    'G':   [3, 5, 5, 4, 3, 3],
    'G#':  [4, 6, 6, 5, 4, 4],
    'A':   [5, 7, 7, 6, 5, 5],
    'A#':  [6, 8, 8, 7, 6, 6],
    'B':   [7, 9, 9, 8, 7, 7],
    'Cm':  [-1, 3, 5, 5, 4, 3],
    'C#m': [-1, 4, 6, 6, 5, 4],
    'Dm':  [-1, 5, 7, 7, 6, 5],
    'D#m': [-1, 6, 8, 8, 7, 6],
    'Em':  [0, 2, 2, 0, 0, 0],
    'Fm':  [1, 3, 3, 1, 1, 1],
    'F#m': [2, 4, 4, 2, 2, 2],
    'Gm':  [3, 5, 5, 3, 3, 3],
    'G#m': [4, 6, 6, 4, 4, 4],
    'Am':  [5, 7, 7, 5, 5, 5],
    'A#m': [6, 8, 8, 6, 6, 6],
    'Bm':  [7, 9, 9, 7, 7, 7],
}

GUITAR_POWER_VOICINGS = {
    'C':   [-1, 3, 5, 5, -1, -1],
    'C#':  [-1, 4, 6, 6, -1, -1],
    'D':   [-1, 5, 7, 7, -1, -1],
    'D#':  [-1, 6, 8, 8, -1, -1],
    'E':   [0, 2, 2, -1, -1, -1],
    'F':   [1, 3, 3, -1, -1, -1],
    'F#':  [2, 4, 4, -1, -1, -1],
    'G':   [3, 5, 5, -1, -1, -1],
    'G#':  [4, 6, 6, -1, -1, -1],
    'A':   [5, 7, 7, -1, -1, -1],
    'A#':  [6, 8, 8, -1, -1, -1],
    'B':   [7, 9, 9, -1, -1, -1],
    'Cm':  [-1, 3, 5, 5, -1, -1],
    'C#m': [-1, 4, 6, 6, -1, -1],
    'Dm':  [-1, 5, 7, 7, -1, -1],
    'D#m': [-1, 6, 8, 8, -1, -1],
    'Em':  [0, 2, 2, -1, -1, -1],
    'Fm':  [1, 3, 3, -1, -1, -1],
    'F#m': [2, 4, 4, -1, -1, -1],
    'Gm':  [3, 5, 5, -1, -1, -1],
    'G#m': [4, 6, 6, -1, -1, -1],
    'Am':  [5, 7, 7, -1, -1, -1],
    'A#m': [6, 8, 8, -1, -1, -1],
    'Bm':  [7, 9, 9, -1, -1, -1],
}

CHORD_TEMPLATES = {
    'C':     [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0],
    'C#':    [0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0],
    'D':     [0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0],
    'D#':    [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0],
    'E':     [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1],
    'F':     [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0],
    'F#':    [0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0],
    'G':     [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1],
    'G#':    [1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
    'A':     [0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
    'A#':    [0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    'B':     [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1],
    'Cm':    [1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0],
    'C#m':   [0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    'Dm':    [0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0],
    'D#m':   [0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0],
    'Em':    [0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1],
    'Fm':    [1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0],
    'F#m':   [0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0],
    'Gm':    [0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0],
    'G#m':   [0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1],
    'Am':    [1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
    'A#m':   [0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
    'Bm':    [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    'Dmaj7': [0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1],
    'Cmaj7': [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1],
    'Fmaj7': [1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0],
    'G7':    [0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1],
    'E7':    [0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 1],
    'A7':    [1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0],
    'D7':    [1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0],
    'B7':    [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1]
}


def generate_chord_ascii_tab(measures, string_names=DEFAULT_TUNING_NAMES):
    """
    Renders structured ASCII tablature with chord names printed above each measure.
    """
    if not measures:
        return "\n".join(f"{s}|---|" for s in string_names)

    lines_output = []
    bars_per_line = 3
    for chunk_start in range(0, len(measures), bars_per_line):
        chunk = measures[chunk_start:chunk_start + bars_per_line]

        # Header with chord names and bar numbers
        header_parts = ["    "]
        for m in chunk:
            chord_label = f"Bar {m['number']}: {m.get('chord', '')}"
            header_parts.append(f"{chord_label:<24}")
        lines_output.append("".join(header_parts))

        # 6 string lines (from high e down to low E)
        for s_idx, s_name in enumerate(string_names):
            string_num = s_idx + 1  # 1 = high e, 6 = low E
            row_parts = [f"{s_name:2s}|"]
            for m in chunk:
                s_notes = [n for n in m.get("notes", []) if n["string"] == string_num]
                if s_notes:
                    fret_str = str(s_notes[0]["fret"])
                    bar_str = f"--{fret_str:2s}----{fret_str:2s}----{fret_str:2s}----{fret_str:2s}--|"
                else:
                    bar_str = "------------------------|"
                row_parts.append(bar_str)
            lines_output.append("".join(row_parts))

        lines_output.append("")

    return "\n".join(lines_output)


def transcribe_chord_and_rhythm_tabs(
    audio_path,
    tuning_pitches=DEFAULT_TUNING_PITCHES,
    tuning_names=DEFAULT_TUNING_NAMES,
    voicing_style="standard",
    total_duration=0.0
):
    import librosa
    import numpy as np
    from collections import Counter

    emit(type="progress", pct=15, message="Analyzing harmonic spectrum & rhythmic beat grid…")
    y, sr = librosa.load(audio_path, sr=22050)
    actual_dur = len(y) / float(sr)
    if total_duration <= 0:
        total_duration = actual_dur

    y_harmonic, _ = librosa.effects.hpss(y)

    emit(type="progress", pct=35, message="Tracking beats, tempo & measure structure…")
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr)
    bpm = round(float(np.atleast_1d(tempo)[0]), 1)
    if bpm < 45.0 or bpm > 240.0:
        bpm = 120.0
    beat_times = librosa.frames_to_time(beats, sr=sr)
    if len(beat_times) < 4:
        beat_dur = 60.0 / bpm
        beat_times = np.arange(0, total_duration, beat_dur)

    emit(type="progress", pct=55, message="Matching guitar chord progressions across measures…")
    fmin = librosa.note_to_hz("E2")
    chroma = librosa.feature.chroma_cqt(y=y_harmonic, sr=sr, fmin=fmin, n_octaves=5, bins_per_octave=24)
    if len(beats) > 1:
        chroma_sync = librosa.util.sync(chroma, beats, aggregate=np.median)
    else:
        chroma_sync = chroma

    template_names = list(CHORD_TEMPLATES.keys())
    template_matrix = np.array([CHORD_TEMPLATES[k] for k in template_names], dtype=np.float32)
    template_matrix /= np.linalg.norm(template_matrix, axis=1, keepdims=True)

    num_cols = min(len(beat_times), chroma_sync.shape[1])
    sim_matrix = np.zeros((len(template_names), num_cols), dtype=np.float32)

    for col in range(num_cols):
        c = chroma_sync[:, col]
        norm = np.linalg.norm(c)
        if norm > 1e-3:
            sim_matrix[:, col] = np.dot(template_matrix, c / norm)
        else:
            sim_matrix[:, col] = 0.0

    # Viterbi decoding with temporal inertia (musical chord continuity)
    path = []
    prev_idx = int(np.argmax(sim_matrix[:, 0])) if num_cols > 0 else 0
    for col in range(num_cols):
        scores = sim_matrix[:, col].copy()
        scores[prev_idx] += 0.22
        best = int(np.argmax(scores))
        path.append(template_names[best])
        prev_idx = best

    while len(path) < len(beat_times):
        path.append(path[-1] if path else "D")

    emit(type="progress", pct=75, message="Voicing authentic guitar grips & rhythm strums…")

    if voicing_style == "power":
        voicings = GUITAR_POWER_VOICINGS
    elif voicing_style == "barre":
        voicings = GUITAR_BARRE_VOICINGS
    else:
        voicings = GUITAR_CHORD_VOICINGS

    measures = []
    assigned_notes = []
    bar_dur = 4.0 * (60.0 / bpm)
    total_bars = int(np.ceil(total_duration / bar_dur)) if bar_dur > 0 else 1

    for b in range(total_bars):
        m_start = round(b * bar_dur, 3)
        m_end = round((b + 1) * bar_dur, 3)

        b_indices = [i for i, bt in enumerate(beat_times) if m_start <= bt < m_end]
        if b_indices:
            m_chords = [path[i] for i in b_indices if i < len(path)]
            dominant_chord = Counter(m_chords).most_common(1)[0][0] if m_chords else "D"
            strum_times = [beat_times[i] for i in b_indices]
        else:
            dominant_chord = path[min(b * 4, len(path) - 1)] if path else "D"
            strum_times = [m_start + i * (bar_dur / 4.0) for i in range(4)]

        voicing = voicings.get(dominant_chord, voicings.get("D", [-1] * 6))

        m_notes = []
        strum_dur = (60.0 / bpm) * 0.75

        for st in strum_times:
            if st >= total_duration:
                continue
            for s_idx, fret in enumerate(voicing):
                if fret >= 0:
                    string_num = 6 - s_idx  # 1 = high e, 6 = low E
                    open_pitch = tuning_pitches[string_num - 1]
                    pitch = open_pitch + fret
                    n_start = round(float(st), 3)
                    n_end = round(float(st + strum_dur), 3)
                    note_obj = {
                        "string": string_num,
                        "fret": fret,
                        "pitch": pitch,
                        "start": n_start,
                        "end": n_end,
                        "amplitude": 0.85,
                        "chord": dominant_chord
                    }
                    m_notes.append(note_obj)
                    assigned_notes.append(note_obj)

        measures.append({
            "number": b + 1,
            "start": m_start,
            "end": m_end,
            "chord": dominant_chord,
            "notes": m_notes
        })

    emit(type="progress", pct=88, message="Generating formatted chord tablature…")
    ascii_tab = generate_chord_ascii_tab(measures, string_names=tuning_names)

    return bpm, assigned_notes, measures, ascii_tab


def build_measures(assigned_notes, bpm=120, total_duration=0):
    import numpy as np

    bpm = max(45.0, min(240.0, bpm))
    beat_dur = 60.0 / bpm
    bar_dur = beat_dur * 4.0
    max_time = max(total_duration, max((n["end"] for n in assigned_notes), default=0.0))
    total_bars = max(1, int(np.ceil(max_time / bar_dur)))

    measures = []
    for b in range(total_bars):
        b_start = round(b * bar_dur, 3)
        b_end = round((b + 1) * bar_dur, 3)
        m_notes = [n for n in assigned_notes if b_start <= n["start"] < b_end]
        measures.append({
            "number": b + 1,
            "start": b_start,
            "end": b_end,
            "notes": m_notes
        })
    return measures


def main():
    parser = argparse.ArgumentParser(description="Transcribe guitar/bass audio stem into playable tablature")
    parser.add_argument("--input", required=True, help="Path to audio WAV file")
    parser.add_argument("--out", required=True, help="Path to output tabs JSON")
    parser.add_argument("--instrument", default="guitar", choices=["guitar", "bass"], help="Instrument type (guitar or bass)")
    parser.add_argument("--mode", default="chord", choices=["chord", "note"], help="Transcription mode: chord (default) or note (Basic Pitch)")
    parser.add_argument("--voicing", default="standard", choices=["standard", "barre", "power"], help="Guitar chord voicing style")
    parser.add_argument("--tuning", default="standard", help="Tuning preset (standard, drop_d, half_step_down, etc.)")
    parser.add_argument("--position", default="auto", help="Position anchor preset (auto, open, mid, high, octave)")
    parser.add_argument("--sensitivity", default="clean", help="Detection mode: clean (default) or sensitive")
    parser.add_argument("--onset-thresh", type=float, default=None, help="Onset activation threshold")
    parser.add_argument("--frame-thresh", type=float, default=None, help="Frame activation threshold")
    parser.add_argument("--min-note-len", type=int, default=None, help="Minimum note length in milliseconds")
    parser.add_argument("--device", default="auto", help="Compute device (auto, cpu, cuda)")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        fail(f"Input file does not exist: {args.input}")

    total_duration = get_wav_duration(args.input)
    is_bass = (args.instrument == "bass")

    # Tuning selection
    tuning_key = args.tuning.lower()
    if is_bass:
        if tuning_key in BASS_TUNING_PRESETS:
            tuning_pitches, tuning_names = BASS_TUNING_PRESETS[tuning_key]
        else:
            tuning_pitches, tuning_names = BASS_TUNING_PRESETS["standard"]
    else:
        if tuning_key in TUNING_PRESETS:
            tuning_pitches, tuning_names = TUNING_PRESETS[tuning_key]
        else:
            tuning_pitches, tuning_names = TUNING_PRESETS["standard"]

    # Bass is naturally monophonic single-note groove playing
    if is_bass or args.mode == "note":
        emit(type="progress", pct=5, message=f"Loading Basic Pitch {'bass' if is_bass else 'guitar'} solver…")
        forced_pos = POSITION_PRESETS.get(args.position.lower(), None)
        is_sensitive = args.sensitivity.lower() == "sensitive"
        onset_thresh = args.onset_thresh if args.onset_thresh is not None else (0.50 if is_sensitive else 0.60)
        frame_thresh = args.frame_thresh if args.frame_thresh is not None else (0.32 if is_sensitive else 0.40)
        min_note_len = args.min_note_len if args.min_note_len is not None else (65 if is_sensitive else (85 if is_bass else 90))

        try:
            from basic_pitch.inference import predict
        except ImportError:
            fail("basic-pitch is not installed in the Python environment.")

        emit(type="progress", pct=10, message=f"Analyzing {'bass' if is_bass else 'guitar'} track & estimating tempo…")

        bpm = 120.0
        try:
            import soundfile as sf
            import librosa
            import numpy as np

            sample_dur = min(45.0, total_duration) if total_duration > 0 else 45.0
            frames_to_read = int(sample_dur * 44100)
            audio_data, sr = sf.read(args.input, frames=frames_to_read)
            if audio_data.ndim > 1:
                audio_data = audio_data.mean(axis=1)

            tempo, _ = librosa.beat.beat_track(y=audio_data, sr=sr)
            detected_bpm = float(tempo[0]) if isinstance(tempo, (list, np.ndarray)) else float(tempo)
            if 45.0 <= detected_bpm <= 240.0:
                bpm = round(detected_bpm, 1)
        except Exception as e:
            emit(type="info", message=f"Tempo detection fallback used: {e}")

        emit(type="progress", pct=25, message=f"Detecting clean {'bass' if is_bass else 'guitar'} notes ({bpm} BPM)…")

        min_freq = 30.0 if is_bass else 75.0
        max_freq = 650.0 if is_bass else 1250.0

        try:
            model_output, midi_data, raw_notes = predict(
                args.input,
                onset_threshold=onset_thresh,
                frame_threshold=frame_thresh,
                minimum_note_length=min_note_len,
                minimum_frequency=min_freq,
                maximum_frequency=max_freq,
                melodia_trick=True
            )
        except Exception as e:
            fail(f"Basic Pitch transcription failed: {e}")

        emit(type="progress", pct=60, message="Filtering acoustic overtones & ghost notes…")
        clean_notes = filter_harmonics_and_clean(raw_notes, min_dur=0.08)

        emit(type="progress", pct=75, message=f"Solving ergonomic hand positions for {len(clean_notes)} notes…")
        assigned_notes = solve_position_anchored_tab(
            clean_notes,
            tuning_pitches=tuning_pitches,
            forced_position=forced_pos,
            max_fret=24 if is_bass else 22
        )

        emit(type="progress", pct=88, message="Quantizing measures onto musical 16th-note grid…")
        measures = build_measures(assigned_notes, bpm=bpm, total_duration=total_duration)
        ascii_tab = generate_quantized_ascii_tab(
            assigned_notes,
            string_names=tuning_names,
            bpm=bpm,
            total_duration=total_duration
        )
        model_name = f"Spotify Basic Pitch + Position-Anchored {'Bass' if is_bass else 'Fretboard'} Solver"
    else:
        # Guitar chord mode
        emit(type="progress", pct=5, message="Starting Chord-Aware & Rhythm Guitar Tab Engine…")
        bpm, assigned_notes, measures, ascii_tab = transcribe_chord_and_rhythm_tabs(
            args.input,
            tuning_pitches=tuning_pitches,
            tuning_names=tuning_names,
            voicing_style=args.voicing,
            total_duration=total_duration
        )
        model_name = "StemKit Chord-Aware & Rhythm Tab Engine (Authentic Voicings)"

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    midi_path = os.path.splitext(args.out)[0] + ".mid"
    export_guitar_tab_midi(assigned_notes, midi_path, bpm=bpm, instrument=args.instrument, tuning_pitches=tuning_pitches)

    emit(type="progress", pct=95, message=f"Writing {'bass' if is_bass else 'guitar'} tablature data…")

    out_data = {
        "instrument": args.instrument,
        "model": model_name,
        "bpm": bpm,
        "mode": "note" if is_bass else args.mode,
        "voicingStyle": args.voicing,
        "tuning": tuning_names,
        "tuningPitches": tuning_pitches,
        "positionAnchor": args.position,
        "sensitivity": args.sensitivity,
        "duration": round(total_duration, 2),
        "notesCount": len(assigned_notes),
        "midiPath": midi_path if os.path.isfile(midi_path) else None,
        "notes": assigned_notes,
        "measures": measures,
        "asciiTab": ascii_tab
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out_data, f, ensure_ascii=False, indent=2)

    emit(type="progress", pct=100, message=f"Playable {'bass' if is_bass else 'guitar'} tablature ready")
    emit(
        type="done",
        out=args.out,
        midi=midi_path,
        notes_count=len(assigned_notes),
        bpm=bpm
    )
    # Clean exit without OpenMP/static destructor mutex locks on Python 3.14
    os._exit(0)


if __name__ == "__main__":
    main()
