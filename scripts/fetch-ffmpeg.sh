#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OS="$(uname -s)"
mkdir -p "$ROOT/extras"

# the pipeline resamples with soxr, so every bundled ffmpeg must be built
# with libsoxr. There is no public static macOS build with libsoxr for either
# architecture (evermeet.cx is x86_64 without soxr, osxexperts.net ships arm64
# without soxr), so the mac path compiles ffmpeg + soxr from source.
#
# It compiles BOTH slices and lipo-merges them. GitHub no longer offers Intel
# macOS runners, so the release job always cross-compiles the x86_64 slice on
# an arm64 host — a single-arch build would put an arm64-only ffmpeg inside the
# x64 dmg and fail every Intel split with "Something went wrong with the
# built-in audio tools".
SOXR_VERSION="0.1.3"
FFMPEG_VERSION="9.0.2"
MAC_ARCHS=(arm64 x86_64)
# 11.0 is the floor for the arm64 slice; x86_64 would run back to 10.13 but a
# single target keeps the two slices' objects linkable
MAC_DEPLOY_TARGET="11.0"

function mac_ffmpeg_is_usable() {
  local bin="$1"
  [[ -x "$bin" ]] || return 1
  local have
  have="$(lipo -archs "$bin" 2>/dev/null)" || return 1
  local a
  for a in "${MAC_ARCHS[@]}"; do
    [[ " $have " == *" $a "* ]] || return 1
  done
  "$bin" -hide_banner -buildconf 2>/dev/null | grep -q -- --enable-libsoxr
}

# ffmpeg bakes exactly one architecture into config.h at configure time, so a
# single -arch arm64 -arch x86_64 pass does not work: the arm64 slice then
# compiles libavcodec/x86/mathops.h inline asm and dies on
# "invalid input constraint 'c' in asm". Each slice therefore gets its own
# configure + build, and the binaries are merged with lipo.
function build_mac_ffmpeg() {
  local out="$1"

  if ! command -v cmake >/dev/null 2>&1; then
    echo "cmake is required to build the bundled ffmpeg — install it first (e.g. brew install cmake)"
    exit 1
  fi

  # hw.optional.arm64 is kernel truth — a shell running under Rosetta makes
  # uname -m report x86_64 even on an Apple Silicon Mac. Only the non-native
  # slice may use --enable-cross-compile; forcing it on the native one skips
  # host probes ffmpeg otherwise passes
  local native_arch
  if [[ "$(sysctl -n hw.optional.arm64 2>/dev/null)" == "1" ]]; then
    native_arch="arm64"
  else
    native_arch="x86_64"
  fi

  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  JOBS="$(sysctl -n hw.ncpu)"

  curl -fsSL -o "$TMP/soxr.tar.gz" "https://github.com/chirlu/soxr/archive/refs/tags/$SOXR_VERSION.tar.gz"
  tar -xzf "$TMP/soxr.tar.gz" -C "$TMP"
  curl -fsSL -o "$TMP/ffmpeg.tar.xz" "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz"
  tar -xf "$TMP/ffmpeg.tar.xz" -C "$TMP"

  local SLICES=() ARCH FF_ARCH PREFIX
  for ARCH in "${MAC_ARCHS[@]}"; do
    # ffmpeg's configure calls the arm64 target aarch64
    FF_ARCH="$ARCH"
    if [[ "$ARCH" == "arm64" ]]; then
      FF_ARCH="aarch64"
    fi
    PREFIX="$TMP/$ARCH/prefix"

    echo "building libsoxr $SOXR_VERSION ($ARCH)..."
    cmake -S "$TMP/soxr-$SOXR_VERSION" -B "$TMP/$ARCH/soxr-build" \
      -DBUILD_SHARED_LIBS=OFF \
      -DBUILD_TESTS=OFF \
      -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_OSX_ARCHITECTURES="$ARCH" \
      -DCMAKE_OSX_DEPLOYMENT_TARGET="$MAC_DEPLOY_TARGET" \
      -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
      -DCMAKE_INSTALL_PREFIX="$PREFIX" >/dev/null
    cmake --build "$TMP/$ARCH/soxr-build" --target install --parallel "$JOBS" >/dev/null

    echo "building ffmpeg $FFMPEG_VERSION ($ARCH, static libsoxr) — this takes a few minutes..."
    # x86_64 hand-optimized assembly needs nasm; rather than add a build
    # dependency, skip it — the only resampler this app uses is soxr
    # (plain strings, not arrays: macOS ships bash 3.2, where expanding an
    # empty array under set -u aborts the script)
    local cross_flags="" asm_flags=""
    if [[ "$ARCH" != "$native_arch" ]]; then
      cross_flags="--enable-cross-compile --target-os=darwin"
    fi
    if [[ "$ARCH" == "x86_64" ]]; then
      asm_flags="--disable-x86asm"
    fi

    rm -rf "$TMP/$ARCH/src"
    mkdir -p "$TMP/$ARCH"
    cp -R "$TMP/ffmpeg-$FFMPEG_VERSION" "$TMP/$ARCH/src"
    (
      cd "$TMP/$ARCH/src"
      PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure \
        --arch="$FF_ARCH" \
        --cc="clang -arch $ARCH" \
        $cross_flags \
        $asm_flags \
        --enable-libsoxr \
        --disable-autodetect \
        --enable-zlib \
        --enable-bzlib \
        --disable-ffplay \
        --disable-ffprobe \
        --disable-doc \
        --disable-debug \
        --pkg-config-flags=--static \
        --extra-cflags="-I$PREFIX/include -arch $ARCH -mmacosx-version-min=$MAC_DEPLOY_TARGET" \
        --extra-ldflags="-L$PREFIX/lib -arch $ARCH -mmacosx-version-min=$MAC_DEPLOY_TARGET" >/dev/null
      make --silent --jobs "$JOBS" >/dev/null
    )
    SLICES+=("$TMP/$ARCH/src/ffmpeg")
  done

  mkdir -p "$OUT"
  lipo -create "${SLICES[@]}" -output "$out"
  chmod +x "$out"
  xattr -dr com.apple.quarantine "$out" 2>/dev/null || true

  if ! mac_ffmpeg_is_usable "$out"; then
    echo "built ffmpeg is not usable (missing an arch slice or libsoxr)" >&2
    rm -f "$out"
    exit 1
  fi
}

if [[ "$OS" == "Darwin" ]]; then
  OUT="$ROOT/extras/ffmpeg-mac"
  if mac_ffmpeg_is_usable "$OUT/ffmpeg"; then
    echo "ffmpeg already present: $OUT/ffmpeg"
    "$OUT/ffmpeg" -version | head -1
    exit 0
  fi
  if [[ -e "$OUT/ffmpeg" ]]; then
    echo "existing ffmpeg is unusable (missing an arch slice or libsoxr) — replacing it..."
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
