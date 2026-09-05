# StemKit

> [!NOTE]
> **Credits & Acknowledgement**: StemKit was created and designed by **[Daniel Ravina](https://github.com/danielravina)** in the original [danielravina/stemkit](https://github.com/danielravina/stemkit) repository. All credit for the foundational architecture and concept belongs to him! This fork contains personal enhancements and community improvements built on top of his work (such as SOTA BS-RoFormer stem separation, continuous background playback with a mini player, audio-focused playback that ditches YouTube video streaming once fetched, and UI polish).

Split any YouTube song into isolated stems — **vocals, drums, bass, guitar, piano** and more — right on your machine.

Search YouTube or paste a link, pick the instruments you want, and play the result like a multitrack DAW: every stem on its own fader, all perfectly in sync. Karaoke, acapellas and instrumentals are one click away. Once a track is fetched, YouTube is ditched entirely for pure, lightweight local audio playback.

Everything runs locally — no accounts, no cloud, no API keys.

![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-black) ![local](https://img.shields.io/badge/100%25-local-emerald)

<p align="center">
  <img src="docs/stemkit.png" alt="StemKit splitting Queen's Bohemian Rhapsody into six stems — player, presets and color-coded waveform lanes" width="100%" />
</p>

## Features

- Built-in YouTube search, or paste a link
- Choose your instruments individually; the right separation engine is picked for you
- Pure local audio playback — once fetched, no YouTube video streaming or overhead
- Persistent mini player for seamless listening while browsing or fetching new tracks
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
- No manual installs: if no Python 3.9+ is detected, StemKit downloads a private runtime (python-build-standalone) during first-launch setup
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
3. Optional (full notarization, zero Gatekeeper prompts): add `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` **and** set repo variable `ENABLE_NOTARIZATION` to `true` (Settings → Secrets and variables → Actions → Variables). Requires an **active** Apple Developer membership — Apple's notary service rejects expired accounts.

Without these secrets CI falls back to ad-hoc signing (app runs, but Gatekeeper complains on download).

## How it works

```
YouTube URL ──► yt-dlp (+JS runtime) ──► bundled ffmpeg ──► BS-RoFormer / Demucs FT ──► stems/*.wav
                                        │
Electron renderer ◄──── IPC events ─────┘
Local Web Audio API stem playback · per-stem volume / solo / mute faders
```

## Notes

- Downloading audio from YouTube violates their ToS for public products — keep this personal.
- yt-dlp breaks occasionally when YouTube changes things; the error dialog offers a one-click update (updates `yt-dlp` + the challenge solver together).

## Layout

```
src/main         Electron main process (pipeline, env bootstrap, library)
src/preload      IPC bridge
src/renderer     React UI (player, waveforms, mini player, audio engine)
python/          separate.py — demucs wrapper with JSON progress output
scripts/         node runner, ffmpeg fetchers
build/           icon sources
```

## Credits

Massive gratitude to **[Daniel Ravina](https://github.com/danielravina)**, creator of the original [StemKit](https://github.com/danielravina/stemkit). If you enjoy this project, make sure to check out and star the [original upstream repository](https://github.com/danielravina/stemkit)!

