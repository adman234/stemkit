#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"
mkdir -p "$ROOT/extras"

# the pipeline resamples with soxr, so every bundled ffmpeg must be built
# with libsoxr. There is no public static macOS build with libsoxr for either
# architecture (evermeet.cx is x86_64 without soxr, osxexperts.net ships arm64
# without soxr), so the mac path compiles ffmpeg + soxr from source for
# whichever arch the host Mac actually runs
SOXR_VERSION="0.1.3"
FFMPEG_VERSION="9.0.2"

# detect the native CPU arch once. hw.optional.arm64 is kernel truth — a shell
# or binary running under Rosetta makes uname -m report x86_64 even on an
# Apple Silicon Mac
function mac_native_arch() {
  if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" == "1" ]]; then
    echo "arm64"
  else
    echo "x86_64"
  fi
}

function mac_ffmpeg_is_usable() {
  local bin="$1"
  local expected_arch="$2"
  [[ -x "$bin" ]] || return 1
  file "$bin" 2>/dev/null | grep -q "$expected_arch" || return 1
  "$bin" -hide_banner -buildconf 2>/dev/null | grep -q -- --enable-libsoxr
}

function build_mac_ffmpeg() {
  local out="$1"
  local target_arch
  target_arch="$(mac_native_arch)"

  # if the script is running under Rosetta on an arm64 Mac (e.g. an x86_64
  # bash from anaconda or Homebrew), re-exec natively so clang builds the
  # correct slice — configure would otherwise pick x86_64 from uname -m
  if [[ "$(uname -m)" != "$target_arch" ]]; then
    exec arch -"$target_arch" /bin/bash "$0" "$@"
  fi

  if ! command -v cmake >/dev/null 2>&1; then
    echo "cmake is required to build the bundled ffmpeg — install it first (e.g. brew install cmake)"
    exit 1
  fi

  # arm64 requires macOS 11.0+; x86_64 works back to 10.13
  if [[ "$target_arch" == "arm64" ]]; then
    local deploy_target="11.0"
  else
    local deploy_target="10.13"
  fi

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  PREFIX="$TMP/prefix"
  JOBS="$(sysctl -n hw.ncpu)"

  echo "building libsoxr $SOXR_VERSION ($target_arch)..."
  curl -fsSL -o "$TMP/soxr.tar.gz" "https://github.com/chirlu/soxr/archive/refs/tags/$SOXR_VERSION.tar.gz"
  tar -xzf "$TMP/soxr.tar.gz" -C "$TMP"
  cmake -S "$TMP/soxr-$SOXR_VERSION" -B "$TMP/soxr-build" \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTS=OFF \
    -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_OSX_ARCHITECTURES="$target_arch" \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="$deploy_target" \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
    -DCMAKE_INSTALL_PREFIX="$PREFIX" >/dev/null
  cmake --build "$TMP/soxr-build" --target install --parallel "$JOBS" >/dev/null

  # x86_64 builds need nasm for hand-optimized assembly; rather than require
  # another dependency, disable x86asm — the performance difference is
  # negligible for audio processing
  local x86asm_flag="--disable-x86asm"
  if [[ "$target_arch" == "arm64" ]]; then
    x86asm_flag=""
  fi

  echo "building ffmpeg $FFMPEG_VERSION ($target_arch, static libsoxr) — this takes a few minutes..."
  curl -fsSL -o "$TMP/ffmpeg.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
  tar -xf "$TMP/ffmpeg.tar.xz" -C "$TMP"
  (
    cd "$TMP/ffmpeg-$FFMPEG_VERSION"
    PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure \
      --enable-libsoxr \
      --disable-autodetect \
      --enable-zlib \
      --enable-bzlib \
      --disable-ffplay \
      --disable-ffprobe \
      --disable-doc \
      --disable-debug \
      $x86asm_flag \
      --pkg-config-flags=--static \
      --extra-cflags="-I$PREFIX/include -mmacosx-version-min=$deploy_target" \
      --extra-ldflags="-L$PREFIX/lib -mmacosx-version-min=$deploy_target" >/dev/null
    make --silent --jobs "$JOBS" >/dev/null
  )

  mkdir -p "$OUT"
  cp -f "$TMP/ffmpeg-$FFMPEG_VERSION/ffmpeg" "$out"
  chmod +x "$out"
  xattr -dr com.apple.quarantine "$out" 2>/dev/null || true

  if ! mac_ffmpeg_is_usable "$out" "$target_arch"; then
    echo "built ffmpeg is not usable (wrong arch or missing libsoxr)" >&2
    rm -f "$out"
    exit 1
  fi
}

