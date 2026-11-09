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
- **Note transcription and tab** of the guitar, bass, piano, vocal or other stem under
  the player: guitar and bass parts as scrolling tab in a choice of tunings, every stem
  as a piano roll, a top line view that picks the lead out of a guitar part, bends
  marked, and text tab and MIDI downloads. Two models to choose between: YourMT3+ (the
  default, a multi-instrument transformer, more accurate) and Spotify's lighter Basic
  Pitch.
- **Sing-along lyrics**: an option on the add-song screen (off by default) finds the
  lyrics on LRCLIB and times them to the singing with a small alignment model on the
  vocals stem, word by word. Also available from the player, with a manual search when
  the automatic match is wrong.
- **Downloaded video playback** that stays in sync without rebuffering, as an
  alternative to the YouTube embed. Songs show the cover image by default, and the video
  can be picked per song or made the default with `STEMKIT_PICTURE`.
- **Phone support**: touch controls, pausing when the phone switches apps, and compressed
  copies of the stems so the player loads quickly. Held sideways, a phone switches to a
  stage view for playing along: big sing-along lyrics, the chords scrolling under them,
  and one-tap mutes for each stem. The screen stays awake while a song plays (this needs
  the HTTPS address; browsers only allow it on secure pages).
- **Compact storage**: stems are kept as FLAC, about a tenth of the float WAVs the
  splitter makes, at a depth set per container.
