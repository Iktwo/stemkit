import argparse
import json
import os
import struct
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


def save_wav_f32(path, data, sr):
    """write a 32-bit float wav (fmt tag 3); values above 1.0 are preserved"""
    channels, _ = data.shape
    payload = data.T.astype("<f4").tobytes()
    block_align = channels * 4
    header = b"RIFF" + struct.pack("<I", 36 + len(payload)) + b"WAVE"
    header += b"fmt " + struct.pack(
        "<IHHIIHH", 16, 3, channels, sr, sr * block_align, block_align, 32
    )
    header += b"data" + struct.pack("<I", len(payload))
    with open(path, "wb") as f:
        f.write(header)
        f.write(payload)


save_wav = save_wav_f32


def separate_roformer(audio, sr, out_dir, wanted, device_name="auto"):
    import torch
    import torch.nn as nn
    import yaml
    from ml_collections import ConfigDict
    from bs_roformer import ensure_model_assets, DEFAULT_MODEL
    from bs_roformer.utils import get_model_from_config, get_windowing_array
    from bs_roformer.inference import SafeLoaderWithTuple

    if device_name == "auto":
        device_str = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device_str = device_name

    if device_str == "cuda" and not torch.cuda.is_available():
        fail("GPU engine not available (no NVIDIA GPU, or the CUDA build of torch is not installed)")

    device = torch.device(device_str)
    emit(type="progress", stage="model", pct=0, message=f"loading BS-RoFormer (SOTA 6-stem) on {device_str}")

    try:
        ckpt_path, cfg_path = ensure_model_assets(DEFAULT_MODEL)
        with open(cfg_path) as f:
            config = ConfigDict(yaml.load(f, Loader=SafeLoaderWithTuple))
        model = get_model_from_config("bs_roformer", config)
        state_dict = torch.load(ckpt_path, map_location="cpu")
        model.load_state_dict(state_dict)
        model.to(device)
        model.eval()
    except Exception as e:
        fail(f"BS-RoFormer load failed: {e}")

    target_sr = 44100
    if sr != target_sr:
        t = torch.from_numpy(audio)
        t = torch.nn.functional.interpolate(
            t.unsqueeze(0), scale_factor=target_sr / sr, mode="linear", align_corners=False
        ).squeeze(0)
        audio = t.numpy()
        sr = target_sr

    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)

    instruments = config.training.instruments
    C = getattr(config.inference, "chunk_size", 588800)
    N = getattr(config.inference, "num_overlap", 2)
    step = C // N
    fade_size = C // 10
    border = C - step

    def run_demix(dev):
        mix_t = torch.tensor(audio, dtype=torch.float32)
        if mix_t.shape[1] > 2 * border and border > 0:
            mix_t = nn.functional.pad(mix_t, (border, border), mode="reflect")

        win_arr = get_windowing_array(C, fade_size, dev)
        req_shape = (len(instruments),) + tuple(mix_t.shape)

        mix_dev = mix_t.to(dev)
        res = torch.zeros(req_shape, dtype=torch.float32, device=dev)
        cnt = torch.zeros(req_shape, dtype=torch.float32, device=dev)

        total_len = mix_dev.shape[1]
        cur = 0
        last_report = 0.0

        emit(type="progress", stage="separate", pct=0, message="separating stems with BS-RoFormer")

        with torch.no_grad():
            while cur < total_len:
                part = mix_dev[:, cur : cur + C]
                length = part.shape[-1]
                if length < C:
                    if length > C // 2 + 1:
                        part = nn.functional.pad(input=part, pad=(0, C - length), mode="reflect")
                    else:
                        part = nn.functional.pad(input=part, pad=(0, C - length, 0, 0), mode="constant", value=0)

                x = model(part.unsqueeze(0))[0]
                window = win_arr.clone()
                if cur == 0:
                    window[:fade_size] = 1
                elif cur + C >= total_len:
                    window[-fade_size:] = 1

                res[..., cur : cur + length] += x[..., :length] * window[..., :length]
                cnt[..., cur : cur + length] += window[..., :length]
                cur += step

                now = time.time()
                pct = int(min(1.0, cur / total_len) * 100)
                if now - last_report >= 0.5 or pct == 100:
                    emit(type="progress", stage="separate", pct=pct)
                    last_report = now

        est = (res / cnt).cpu().numpy()
        np.nan_to_num(est, copy=False, nan=0.0)
        if mix_t.shape[1] > 2 * border and border > 0:
            est = est[..., border:-border]
        return est

    try:
        sources = run_demix(device)
    except Exception as e:
        if device_str == "mps":
            emit(type="progress", stage="separate", pct=0, message=f"mps failed ({e}), falling back to cpu")
            device = torch.device("cpu")
            model.to(device)
            sources = run_demix(device)
        elif device_str == "cuda":
            emit(type="progress", stage="separate", pct=0, message=f"cuda failed ({e}), falling back to cpu")
            device = torch.device("cpu")
            model.to(device)
            sources = run_demix(device)
        else:
            fail(f"separation failed: {e}")

    os.makedirs(out_dir, exist_ok=True)
    written = []
    for idx, name in enumerate(instruments):
        if wanted is not None and name not in wanted:
            continue
        stem_path = os.path.join(out_dir, f"{name}.wav")
        save_wav_f32(stem_path, sources[idx], sr)
        written.append(name)
        emit(type="stem", name=name)

    emit(type="done", stems=written, out_dir=out_dir)


