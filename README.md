# StemKit

Split any YouTube song into isolated stems — **vocals, drums, bass, guitar, piano** and more — right on your machine.

Search YouTube or paste a link, pick the instruments you want, and play the result like a mini DAW: the video on one side, every stem on its own fader, all perfectly in sync. Karaoke, acapellas and instrumentals are one click away.

Everything runs locally — no accounts, no API keys. Your songs, searches and audio never leave your machine. The app sends one tiny anonymous ping per day (a random install id + version/OS) so I can count how many people use it — see [Privacy](#privacy) for details.

![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-black) ![local](https://img.shields.io/badge/100%25-local-emerald)

<p align="center">
  <img src="docs/stemkit.png" alt="StemKit splitting Queen's Bohemian Rhapsody into six stems — video player, presets and color-coded waveform lanes" width="100%" />
</p>

## Web version (Docker / Unraid)

This fork adds a browser version of StemKit that runs as a server in a container. It is the same React UI and the same separation pipeline as the desktop app, served over HTTP instead of wrapped in Electron, so any browser on your network can search, split, play and download stems. The library lives on the server and is shared by every browser.

```bash
docker run -d --name stemkit --gpus all -p 8080:8080   -v /path/to/stemkit-data:/config ghcr.io/adman234/stemkit:latest
```

Then open `http://SERVER:8080`. Leave out `--gpus all` to split on the CPU.

**Unraid:** from the Unraid terminal, fetch the template, then go to Docker, Add Container, and pick `stemkit` from the template list. GPU splits need the Nvidia Driver plugin.

```bash
wget -O /boot/config/plugins/dockerMan/templates-user/my-stemkit.xml https://raw.githubusercontent.com/adman234/stemkit/main/unraid/stemkit.xml
```

| Variable | Default | What it does |
| --- | --- | --- |
| `STEMKIT_PASSWORD` | empty | Turns on HTTP basic auth. There is no login otherwise, so keep the port on your LAN or behind a reverse proxy |
| `STEMKIT_USERNAME` | empty | Username for basic auth. Empty accepts any username |
| `YTDLP_AUTO_UPDATE` | `true` | Installs the newest yt-dlp into `/config/python-overrides` at start |
| `STEMKIT_ATTENTION` | `efficient` | CUDA attention kernel for the studio vocals model: `efficient`, `flash` or `math` |
| `PUID` / `PGID` / `UMASK` | `99` / `100` / `022` | Owner and mask for files written to `/config` |
| `PORT` | `8080` | Port the server listens on inside the container |

**Engines and options.** The add song panel picks the engine, the instruments and a few options per song:

| Choice | What it does | Score | Time for a 4 min song (RTX 4070 SUPER) | Peak VRAM | Download |
| --- | --- | --- | --- | --- | --- |
| Quick engine | Demucs v4, the desktop app's default. Guitar and piano use the 6-stem Demucs, which is rough | 7.8 dB | about 15 s | about 2 GB | none |
| Best engine | BS-Roformer SW, 6 stems including real guitar and piano | 10.2 dB | about 35 s | about 2.3 GB | 699 MB |
| Studio vocals | Mel-Band Roformer vocal model. On Quick it takes the vocals out first (vocals 8.5 to 11.5 dB); on Best it is blended with the engine's vocals (11.7 to 12.2 dB) | | +15 s | about 2.1 GB | 913 MB |
| Second pass | Twice the chunk overlap (two shifted passes on Quick). Under 0.1 dB better in testing | | about 2x | same | none |
| Split drum kit | MDX23C DrumSep turns the drums stem into kick, snare, toms, hi-hat, ride and crash | | +10 s | about 1.2 GB | 438 MB |

Scores are the median SDR over the 50 MUSDB18 test clips, averaged over vocals, drums, bass and other (higher is cleaner). Steps run one after another, so peak VRAM is the largest single step, not the sum; two songs splitting at once need about twice that. On a CPU, Quick stays reasonable but the roformer models take 15 minutes or more per song. Models download into `/config/models` the first time they are needed, or ahead of time from Settings.

**Video playback.** The player keeps the picture with the stems, which are the master clock. Two sources are possible:

- **The YouTube embed** (default). The app can only correct it by seeking it, and a seek makes YouTube rebuffer, so corrections are rare: only drift above 1 second that lasts more than 1.5 seconds, at most one correction every 6 seconds, and it stops after three corrections that did not help. Chasing every small drift is what made the player stutter with a spinner every second or two.
- **A downloaded video**, served from `/config/songs/<id>/video.mp4`. Turn on "Download the video" in Settings to save one with each split, or use the link in the player for a song already in the library. Local playback is kept in step by running the video a fraction faster or slower, which is invisible, so it never rebuffers or jumps. Video only, no audio, roughly 10 to 40 MB per song depending on the quality setting (360p, 480p or 720p).

`npm run web:test` runs a simulation of the sync loop against a fake video element, including a stalled video and a browser that refuses to play.

Everything persistent is under `/config`: `songs/` (the library), `models/` (optional checkpoints and the demucs weights), `settings.json`, `library.json` and `thumbs/`. If YouTube starts answering with "sign in to confirm you're not a bot", export a Netscape format `cookies.txt` from a logged in browser and put it at `/config/cookies.txt`.

Differences from the desktop app:

- Python, CUDA PyTorch (2.8, CUDA 12.8, so RTX 50 series cards work) and ffmpeg are baked into the image, so there is no first-run setup download. The host needs NVIDIA driver 570 or newer for GPU splits.
- GPU splitting is switched on automatically the first time the server starts with a GPU visible.
- Export downloads through the browser: a single stem as WAV, or every stem plus the full mix as a ZIP.
- No auto-updater (pull a new image instead) and no usage ping.

Developing the web version: `npm run web:build` builds the UI into `out/web` and the server into `out/server`. `npm run web:server` rebuilds and starts the server on port 8080, and `npm run web:dev` runs a Vite dev server that proxies `/api` to it. Point the server at a local Python environment with `STEMKIT_PYTHON`, at ffmpeg with `STEMKIT_FFMPEG`, and at a data folder with `STEMKIT_DATA`. The server code is in `src/server` and reuses the desktop pipeline in `src/main` unchanged (see `scripts/build-server.mjs`).

## Features

- Built-in YouTube search, or paste a link
- Choose your instruments individually; the right separation engine is picked for you
- Tight audio/video sync with instant, artifact-free seeking
- One-click presets: **All · Karaoke · Acapella · Drums + Bass**
- Per-stem mute/solo/volume, waveforms with click-to-seek
- Parallel background splitting with live progress
- Export any stem (or all) as WAV
- Fully offline after setup — separation runs on Apple Silicon (MPS), NVIDIA GPUs (CUDA) or CPU; ffmpeg included

## Download

Grab installers from [Releases](https://github.com/danvelope/stemkit/releases):
- **macOS** (Apple Silicon): `StemKit-x.y.z-mac-arm64.dmg`
- **Windows**: `StemKit-Setup-x.y.z.exe` (installer) or portable `.zip`
- **Linux** (x64): `StemKit-x.y.z-linux-x86_64.AppImage` (portable, self-updating) or `StemKit-x.y.z-linux-amd64.deb`

First launch creates a private Python environment and downloads the separation engine (~2 GB) — one time. ffmpeg is bundled — nothing else to install.

Optional quality upgrades live behind a gear icon in the app (Settings), each with its own one-time download:
- **Studio-quality vocals** (Mel-Band Roformer): +913 MB — runs on GPU or CPU (CPU is slower)
- **Fine-tuned demucs** (htdemucs_ft): +~320 MB, up to 4× slower
- **Refinement passes**: 2 shifts instead of 1, up to 3× slower

> **macOS first launch**: builds are signed with a Developer ID but not notarized, so macOS may say it "cannot verify the developer". One-time fix: **System Settings → Privacy & Security → Open Anyway** (or `xattr -cr /Applications/StemKit.app`).
>
> **Windows**: SmartScreen may warn on first run — "More info → Run anyway".

## Requirements

- **macOS 12+** (Apple Silicon) or **Windows 10/11** (x64) or **Linux x64** (Ubuntu 22.04+ or equivalent; NVIDIA driver for GPU splits)
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
bash scripts/fetch-ffmpeg.sh        # mac/linux (one time)
powershell scripts/fetch-ffmpeg.ps1 # windows (one time)

npm run dist        # mac dmg -> release/
npm run dist:win    # windows nsis+zip -> release/
npm run dist:linux  # linux AppImage+deb (x64) -> release/
npm run dist:all    # both (on the matching OS)
```

> **Linux**: building the `.deb` needs `dpkg` + `fakeroot` on the host; running the `.AppImage` needs FUSE. In-app self-update works on the AppImage — `.deb` installs update by re-downloading.

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
YouTube URL ──► yt-dlp (+JS runtime) ──► bundled ffmpeg ──► mel-band roformer (vocals) ─┐
                                        │                                               ├─► stems/*.wav
                                        └─────────────► demucs htdemucs ────────────────┘
                                             (drums/bass/other, shift-averaged)

Electron renderer ◄──── IPC events ─────┘
video iframe (muted) + Web Audio stem playback · master clock = the audio itself
```

## Notes

- Downloading audio from YouTube violates their ToS for public products — keep this personal.
- yt-dlp breaks occasionally when YouTube changes things; the error dialog offers a one-click update (updates `yt-dlp` + the challenge solver together).

## Privacy

- **Never leaves your machine:** the videos you download, the songs you split, your library, your searches and your audio — none of it is uploaded anywhere. All separation runs locally.
- **Anonymous usage count:** on each launch the app sends one small POST to a Cloudflare Worker (`stemkit-stats.danielravina.workers.dev`) — at most once per day. It contains a **random install id** (generated locally, stored in the app's settings folder), the app version, OS and architecture. No IP-address-based profiles are built, no cookies, no identifiers tied to you, no analytics SDKs.
- **What it's for:** counting installs and active usage (the same stats you'd get from GitHub release downloads, minus auto-update noise). The counter code is in [`telemetry-worker/`](telemetry-worker) — inspectable like the rest of the app.
- **Fully offline builds:** if you'd rather send nothing, build from source and remove `src/main/telemetry.ts` (or block the worker domain in your firewall) — everything else works identically offline.

## Layout

```
src/main         Electron main process (pipeline, env bootstrap, library)
src/preload      IPC bridge
src/renderer     React UI (player, sync engine, waveforms)
python/          separate.py (demucs) and roformer.py (neural vocals) with JSON progress output
python/vendor/   patched model code — see python/vendor/README.md
scripts/         node runner, ffmpeg fetchers
build/           icon sources
```
