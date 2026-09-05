import argparse
import json
import os
import sys
import time
import warnings
import wave

warnings.filterwarnings("ignore", category=RuntimeWarning)


def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def fail(message):
    emit(type="error", message=str(message))
    sys.exit(1)


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


def process_whisper_segments(raw_segments):
    """
    Transforms raw Whisper segments into cleanly unified lyrics phrases.
    Preserves Whisper's natural grammatical and melodic phrasing while fixing
    Whisper DTW edge-stretching artifacts (where the first word after an instrumental
    pause is erroneously timestamped back across the silence).
    """
    lines = []
    
    for seg in raw_segments:
        seg_text = seg.text.strip()
        if not seg_text:
            continue

        words = []
        if seg.words:
            for w in seg.words:
                cw = w.word.strip()
                if cw:
                    start = round(float(w.start), 2)
                    end = max(start + 0.05, round(float(w.end), 2))
                    words.append({
                        "word": cw,
                        "start": start,
                        "end": end,
                        "probability": round(float(getattr(w, "probability", 1.0)), 2)
                    })
        else:
            split_words = seg_text.split()
            n = len(split_words)
            if n > 0:
                seg_dur = max(0.1, float(seg.end) - float(seg.start))
                w_dur = seg_dur / n
                for idx, sw in enumerate(split_words):
                    s = round(float(seg.start) + idx * w_dur, 2)
                    e = max(s + 0.05, round(float(seg.start) + (idx + 1) * w_dur, 2))
                    words.append({
                        "word": sw,
                        "start": s,
                        "end": e,
                        "probability": 0.8
                    })

        if not words:
            continue

        # 1. Fix DTW First-Word Edge Artifact:
        # If the first word is dragged back across a silence gap (> 1.2s) before the second word,
        # anchor the first word so it immediately precedes the second word.
        if len(words) >= 2:
            first_gap = words[1]["start"] - words[0]["end"]
            if first_gap > 1.2:
                w1_start = words[1]["start"]
                estimated_dur = min(0.6, max(0.2, words[0]["end"] - words[0]["start"]))
                words[0]["end"] = round(w1_start - 0.05, 2)
                words[0]["start"] = round(max(0.0, words[0]["end"] - estimated_dur), 2)

            # Also check if words[0] duration was bloated across preceding silence
            short_intro_tokens = {"the", "a", "an", "and", "if", "in", "on", "it", "so", "but", "to", "or", "i", "i'm"}
            if words[0]["word"].lower() in short_intro_tokens and (words[0]["end"] - words[0]["start"] > 1.5):
                words[0]["start"] = round(max(0.0, words[0]["end"] - 0.4), 2)

        # 2. Split on massive internal instrumental gaps (> 3.0s) if any exist within a single segment
        current_sub = []
        for w in words:
            if current_sub:
                gap = w["start"] - current_sub[-1]["end"]
                if gap > 3.0:
                    lines.append({
                        "start": current_sub[0]["start"],
                        "end": current_sub[-1]["end"],
                        "text": " ".join(cw["word"] for cw in current_sub),
                        "words": current_sub
                    })
                    current_sub = [w]
                    continue
            current_sub.append(w)

        if current_sub:
            lines.append({
                "start": current_sub[0]["start"],
                "end": current_sub[-1]["end"],
                "text": " ".join(cw["word"] for cw in current_sub),
                "words": current_sub
            })

    return lines


def main():
    parser = argparse.ArgumentParser(description="Transcribe vocal stem with word timestamps")
    parser.add_argument("--input", required=True, help="Path to vocal WAV file")
    parser.add_argument("--out", required=True, help="Path to output lyrics JSON")
    parser.add_argument("--model", default="large-v3-turbo", help="Whisper model size (base, small, medium, large-v3-turbo)")
    parser.add_argument("--language", default=None, help="Language code (optional, auto-detected if omitted)")
    parser.add_argument("--device", default="auto", help="Compute device (auto, cpu, cuda)")
    args = parser.parse_args()

    if not os.path.isfile(args.input):
        fail(f"Input file does not exist: {args.input}")

    total_duration = get_wav_duration(args.input)

    emit(type="progress", pct=0, message=f"Loading Whisper model ({args.model})…")

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        fail("faster-whisper is not installed. Please install it in the Python environment.")

    # Determine device and compute type
    device = args.device
    compute_type = "int8"
    if device == "auto":
        import torch
        if torch.cuda.is_available():
            device = "cuda"
            compute_type = "float16"
        else:
            device = "cpu"
            compute_type = "int8"
    elif device == "cuda":
        compute_type = "float16"

    try:
        model = WhisperModel(args.model, device=device, compute_type=compute_type)
    except Exception as e:
        fail(f"Failed to load Whisper model: {e}")

    emit(type="progress", pct=10, message="Preparing and normalizing vocal audio…")

    try:
        import soundfile as sf
        import torch
        import torchaudio.functional as F

        # Load clean isolated vocals, downmix to mono, and resample to 16kHz
        raw_data, in_sr = sf.read(args.input, dtype="float32")
        if raw_data.ndim > 1:
            raw_data = raw_data.mean(axis=1)

        tensor_audio = torch.from_numpy(raw_data).unsqueeze(0)
        if in_sr != 16000:
            tensor_audio = F.resample(tensor_audio, in_sr, 16000)

        # Normalize peak amplitude to prevent clipping or subnormal float issues
        max_peak = torch.max(torch.abs(tensor_audio))
        if max_peak > 1e-5:
            tensor_audio = (tensor_audio / max_peak) * 0.95

        audio_input = tensor_audio.squeeze(0).numpy()

        emit(type="progress", pct=15, message="Transcribing vocals with word-level alignment…")

        # Optimal parameters for singing & music lyrics:
        # - beam_size=5 for maximum phonetic accuracy
        # - condition_on_previous_text=False prevents cascading line hallucinations
        # - vad_filter=True cleanly skips guitar/drum solos without inventing text
        segments_generator, info = model.transcribe(
            audio_input,
            language=args.language,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=450),
            beam_size=5,
            best_of=5,
            condition_on_previous_text=False
        )
    except Exception as e:
        fail(f"Transcription failed: {e}")

    raw_segments = []
    last_report = time.time()

    for seg in segments_generator:
        raw_segments.append(seg)
        now = time.time()
        if now - last_report >= 0.3 and total_duration > 0:
            pct = min(95, int(15 + (seg.end / total_duration) * 80))
            emit(
                type="progress",
                pct=pct,
                message=f"Transcribing lyrics ({int(seg.end)}s / {int(total_duration)}s)…"
            )
            last_report = now

    lines = process_whisper_segments(raw_segments)

    out_data = {
        "model": args.model,
        "language": getattr(info, "language", None),
        "languageProbability": round(getattr(info, "language_probability", 1.0), 2),
        "duration": round(total_duration, 2),
        "lines": lines
    }

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out_data, f, ensure_ascii=False, indent=2)

    emit(type="progress", pct=100, message="Transcription complete")
    emit(type="done", out=args.out, lines_count=len(lines))


if __name__ == "__main__":
    main()