if [[ "$OS" == "Darwin" ]]; then
  OUT="$ROOT/extras/ffmpeg-mac"
  EXPECTED_ARCH="$(mac_native_arch)"
  if mac_ffmpeg_is_usable "$OUT/ffmpeg" "$EXPECTED_ARCH"; then
    echo "ffmpeg already present: $OUT/ffmpeg"
    "$OUT/ffmpeg" -version | head -1
    exit 0
  fi
  if [[ -e "$OUT/ffmpeg" ]]; then
    echo "existing ffmpeg is unusable (wrong CPU arch or missing libsoxr) — replacing it..."
    rm -f "$OUT/ffmpeg"
  fi
  build_mac_ffmpeg "$OUT/ffmpeg"
  "$OUT/ffmpeg" -version | head -1
  echo "saved to $OUT/ffmpeg"
elif [[ "$OS" == "Linux" ]]; then
  OUT="$ROOT/extras/ffmpeg-linux"
  if [[ -x "$OUT/ffmpeg" ]] && "$OUT/ffmpeg" -hide_banner -buildconf 2>/dev/null | grep -q -- --enable-libsoxr; then
    echo "ffmpeg already present: $OUT/ffmpeg"
    "$OUT/ffmpeg" -version | head -1
    exit 0
  fi
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64) JV_ARCH="amd64" ;;
    aarch64|arm64) JV_ARCH="arm64" ;;
    *)
      echo "unsupported Linux arch: $ARCH (need x86_64 or aarch64)"
      exit 1
      ;;
  esac
  mkdir -p "$OUT"
  echo "downloading static ffmpeg for Linux ($JV_ARCH)..."
  TMP_TXZ="$ROOT/extras/ffmpeg-linux.tar.xz"
  TMP_DIR="$ROOT/extras/ffmpeg-linux-extract"
  # primary: johnvansickle (broadest glibc compatibility). fallback: BtbN git
  # builds hosted on GitHub — johnvansickle is a personal server that
  # rate-limits/stalls under CI load, which once shipped an HTML error page
  # where the tarball should be (xz: File format not recognized)
  if [[ "$JV_ARCH" == "amd64" ]]; then
    URLS=(
      "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
      "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz"
    )
  else
    URLS=(
      "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-arm64-static.tar.xz"
      "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linuxarm64-gpl.tar.xz"
    )
  fi
  for url in "${URLS[@]}"; do
    echo "trying $url ..."
    rm -f "$TMP_TXZ"
    # --max-time: a stalled host must fail over, not hang the CI job
    if ! curl -fsSL --max-time 180 --retry 2 -o "$TMP_TXZ" "$url"; then
      echo "download failed from $url"
      continue
    fi
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"
    if tar -xJf "$TMP_TXZ" -C "$TMP_DIR" 2>/dev/null; then
      echo "extracted ok from $url"
      break
    fi
    echo "archive from $url is not a valid xz tarball"
  done
  BIN="$(find "$TMP_DIR" -name ffmpeg -type f | head -1)"
  if [[ -z "$BIN" ]]; then
    echo "ffmpeg binary not found inside archive"
    exit 1
  fi
  cp -f "$BIN" "$OUT/ffmpeg"
  rm -rf "$TMP_DIR" "$TMP_TXZ"
  chmod +x "$OUT/ffmpeg"
  if ! "$OUT/ffmpeg" -hide_banner -buildconf 2>/dev/null | grep -q -- --enable-libsoxr; then
    echo "downloaded ffmpeg does not include libsoxr support" >&2
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
