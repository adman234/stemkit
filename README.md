# StemKit (web version)

Split any YouTube song into isolated stems (vocals, drums, bass, guitar, piano and
more) on your own server, then play them back in the browser with a fader per stem,
the video alongside, and the song's chords on a timeline. Runs as a Docker container
with an Unraid template, and works from a phone.

This is a fork of [StemKit](https://github.com/danielravina/stemkit) by
[Daniel Ravina](https://github.com/danielravina), a desktop app for macOS, Windows and
Linux. The React UI and the separation pipeline are his. This fork serves them over
HTTP from a container instead of wrapping them in Electron, so any browser on your
network can use one shared library. It is not intended to be merged back upstream; for
the desktop app, use [upstream's releases](https://github.com/danielravina/stemkit/releases).

<p align="center">
  <img src="docs/stemkit.png" alt="StemKit with a song split into six stems: video player, presets and color-coded waveform lanes" width="100%" />
</p>

## What is different from upstream

- **Runs as a server.** Python, CUDA PyTorch 2.8 (CUDA 12.8, so RTX 50 series cards
  work) and ffmpeg are baked into the image. No first-run download, no auto-updater and
  no usage ping. The library lives on the server and is shared by every browser.
- **Per-song engine and options**: a Best engine (BS-Roformer SW with real guitar and
  piano stems), studio vocals, a second pass and a drum kit split, alongside upstream's
  Demucs.
- **Key and chord detection** with a zoomable chord timeline, hand corrections, and
  guitar chord shapes on hover.
- **Downloaded video playback** that stays in sync without rebuffering, as an
  alternative to the YouTube embed.
- **Phone support**: touch controls, a lighter playback mode, and compressed copies of
  the stems so the player loads quickly.
- **Browser export**: one stem as WAV, or every stem plus the mix as a ZIP.
- Optional basic auth, automatic cleanup of songs not played for a while, and the
  large folders (songs, models) can live on their own volumes.

## Install

```bash
docker run -d --name stemkit --gpus all -p 8080:8080   -v /path/to/stemkit-data:/config ghcr.io/adman234/stemkit:latest
```

Open `http://SERVER:8080`. Leave out `--gpus all` to split on the CPU. GPU splits need
NVIDIA driver 570 or newer on the host.

**Unraid:** fetch the template from the Unraid terminal, then go to Docker > Add
Container and pick `stemkit` from the template list. GPU splits need the Nvidia Driver
plugin.

```bash
wget -O /boot/config/plugins/dockerMan/templates-user/my-stemkit.xml https://raw.githubusercontent.com/adman234/stemkit/main/unraid/stemkit.xml
```

| Variable | Default | What it does |
| --- | --- | --- |
| `STEMKIT_PASSWORD` | empty | Turns on HTTP basic auth. There is no login otherwise, so keep the port on your LAN or behind a reverse proxy |
| `STEMKIT_USERNAME` | empty | Username for basic auth. Empty accepts any username |
| `YTDLP_AUTO_UPDATE` | `true` | Installs the newest yt-dlp into `/config/python-overrides` at start |
| `STEMKIT_ATTENTION` | `efficient` | CUDA attention kernel for the studio vocals model: `efficient`, `flash` or `math` |
| `STEMKIT_KEEP_DAYS` | unset | Removes songs that have not been played for this many days. Empty or `0` keeps them forever |
| `STEMKIT_SONGS` / `STEMKIT_MODELS` | under `/config` | Move the library or the model downloads to another volume |
| `PUID` / `PGID` / `UMASK` | `99` / `100` / `022` | Owner and mask for files written to `/config` |
| `PORT` | `8080` | Port the server listens on inside the container |

## Engines and options

The add song panel picks the engine, the instruments and a few options per song.

| Choice | What it does | Score | Time for a 4 min song (RTX 4070 SUPER) | Peak VRAM | Download |
| --- | --- | --- | --- | --- | --- |
| Quick engine | Demucs v4, the desktop app's default. Guitar and piano use the 6-stem Demucs, which is rough | 7.8 dB | about 15 s | about 2 GB | none |
| Best engine | BS-Roformer SW, 6 stems including real guitar and piano | 10.2 dB | about 35 s | about 2.3 GB | 699 MB |
| Studio vocals | Mel-Band Roformer vocal model. On Quick it takes the vocals out first (vocals 8.5 to 11.5 dB); on Best it is blended with the engine's vocals (11.7 to 12.2 dB) | | +15 s | about 2.1 GB | 913 MB |
| Second pass | Twice the chunk overlap (two shifted passes on Quick). Under 0.1 dB better in testing | | about 2x | same | none |
| Split drum kit | MDX23C DrumSep turns the drums stem into kick, snare, toms, hi-hat, ride and crash | | +10 s | about 1.2 GB | 438 MB |
| Key and chords | BTC chord recognition marks the chords on a timeline and names the key. It listens to the harmonic stems, not the full mix | | +5 s | about 0.6 GB | 12 MB |

Scores are the median SDR over the 50 MUSDB18 test clips, averaged over vocals, drums,
bass and other (higher is cleaner). Steps run one after another, so peak VRAM is the
largest single step. On a CPU, Quick stays reasonable but the Roformer models take 15
minutes or more per song. Models download into `/config/models` the first time they are
needed, or ahead of time from Settings.

Chord detection reads pop, rock and folk well and struggles with dense or ambiguous
material, where the key confidence shown in the player drops. Guitar shapes come from a
trimmed copy of [chords-db](https://github.com/tombatossals/chords-db) (MIT).

## Video playback

The stems are the master clock. By default the video is the YouTube embed, which the
app only corrects for drift above a second, because every seek makes YouTube rebuffer.
Turn on "Download the video" in Settings (or use the link in the player) to save a
silent 360p, 480p or 720p copy instead, which is kept in sync smoothly.

## Storage

Everything persistent is under `/config`: `songs/` (the library), `models/` (optional checkpoints and the demucs weights), `settings.json`, `library.json` and `thumbs/`. The two that grow can be sent elsewhere without moving the rest: mount another volume and point `STEMKIT_SONGS` or `STEMKIT_MODELS` at it (`-v /mnt/user/media/stemkit:/songs -e STEMKIT_SONGS=/songs`). Both are also in the Unraid template under advanced settings. Moving an existing library is a matter of stopping the container, copying `songs/` across and setting the variable. If YouTube starts answering with "sign in to confirm you're not a bot", export a Netscape format `cookies.txt` from a logged in browser and put it at `/config/cookies.txt`.

## Development

Developing the web version: `npm run web:build` builds the UI into `out/web` and the server into `out/server`. `npm run web:server` rebuilds and starts the server on port 8080, and `npm run web:dev` runs a Vite dev server that proxies `/api` to it. Point the server at a local Python environment with `STEMKIT_PYTHON`, at ffmpeg with `STEMKIT_FFMPEG`, and at a data folder with `STEMKIT_DATA`. The server code is in `src/server` and reuses the desktop pipeline in `src/main` unchanged (see `scripts/build-server.mjs`).

## Notes

- Downloading audio from YouTube is against YouTube's terms. Keep this personal.
- yt-dlp breaks occasionally when YouTube changes things. The image updates it at
  every start unless `YTDLP_AUTO_UPDATE=false`.

## License

MIT, as upstream. See [LICENSE](LICENSE).