- **Browser export**: one stem as WAV, or every stem plus the original audio as a ZIP.
- **Audio file uploads**: the folder button next to the search box uploads an mp3,
  wav, flac or other audio file from your device and splits it like a YouTube song
  (upstream's "split a local file", done over HTTP).
- **AMD GPUs**: a separate `latest-rocm` image carries upstream's experimental ROCm
  support (see [AMD GPUs](#amd-gpus-experimental)).
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

### AMD GPUs (experimental)

AMD cards need the ROCm image and the GPU device nodes instead of `--gpus all`. This
follows upstream's AMD support: Linux hosts only, torch 2.8 with ROCm 6.4, so RDNA4
(RX 9070) works. RDNA2 and RDNA3 cards that the ROCm wheels do not cover directly get
`HSA_OVERRIDE_GFX_VERSION` set automatically; set it yourself to override that.

```bash
docker run -d --name stemkit --device /dev/kfd --device /dev/dri -p 8080:8080   -v /path/to/stemkit-data:/config ghcr.io/adman234/stemkit:latest-rocm
```

On Unraid, use the same template, change the repository to
`ghcr.io/adman234/stemkit:latest-rocm`, and replace `--runtime=nvidia` in Extra
Parameters with `--device=/dev/kfd --device=/dev/dri`. The host needs the `amdgpu`
driver loaded. This image has not been tested on AMD hardware yet.

| Variable | Default | What it does |
| --- | --- | --- |
| `STEMKIT_PASSWORD` | empty | Turns on HTTP basic auth. There is no login otherwise, so keep the port on your LAN or behind a reverse proxy |
| `STEMKIT_USERNAME` | empty | Username for basic auth. Empty accepts any username |
| `YTDLP_AUTO_UPDATE` | `true` | Installs the newest yt-dlp into `/config/python-overrides` at start |
| `STEMKIT_ATTENTION` | `efficient` | CUDA attention kernel for the studio vocals model: `efficient`, `flash` or `math` |
| `STEMKIT_MAX_UPLOAD_MB` | `1024` | Largest audio file the upload button accepts |
| `STEMKIT_KEEP_DAYS` | unset | Removes songs that have not been played for this many days. Empty or `0` keeps them forever |
| `STEMKIT_SONGS` / `STEMKIT_MODELS` | under `/config` | Move the library or the model downloads to another volume |
| `STEMKIT_STEM_FORMAT` | `flac16` | How stems are kept on disk: `flac16`, `flac24` or `wav`. See [Stem storage](#stem-storage) |
| `STEMKIT_PICTURE` | `thumbnail` | What a new split shows by default: `thumbnail` (the cover image, no video download) or `video`. It can still be changed per split. See [Video playback](#video-playback) |
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
| Sync lyrics | Finds the lyrics on LRCLIB and times them to the singing with wav2vec2 on the vocals stem. Off by default; needs the vocals stem | | +10 s | about 1 GB | 378 MB |
| Notes (YourMT3+) | The default note model: a multi-instrument transformer. Accurate, GPU-friendly, from the player after the split | | about 20 s per stem | about 2 GB | 536 MB |
| Notes (Basic Pitch) | Spotify's light note model. Fast, tiny, rougher. Runs on the CPU | | a few seconds | none | 0.2 MB |

Scores are the median SDR over the 50 MUSDB18 test clips, averaged over vocals, drums,
bass and other (higher is cleaner). Steps run one after another, so peak VRAM is the
largest single step. On a CPU, Quick stays reasonable but the Roformer models take 15
minutes or more per song. Models download into `/config/models` the first time they are
needed, or ahead of time from Settings.

Chord detection reads pop, rock and folk well and struggles with dense or ambiguous
material, where the key confidence shown in the player drops. Guitar shapes come from a
trimmed copy of [chords-db](https://github.com/tombatossals/chords-db) (MIT).

Note transcription has two models, switched under the roll. **YourMT3+** (the default) is
the multi-instrument transformer from [Chang et al., MLSP 2024](https://github.com/mimbres/YourMT3);
`python/notes_ymt3.py` runs its YPTF.MoE+Multi checkpoint, fetching the model code at a
pinned revision from the authors' [Hugging Face Space](https://huggingface.co/spaces/mimbres/YourMT3)
(Apache 2.0) on first use. **Basic Pitch** ([Spotify](https://github.com/spotify/basic-pitch),
Apache 2.0) is the lighter alternative; `python/notes.py` carries a trimmed copy of its
decoding. YourMT3+ is more accurate and reads polyphony and several instruments; Basic
Pitch is faster and tinier but leaves more stray octaves and ghost notes. Each model's
notes are kept in their own file, so a stem can be read by both. There is no separate
lead guitar stem, so **Top line** keeps the highest note at each moment, which on a
guitar stem is mostly the lead. The roll shows the beat grid when the key and chords have
been worked out, and the MIDI file uses that tempo.

Lyrics come from [LRCLIB](https://lrclib.net), looked up by the song's artist and title
(sent to lrclib.net). When a result carries line times they are used; the words are then
timed to the vocals stem by a CTC forced alignment over [wav2vec2](https://huggingface.co/facebook/wav2vec2-base-960h)
(Apache 2.0) in `python/lyrics_align.py`. A line the model cannot follow (another
language, a mumbled line) keeps its own rough timing. Turn it on per song on the add-song
screen, or use **Find lyrics** in the player; a manual artist and title search is there
for when the automatic match is wrong.

The guitar, other and bass stems open as **Tab**. The transcription has pitches, not
strings, so `src/renderer/src/lib/tab.ts` picks a string and fret for every note the way
a player would: chords as playable shapes, lines kept in one hand position, and a shape
moved along the neck rather than re-fingered. It is a cheapest path through every
possible fingering of the part, so a note is placed with what comes next in mind. Pick
the tuning from the menu (standard, drop D, half step down, D standard, drop C; 4 and 5
string bass), and it is remembered per song. **Tab** downloads it as text in 4/4 bars of
sixteenths on the song's beat grid, with a time stamp per line and long rests left out.
Bar lines start on the first beat found, which is not always the downbeat.

## Video playback

The stems are the master clock. With **Video** picked under Picture on the add song
screen, a silent 360p, 480p or 720p copy is downloaded with each split and kept in sync
smoothly; the quality is in Settings. **Thumbnail** is the default, so songs show the
cover image and skip the download unless Video is picked for that split. Set
`STEMKIT_PICTURE=video` to make Video the default instead. Until it arrives, and for songs from
before, the player uses the YouTube embed, which it only corrects for drift above a
second, because every seek makes YouTube rebuffer. A thumbnail song's player has a link
to fetch the video later.

## Storage

Everything persistent is under `/config`: `songs/` (the library), `models/` (optional checkpoints and the demucs weights), `settings.json`, `library.json` and `thumbs/`. The two that grow can be sent elsewhere without moving the rest: mount another volume and point `STEMKIT_SONGS` or `STEMKIT_MODELS` at it (`-v /mnt/user/media/stemkit:/songs -e STEMKIT_SONGS=/songs`). Both are also in the Unraid template under advanced settings. Moving an existing library is a matter of stopping the container, copying `songs/` across and setting the variable. If YouTube starts answering with "sign in to confirm you're not a bot", export a Netscape format `cookies.txt` from a logged in browser and put it at `/config/cookies.txt`.

### Stem storage

The splitter produces 32-bit float WAV, about 20 MB per stem per minute, so a five minute
song split eleven ways (the Best engine plus the drum kit) used to take about 1.2 GB. Once
a split is finished its stems are compressed, in the format set by `STEMKIT_STEM_FORMAT`:

| Value | Five minute song, 11 stems | Against the float original |
| --- | --- | --- |
| `flac16` (default, also when unset) | about 170 MB | about 70 dB clear: CD quality, no audible difference |
| `flac24` | about 365 MB | about 112 dB clear: identical in practice |
| `wav` | about 1.2 GB | exact, stored as split |

Measured on a dense rock track, counting the original audio and the playback copies;
songs with quiet or empty stems come out smaller. For scale, YouTube hands over audio at
around 120 kbps, so even `flac16` keeps far more than the source carries, and the
separation itself is only accurate to about 10 dB.

- It is an environment variable on purpose: whoever runs the container decides how much
  disk the library uses, not anyone with the web page open.
- Downloads and **Export everything** still hand out WAV, at the depth the stems are kept
  at (16 or 24-bit). The export also includes the audio the song was split from.
- The original download is kept as `songs/<id>/source.<ext>`, a few MB, instead of the
  WAV decode of it that older versions kept (ten times the size and no better).
- A stem that goes over full scale would clip in any integer format, so it stays float
  WAV. It is rare, and the log says when it happens.
- An existing library is converted in the background on the first start after updating,
  one song at a time, with a `[storage]` line in the log per song. Converting float WAV to
  `flac16` cannot be undone, although what it drops is far below hearing: set `flac24`
  before updating to keep more. Switching to `wav` later converts nothing back, since that
  would only cost space.

## Development

Developing the web version: `npm run web:build` builds the UI into `out/web` and the server into `out/server`. `npm run web:server` rebuilds and starts the server on port 8080, and `npm run web:dev` runs a Vite dev server that proxies `/api` to it. Point the server at a local Python environment with `STEMKIT_PYTHON`, at ffmpeg with `STEMKIT_FFMPEG`, and at a data folder with `STEMKIT_DATA`. The server code is in `src/server` and reuses the desktop pipeline in `src/main` unchanged (see `scripts/build-server.mjs`).

## Notes

- Downloading audio from YouTube is against YouTube's terms. Keep this personal.
- yt-dlp breaks occasionally when YouTube changes things. The image updates it at
  every start unless `YTDLP_AUTO_UPDATE=false`.

## License

MIT, as upstream. See [LICENSE](LICENSE). The bundled and fetched models keep their own
licenses: YourMT3+ model code from the authors' Hugging Face Space (Apache 2.0, the
GitHub repo is GPL and is not used), Basic Pitch (Apache 2.0), wav2vec2 (Apache 2.0),
and lyrics from LRCLIB. Checkpoints are downloaded at runtime, not redistributed here.
