# StemKit

Split any YouTube song into isolated stems — **vocals, drums, bass, guitar, piano** and more — right on your machine.

Search YouTube or paste a link, pick the instruments you want, and play the result like a mini DAW: the video on one side, every stem on its own fader, all perfectly in sync. Karaoke, acapellas and instrumentals are one click away.

Everything runs locally — no accounts, no cloud, no API keys.

![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-black) ![local](https://img.shields.io/badge/100%25-local-emerald)

## Features

- Built-in YouTube search, or paste a link
- Choose your instruments individually; the right separation engine is picked for you
- Tight audio/video sync with instant, artifact-free seeking
- One-click presets: **All · Karaoke · Acapella · Drums + Bass**
- Per-stem mute/solo/volume, waveforms with click-to-seek
- Parallel background splitting with live progress
- Export any stem (or all) as WAV
- Fully offline after setup — separation runs on Apple MPS / CPU, ffmpeg included

## Download

Grab installers from [Releases](https://github.com/danielravina/stemkit/releases):
- **macOS** (Apple Silicon): `StemKit-x.y.z-mac-arm64.dmg`
- **Windows**: `StemKit-Setup-x.y.z.exe` (installer) or portable `.zip`

First launch creates a private Python environment and downloads the separation engine (~2 GB, one time) plus model weights (~80 MB). ffmpeg is bundled — nothing else to install.

> **macOS first launch**: builds are signed with a Developer ID but not notarized, so macOS may say it "cannot verify the developer". One-time fix: **System Settings → Privacy & Security → Open Anyway** (or `xattr -cr /Applications/StemKit.app`).
>
> **Windows**: SmartScreen may warn on first run — "More info → Run anyway".

## Requirements

- **macOS 12+** (Apple Silicon) or **Windows 10/11** (x64)
- Python 3.9+ available on PATH or in a standard install location (auto-detected)
- Node.js 20+ only for building from source

## Develop

```bash
npm install
npm run dev
```

Wrong Node version? Scripts auto-relaunch with a suitable one (nvm / nvm-windows).

## Build & release

```bash
bash scripts/fetch-ffmpeg.sh        # mac (one time)
powershell scripts/fetch-ffmpeg.ps1 # windows (one time)

npm run dist        # mac dmg -> release/
npm run dist:win    # windows nsis+zip -> release/
npm run dist:all    # both (on the matching OS)
```

Releases are built by GitHub Actions:
- push a tag `v*` → binaries attach to a draft GitHub Release
- `workflow_dispatch` ("Run workflow") → on-demand artifacts on the run page

macOS builds are Developer-ID-signed when the certificate is available — see **Signing in CI** below for the one-time setup, plus optional notarization.

### Signing in CI (one-time setup)

Local builds sign with your keychain cert automatically. CI runners have empty keychains, so hand them the certificate via repo **secrets**:

1. Keychain Access → My Certificates → right-click `Developer ID Application: ...` → Export → `.p12` (set an export password)
2. Base64 it and add these repo secrets:
   - `CSC_MAC_P12` — the base64 string: `base64 -i developer-id.p12 | pbcopy`
   - `CSC_MAC_PASSWORD` — the export password from step 1
3. Optional (full notarization, zero Gatekeeper prompts): also add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

Without these secrets CI falls back to ad-hoc signing (app runs, but Gatekeeper complains on download).

## How it works

```
YouTube URL ──► yt-dlp (+JS runtime) ──► bundled ffmpeg ──► demucs htdemucs ──► stems/*.wav
                                        │
Electron renderer ◄──── IPC events ─────┘
video iframe (muted) + Web Audio stem playback · master clock = the audio itself
```

## Notes

- Downloading audio from YouTube violates their ToS for public products — keep this personal.
- yt-dlp breaks occasionally when YouTube changes things; the error dialog offers a one-click update (updates `yt-dlp` + the challenge solver together).

## Layout

```
src/main         Electron main process (pipeline, env bootstrap, library)
src/preload      IPC bridge
src/renderer     React UI (player, sync engine, waveforms)
python/          separate.py — demucs wrapper with JSON progress output
scripts/         node runner, ffmpeg fetchers
build/           icon sources
```
