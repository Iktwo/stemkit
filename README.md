# StemKit

Split any YouTube song into **vocals / drums / bass / other** — right on your Mac.
The video plays at the top (muted), perfectly synced local stems play underneath.

![StemKit](https://img.shields.io/badge/platform-macOS-black) ![local](https://img.shields.io/badge/100%25-local-emerald)

## Features

- Paste a YouTube URL → get 4 separated stems
- Video and stems stay in sync (drift-corrected at 60 Hz)
- One-click presets: **All · Karaoke · Acapella · Drums + Bass**
- Per-stem mute, solo, volume, waveform with click-to-seek
- Persistent library — reopen any song instantly
- Everything runs locally: separation uses Meta's `htdemucs` via Apple MPS acceleration

## Requirements

- macOS (Apple Silicon recommended)
- Python 3.9+ (native arm64 preferred; auto-detected)
- ffmpeg (`brew install ffmpeg`)

First launch installs the engine into a private venv (~2 GB, one time) and downloads the model (~80 MB).

## Develop

```bash
npm install
npm run dev        # launch the app with hot reload
```

## Package

```bash
npm run dist       # builds dmg into release/
```

## How it works

```
YouTube URL ──► yt-dlp (venv) ──► ffmpeg ──► demucs htdemucs ──► stems/*.wav
                                     │
Electron renderer ◄── IPC progress ──┘
video iframe (muted) + Web Audio API stem playback, master clock = YouTube time
```

## Notes

- Downloading audio from YouTube is against their ToS for public-facing products — keep this for personal use.
- yt-dlp breaks occasionally when YouTube changes things. If a video fails to load, the error dialog offers a one-click update.

## Layout

```
src/main         Electron main process (pipeline, env bootstrap, library)
src/preload      IPC bridge
src/renderer     React UI (player, sync engine, waveforms)
python/          separate.py — demucs wrapper with JSON progress output
```