def separate_demucs(audio, sr, out_dir, model_name, wanted, device_name="auto", shifts=1, overlap=0.25):
    import torch
    import types
    import demucs.apply as dapply
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    raw_tqdm = dapply.tqdm
    is_module = not hasattr(raw_tqdm, "update")
    real_tqdm = raw_tqdm.tqdm if is_module else raw_tqdm

    # demucs runs one tqdm per "leg" (bag model x shift), each sweeping 0-100
    # on its own. The UI expects a single monotonic sweep for the whole call,
    # so legs are counted globally: pct = (legs_done + leg_frac) / legs.
    # legs_total is filled in once the model is loaded (the patch installs
    # before that point)
    leg_state = {"done": 0, "total": 0, "last": -1.0, "legs": 0}

    class ProgressTqdm(real_tqdm):
        def __init__(self, *a, **kw):
            super().__init__(*a, **kw)
            if self.total:
                leg_state["total"] = self.total

        def update(self, n=1):
            super().update(n)
            self._report(False)

        def close(self):
            self._report(True)
            if self.total and self.n >= self.total:
                leg_state["done"] += 1
            super().close()

        def _report(self, force):
            legs = leg_state["legs"]
            if not legs:
                return
            total = leg_state["total"] or self.total or 0
            if not total:
                return
            frac = min(1.0, max(0.0, self.n / total))
            now = time.time()
            if force or now - leg_state["last"] >= 0.5:
                global_pct = int(
                    ((leg_state["done"] + frac) / legs) * 100
                )
                emit(type="progress", stage="separate", pct=min(99, global_pct))
                leg_state["last"] = now

    dapply.tqdm = types.SimpleNamespace(tqdm=ProgressTqdm) if is_module else ProgressTqdm

    if device_name == "auto":
        device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    else:
        device = device_name
    if device == "cuda" and not torch.cuda.is_available():
        fail("GPU engine not available (no NVIDIA GPU, or the CUDA build of torch is not installed)")
    emit(type="progress", stage="model", pct=0, message=f"loading {model_name} on {device}")

    try:
        model = get_model(model_name)
    except Exception as e:
        fail(f"model load failed: {e}")
    model.to(device)
    model.eval()
    leg_state["legs"] = max(1, len(getattr(model, "models", [1]))) * max(1, shifts)

    target_sr = model.samplerate
    if sr != target_sr:
        import torchaudio

        t = torch.from_numpy(audio)
        t = torchaudio.functional.resample(t, sr, target_sr)
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
            shifts=shifts,
            split=True,
            overlap=overlap,
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
                shifts=shifts,
                split=True,
                overlap=overlap,
                progress=True,
            )
        else:
            fail(f"separation failed: {e}")

    out_cpu = sources[0].cpu().numpy()
    os.makedirs(out_dir, exist_ok=True)
    written = []
    for i, name in enumerate(model.sources):
        if wanted is not None and name not in wanted:
            continue
        path = os.path.join(out_dir, f"{name}.wav")
        save_wav_f32(path, out_cpu[i], sr)
        written.append(name)
        emit(type="stem", name=name)

    emit(type="done", stems=written, out_dir=out_dir)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--model", default="bs_roformer")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--shifts", type=int, default=1)
    parser.add_argument("--overlap", type=float, default=0.25)
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    audio, sr = load_wav(args.input)

    wanted = None
    if args.only:
        wanted = [s.strip() for s in args.only.split(",") if s.strip()]

    is_roformer = "roformer" in args.model.lower()

    if is_roformer:
        valid_sources = ["bass", "drums", "other", "vocals", "guitar", "piano"]
        if wanted:
            unknown = [s for s in wanted if s not in valid_sources]
            if unknown:
                fail(f"unknown stems requested: {', '.join(unknown)}")
        separate_roformer(audio, sr, args.out, wanted, device_name=args.device)
    else:
        separate_demucs(
            audio,
            sr,
            args.out,
            model_name=args.model,
            wanted=wanted,
            device_name=args.device,
            shifts=args.shifts,
            overlap=args.overlap,
        )


if __name__ == "__main__":
    main()
