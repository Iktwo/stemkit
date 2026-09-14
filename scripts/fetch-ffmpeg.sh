#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"
mkdir -p "$ROOT/extras"

if [[ "$OS" == "Darwin" ]]; then
  OUT="$ROOT/extras/ffmpeg-mac"
  if [[ -x "$OUT/ffmpeg" ]]; then
    echo "ffmpeg already present: $OUT/ffmpeg"
    "$OUT/ffmpeg" -version | head -1
    exit 0
  fi
  mkdir -p "$OUT"
  echo "downloading static ffmpeg for macOS..."
  curl -fsSL -o "$ROOT/extras/ffmpeg-mac.zip" "https://evermeet.cx/ffmpeg/get/ffmpeg/zip"
  unzip -oq "$ROOT/extras/ffmpeg-mac.zip" -d "$OUT"
  rm -f "$ROOT/extras/ffmpeg-mac.zip"
  chmod +x "$OUT/ffmpeg"
  "$OUT/ffmpeg" -version | head -1
  echo "saved to $OUT/ffmpeg"
elif [[ "$OS" == "Linux" ]]; then
  OUT="$ROOT/extras/ffmpeg-linux"
  if [[ -x "$OUT/ffmpeg" ]]; then
    if "$OUT/ffmpeg" -hide_banner -buildconf 2>&1 | grep -q -- '--enable-libsoxr'; then
      echo "ffmpeg with libsoxr already present: $OUT/ffmpeg"
      "$OUT/ffmpeg" -version | head -1
      exit 0
    fi
    echo "existing ffmpeg lacks libsoxr support; replacing it..."
    rm -f "$OUT/ffmpeg"
  fi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) BTBN_ARCH="linux64" ;;
    aarch64|arm64) BTBN_ARCH="linuxarm64" ;;
    *)
      echo "unsupported Linux arch: $ARCH (need x86_64 or aarch64)"
      exit 1
      ;;
  esac
  mkdir -p "$OUT"
  echo "downloading static ffmpeg with libsoxr for Linux ($BTBN_ARCH)..."
  TMP_TXZ="$ROOT/extras/ffmpeg-linux.tar.xz"
  TMP_DIR="$ROOT/extras/ffmpeg-linux-extract"
  trap 'rm -rf "$TMP_DIR" "$TMP_TXZ"' EXIT
  curl -fsSL -o "$TMP_TXZ" "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-${BTBN_ARCH}-gpl.tar.xz"
  rm -rf "$TMP_DIR"
  mkdir -p "$TMP_DIR"
  tar -xf "$TMP_TXZ" -C "$TMP_DIR"
  BIN="$(find "$TMP_DIR" -name ffmpeg -type f | head -1)"
  if [[ -z "$BIN" ]]; then
    echo "ffmpeg binary not found inside archive"
    exit 1
  fi
  cp -f "$BIN" "$OUT/ffmpeg"
  rm -rf "$TMP_DIR" "$TMP_TXZ"
  trap - EXIT
  chmod +x "$OUT/ffmpeg"
  if ! "$OUT/ffmpeg" -hide_banner -buildconf 2>&1 | grep -q -- '--enable-libsoxr'; then
    echo "downloaded ffmpeg does not include libsoxr support"
    rm -f "$OUT/ffmpeg"
    exit 1
  fi
  "$OUT/ffmpeg" -version | head -1
  echo "saved to $OUT/ffmpeg"
elif [[ "$OS" == "MINGW"* || "$OS" == "MSYS"* || "$OS" == "CYGWIN"* ]]; then
  echo "on Windows, run instead: powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1"
  exit 1
else
  echo "unsupported OS: $OS"
  exit 1
fi
