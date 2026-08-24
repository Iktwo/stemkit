import argparse
import json
import sys
import time
import wave

import numpy as np


def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def fail(message):
    emit(type="error", message=str(message))
    sys.exit(1)


def load_wav(path):
    try:
        with wave.open(path, "rb") as w:
            sr = w.getframerate()
            channels = w.getnchannels()
            width = w.getsampwidth()
            frames = w.readframes(w.getnframes())
    except Exception as e:
        fail(f"cannot read wav {path}: {e}")
    if width == 2:
        audio = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif width == 4:
        audio = np.frombuffer(frames, dtype="<f4").astype(np.float32)
    else:
        fail(f"unsupported sample width {width}")
    if channels == 0:
        fail("empty wav")
    audio = audio.reshape(-1, channels).T
    return audio, sr


def save_wav(path, data, sr):
    interleaved = data.T
    peak = max(1e-9, float(np.abs(interleaved).max()))
    if peak > 1.0:
        interleaved = interleaved / peak * 0.999
    pcm = (interleaved * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(pcm.shape[1])
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--shifts", type=int, default=1)
    parser.add_argument("--overlap", type=float, default=0.25)
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    import torch
    import types

    import demucs.apply as dapply

    raw_tqdm = dapply.tqdm
    is_module = not hasattr(raw_tqdm, "update")
    real_tqdm = raw_tqdm.tqdm if is_module else raw_tqdm

    class ProgressTqdm(real_tqdm):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            self._last = 0.0

        def update(self, n=1):
            super().update(n)
            self._report(False)

        def close(self):
            self._report(True)
            super().close()

        def _report(self, force):
            total = self.total or 0
            if not total:
                return
            frac = min(1.0, max(0.0, self.n / total))
            now = time.time()
            if force or now - self._last >= 0.5:
                emit(type="progress", stage="separate", pct=int(frac * 100))
                self._last = now

    dapply.tqdm = types.SimpleNamespace(tqdm=ProgressTqdm) if is_module else ProgressTqdm

    if args.device == "auto":
        device = "mps" if torch.backends.mps.is_available() else "cpu"
    else:
        device = args.device
    emit(type="progress", stage="model", pct=0, message=f"loading {args.model} on {device}")

    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    try:
        model = get_model(args.model)
    except Exception as e:
        fail(f"model load failed: {e}")
    model.to(device)
    model.eval()

    audio, sr = load_wav(args.input)
    target_sr = model.samplerate
    if sr != target_sr:
        t = torch.from_numpy(audio)
        t = torch.nn.functional.interpolate(
            t.unsqueeze(0), scale_factor=target_sr / sr, mode="linear", align_corners=False
        ).squeeze(0)
        audio = t.numpy()
        sr = target_sr
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)

    mix = torch.from_numpy(audio).to(device)[None]

    emit(type="progress", stage="separate", pct=0, message="separating")
    try:
        sources = apply_model(
            model,
            mix,
            device=device,
            shifts=args.shifts,
            split=True,
            overlap=args.overlap,
            progress=True,
        )
    except Exception as e:
        if device == "mps":
            emit(
                type="progress",
                stage="separate",
                pct=0,
                message=f"mps failed ({e}), falling back to cpu",
            )
            model = model.cpu()
            mix = mix.cpu()
            device = "cpu"
            sources = apply_model(
                model,
                mix,
                device=device,
                shifts=args.shifts,
                split=True,
                overlap=args.overlap,
                progress=True,
            )
        else:
            fail(f"separation failed: {e}")

    import os

    wanted = None
    if args.only:
        wanted = [s.strip() for s in args.only.split(",") if s.strip()]
        unknown = [s for s in wanted if s not in model.sources]
        if unknown:
            fail(f"unknown stems requested: {', '.join(unknown)}")
        if not wanted:
            fail("no valid stems requested")
        emit(type="progress", stage="separate", pct=0, message=f"writing {len(wanted)} stems")

    os.makedirs(args.out, exist_ok=True)
    out_cpu = sources[0].cpu().numpy()
    written = []
    for i, name in enumerate(model.sources):
        if wanted is not None and name not in wanted:
            continue
        path = os.path.join(args.out, f"{name}.wav")
        save_wav(path, out_cpu[i], sr)
        written.append(name)
        emit(type="stem", name=name)

    emit(type="done", stems=written, out_dir=args.out)


if __name__ == "__main__":
    main()
