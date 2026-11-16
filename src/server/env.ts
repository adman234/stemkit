import { spawn, execFile } from 'child_process'
import { existsSync, mkdirSync, createReadStream, createWriteStream, statSync, renameSync, readFileSync, rmSync } from 'fs'
import { createHash } from 'crypto'
import { once } from 'events'
import { Readable } from 'stream'
import { delimiter, dirname, join, resolve } from 'path'
import type { EngineStatus, GpuVendor, ModelStatus } from '../shared/types'
import { MODELS, type ModelId } from '../shared/engines'
import { broadcast } from './events'

/* Web/Docker replacement for src/main/env.ts. The desktop app builds a
   private Python venv on first launch and swaps torch builds on demand; in
   the container every dependency is baked into the image, so this module
   only locates the tools, probes the GPU and fetches the optional model
   checkpoints into the data folder. scripts/build-server.mjs points the
   desktop modules' './env' imports here, so the exports below must keep the
   same signatures (checked by src/server/env-contract.ts) */

export interface ToolInfo {
  found: boolean
  path?: string
  version?: string
}

export interface EnvState {
  python: ToolInfo
  ffmpeg: ToolInfo
  jsRuntime?: { kind: 'deno' | 'node'; path: string }
  ready: boolean
  bootstrapping: boolean
  updating: boolean
}

const IS_WIN = process.platform === 'win32'

const DATA_DIR = resolve(process.env.STEMKIT_DATA ?? '/config')
/* Stems are around 20 MB per stem per minute and the checkpoints come to a
   couple of gigabytes, which is a lot to keep on the flash or SSD that
   usually holds a container's config. Either can be pointed at its own
   mount; left unset they sit under the data folder as before. */
const SONGS_DIR = resolve(process.env.STEMKIT_SONGS ?? join(DATA_DIR, 'songs'))
const MODELS_DIR = resolve(process.env.STEMKIT_MODELS ?? join(DATA_DIR, 'models'))
// out/server/index.js lives two levels below the app root
export const APP_DIR = resolve(process.env.STEMKIT_APP_DIR ?? join(__dirname, '..', '..'))

const PYTHON = process.env.STEMKIT_PYTHON ?? '/opt/venv/bin/python'
const FFMPEG = process.env.STEMKIT_FFMPEG ?? 'ffmpeg'

// "Update yt-dlp" installs here instead of into the image's venv, which is
// read-only for the unprivileged container user and reset on every image
// pull. PYTHONPATH puts it ahead of site-packages for every child process
const PY_OVERRIDES = join(DATA_DIR, 'python-overrides')
process.env.PYTHONPATH = [PY_OVERRIDES, process.env.PYTHONPATH].filter(Boolean).join(delimiter)
process.env.TORCH_HOME = process.env.TORCH_HOME ?? join(MODELS_DIR, 'torch')

const state: EnvState = {
  python: { found: false },
  ffmpeg: { found: false },
  jsRuntime: { kind: 'node', path: process.execPath },
  ready: false,
  bootstrapping: false,
  updating: false
}

export function userDataDir(): string {
  return DATA_DIR
}

export function venvPython(): string {
  return PYTHON
}

export function venvYtDlp(): string {
  if (process.env.STEMKIT_YTDLP) return process.env.STEMKIT_YTDLP
  return join(dirname(PYTHON), IS_WIN ? 'yt-dlp.exe' : 'yt-dlp')
}

export function separateScript(): string {
  return join(APP_DIR, 'python', 'separate.py')
}

export function roformerScript(): string {
  return join(APP_DIR, 'python', 'roformer.py')
}

export function msstScript(): string {
  return join(APP_DIR, 'python', 'msst.py')
}

export function keyScript(): string {
  return join(APP_DIR, 'python', 'key.py')
}

export function chordsScript(): string {
  return join(APP_DIR, 'python', 'chords.py')
}

export function notesScript(): string {
  return join(APP_DIR, 'python', 'notes.py')
}

export function notesYmt3Script(): string {
  return join(APP_DIR, 'python', 'notes_ymt3.py')
}

export function lyricsAlignScript(): string {
  return join(APP_DIR, 'python', 'lyrics_align.py')
}

export function modelsDir(): string {
  return MODELS_DIR
}

export function songsDir(): string {
  return SONGS_DIR
}

export function cookiesFile(): string {
  return join(DATA_DIR, 'cookies.txt')
}

export function appVersion(): string {
  // the image stamps the commit in, so a stale container is obvious
  const build = (process.env.STEMKIT_BUILD ?? '').slice(0, 7)
  try {
    const pkg = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8'))
    return `${pkg.version}-web${build ? ` · ${build}` : ''}`
  } catch {
    return `web${build ? ` · ${build}` : ''}`
  }
}

export function sendEnvEvent(message: string, level: 'info' | 'error' | 'success' = 'info'): void {
  const line = `[env] ${message}`
  if (level === 'error') console.error(line)
  else console.log(line)
  broadcast('env:event', { message, level })
}

function runCapture(cmd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout, env: process.env }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split('\n').slice(-1)[0]))
      else resolve(stdout)
    })
  })
}

/* yt-dlp needs a JavaScript runtime for YouTube's player challenges; the
   server's own node binary does the job. A Netscape cookies.txt in the data
   folder is passed along when present, which gets past the "sign in to
   confirm you're not a bot" wall that datacenter and busy home IPs hit */
export function ytDlpRuntimeArgs(): string[] {
  const args: string[] = []
  if (state.jsRuntime) args.push('--js-runtimes', `${state.jsRuntime.kind}:${state.jsRuntime.path}`)
  if (existsSync(cookiesFile())) args.push('--cookies', cookiesFile())
  return args
}

let toolsProbe: Promise<void> | null = null
let probing = false

async function probeTools(): Promise<void> {
  try {
    const out = await runCapture(
      PYTHON,
      [
        '-c',
        'import sys, torch, demucs, yt_dlp, yaml, einops, beartype, rotary_embedding_torch, packaging;' +
          'print("%d.%d.%d" % sys.version_info[:3]); print(torch.__version__); print(yt_dlp.version.__version__)'
      ],
      180000
    )
    const [version, torch, ytdlp] = out.trim().split(/\r?\n/)
    state.python = { found: true, path: PYTHON, version }
    console.log(`[env] python ${version}, torch ${torch}, yt-dlp ${ytdlp}`)
  } catch (err) {
    state.python = { found: false }
    sendEnvEvent(
      `Python engine not usable at ${PYTHON}: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    )
  }
  try {
    const out = await runCapture(FFMPEG, ['-hide_banner', '-version'], 15000)
    state.ffmpeg = { found: true, path: FFMPEG, version: out.split(/\s+/)[2] }
  } catch (err) {
    state.ffmpeg = { found: false }
    sendEnvEvent(`ffmpeg not found (${FFMPEG}): ${err instanceof Error ? err.message : String(err)}`, 'error')
  }
  state.ready =
    state.python.found &&
    state.ffmpeg.found &&
    existsSync(separateScript()) &&
    existsSync(roformerScript()) &&
    existsSync(msstScript())
}

/* importing torch takes a few seconds, so a successful probe is cached and
   concurrent callers share the one in flight. A failed probe runs again on
   the next call, and force re-runs it regardless (setup screen retry) */
export function detectTools(force = false): Promise<void> {
  if (toolsProbe && (probing || (state.ready && !force))) return toolsProbe
  probing = true
  toolsProbe = probeTools().finally(() => {
    probing = false
  })
  return toolsProbe
}

export function getStatus(): EnvState {
  return { ...state }
}

/* ---------- GPU ---------- */

let gpuProbe: Promise<boolean> | null = null
let gpuInfo: boolean | undefined
let gpuName: string | undefined
let gpuBuild: GpuVendor | undefined

/* torch answers to torch.cuda on both of its GPU builds; torch.version.hip
   is only set on the ROCm one, which is how an AMD image is told apart */
export function hasGpuAcceleration(): Promise<boolean> {
  if (process.env.STEMKIT_FORCE_CPU === '1') {
    gpuInfo = false
    return Promise.resolve(false)
  }
  if (!gpuProbe) {
    gpuProbe = runCapture(
      PYTHON,
      [
        '-c',
        'import torch\n' +
          'ok = torch.cuda.is_available()\n' +
          'print(1 if ok else 0)\n' +
          'print(torch.cuda.get_device_name(0) if ok else "")\n' +
          'print("amd" if getattr(torch.version, "hip", None) else "nvidia")'
      ],
      60000
    )
      .then((out) => {
        const [flag, name, build] = out.trim().split(/\r?\n/)
        gpuName = name?.trim() || undefined
        gpuBuild = build?.trim() === 'amd' ? 'amd' : 'nvidia'
        return flag?.trim() === '1'
      })
      .catch(() => false)
      .then(async (gpu) => {
        if (gpu && gpuBuild === 'amd') await applyGfxOverride()
        gpuInfo = gpu
        const api = gpuBuild === 'amd' ? 'ROCm' : 'CUDA'
        console.log(gpu ? `[env] ${api} available: ${gpuName}` : `[env] no ${api} device, splits run on the CPU`)
        return gpu
      })
  }
  return gpuProbe
}

/* The ROCm wheels only carry kernels for some targets. Consumer RDNA2 and
   RDNA3 parts (RX 6600 = gfx1032, 7600 = gfx1102, 680M = gfx1035) run the
   nearest code object once HSA_OVERRIDE_GFX_VERSION says which; RDNA4 is
   supported as is. From upstream's desktop engine. A value set on the
   container wins */
function gfxOverride(gfx: string): string | null {
  const id = parseInt((gfx.match(/gfx(\d+)/) ?? [])[1] ?? '', 10)
  if (Number.isNaN(id)) return null
  if (id >= 1010 && id <= 1039) return '10.3.0'
  if (id >= 1101 && id <= 1103) return '11.0.0'
  return null
}

async function applyGfxOverride(): Promise<void> {
  if (process.env.HSA_OVERRIDE_GFX_VERSION) return
  const gfx = await runCapture(
    PYTHON,
    [
      '-c',
      'import torch;p=torch.cuda.get_device_properties(0);print(getattr(p,"gcnArchName","") or "gfx%d%02d" % (p.major, p.minor))'
    ],
    60000
  ).catch(() => '')
  const override = gfxOverride(gfx)
  if (!override) return
  // every python process the server starts from here on inherits it
  process.env.HSA_OVERRIDE_GFX_VERSION = override
  console.log(`[env] ${gfx.trim()} runs with HSA_OVERRIDE_GFX_VERSION=${override}`)
}

export function gpuAccelerationInfo(): boolean | undefined {
  return gpuInfo
}

let vendorProbe: Promise<GpuVendor | undefined> | null = null
let vendorInfo: GpuVendor | undefined

/* gates the GPU toggle in Settings. Only a GPU that torch can actually use
   counts: the desktop toggle offers a torch download, which the image does
   not need. A card the driver tool sees but torch cannot use (usually a host
   driver too old for the image's build) is logged instead */
export function detectGpuVendor(): Promise<GpuVendor | undefined> {
  if (!vendorProbe) {
    vendorProbe = hasGpuAcceleration().then(async (ok) => {
      if (!ok) {
        const smi =
          gpuBuild === 'amd'
            ? await runCapture('rocm-smi', ['--showproductname'], 10000).catch(() => '')
            : await runCapture('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], 10000).catch(
                () => ''
              )
        if (smi.trim()) {
          console.error(
            gpuBuild === 'amd'
              ? '[env] rocm-smi sees a GPU but torch cannot use it. Pass /dev/kfd and /dev/dri through to the container.'
              : `[env] nvidia-smi sees "${smi.trim()}" but torch cannot use it. The image needs NVIDIA driver 570 or newer.`
          )
        }
      }
      vendorInfo = ok ? gpuBuild : undefined
      return vendorInfo
    })
  }
  return vendorProbe
}

export function gpuVendorInfo(): GpuVendor | undefined {
  return vendorInfo
}

/* the image already ships GPU torch, so there is nothing to download: the
   engine is "ready" exactly when a GPU is visible inside the container */
export async function ensureGpuEngine(
  onProgress?: (pct: number) => void,
  _requireVendor?: GpuVendor | null,
  _force = false
): Promise<boolean> {
  const ok = await hasGpuAcceleration()
  // the pipeline passes a progress callback on every split; only the
  // Settings button (no callback) needs the status line
  if (!onProgress) {
    if (ok) sendEnvEvent('GPU engine ready', 'success')
    else
      sendEnvEvent(
        gpuBuild === 'amd'
          ? 'GPU engine install failed: no ROCm device is visible inside the container. Pass /dev/kfd and /dev/dri through and restart it.'
          : 'GPU engine install failed: no CUDA device is visible inside the container. Pass the GPU through (--runtime=nvidia) and restart it.',
        'error'
      )
  }
  return ok
}

/* ---------- engine components ---------- */

let engineDepsReady = false

export async function ensureEngineDeps(): Promise<boolean> {
  if (engineDepsReady) return true
  try {
    await runCapture(PYTHON, ['-c', 'import beartype, rotary_embedding_torch, einops'], 60000)
    engineDepsReady = true
    return true
  } catch (err) {
    sendEnvEvent(
      `Engine components missing from the image: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    )
    return false
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/* the checkpoints are pickles torch loads with weights_only off, so a file
   swapped upstream (or cut short and resumed wrongly) would run as code.
   Each one is pinned to a revision and checked against its known hash before
   it takes its final name; a mismatch is thrown away so the retry starts
   clean */
async function finishDownload(part: string, dest: string, label: string, sha256?: string): Promise<void> {
  if (sha256) {
    const got = await sha256File(part)
    if (got !== sha256) {
      rmSync(part, { force: true })
      throw new Error(`${label} failed its checksum (got ${got.slice(0, 12)}…, expected ${sha256.slice(0, 12)}…)`)
    }
  }
  renameSync(part, dest)
}

export async function downloadTo(
  url: string,
  dest: string,
  label: string,
  onProgress?: (pct: number) => void,
  sha256?: string
): Promise<void> {
  // download into <dest>.part so an interrupted fetch can resume and a
  // partial file is never mistaken for the real one; rename on success
  const part = dest + '.part'
  const base = existsSync(part) ? statSync(part).size : 0
  const res = await fetch(url, {
    redirect: 'follow',
    headers: base > 0 ? { Range: `bytes=${base}-` } : {}
  })
  if (res.status === 416 && base > 0) {
    // the .part already holds the whole file (killed right before the rename)
    await finishDownload(part, dest, label, sha256)
    onProgress?.(100)
    return
  }
  if ((res.status !== 200 && res.status !== 206) || !res.body) {
    throw new Error(`${label} download failed (HTTP ${res.status})`)
  }
  const resumed = res.status === 206 && base > 0
  const start = resumed ? base : 0
  const total = start + Number(res.headers.get('content-length') ?? 0)
  const out = createWriteStream(part, { flags: resumed ? 'a' : 'w' })
  let done = 0
  let lastPct = -1
  try {
    for await (const chunk of Readable.fromWeb(res.body as import('stream/web').ReadableStream)) {
      done += chunk.length
      if (!out.write(chunk)) await once(out, 'drain')
      if (total > 0) {
        const pct = Math.floor(((start + done) / total) * 100)
        if (pct > lastPct) {
          if (pct >= lastPct + 2) sendEnvEvent(`${label}: ${pct}%`)
          lastPct = pct
          onProgress?.(pct)
        }
      }
    }
  } finally {
    await new Promise<void>((resolve) => out.end(resolve))
  }
  await finishDownload(part, dest, label, sha256)
  onProgress?.(100)
}

/* Mel-band roformer vocals checkpoint (~913MB), fetched into the data folder
   when "studio-quality vocals" is enabled, and awaited by the pipeline so a
   split never races the download */
const CKPT_NAME = 'MelBandRoformer.ckpt'
const CKPT_URL =
  'https://huggingface.co/KimberleyJSN/melbandroformer/resolve/ac9b0614ab3cd7f77219e18ba494dfd93956c348/MelBandRoformer.ckpt'
const CKPT_SHA256 = '87201f4d31afb5bc79993230fc49446918425574db48c01c405e44f365c7559e'

export function vocalsEnginePath(): string {
  return join(modelsDir(), CKPT_NAME)
}

let vocalsEnginePromise: Promise<boolean> | null = null
let vocalsPct: number | undefined
const vocalsProgressListeners = new Set<(pct: number) => void>()

export function ensureVocalsEngine(onProgress?: (pct: number) => void): Promise<boolean> {
  if (onProgress) vocalsProgressListeners.add(onProgress)
  const detach = (ok: boolean): boolean => {
    if (onProgress) vocalsProgressListeners.delete(onProgress)
    return ok
  }
  if (existsSync(vocalsEnginePath())) return Promise.resolve(detach(true))
  if (!vocalsEnginePromise) {
    vocalsEnginePromise = (async () => {
      mkdirSync(modelsDir(), { recursive: true })
      sendEnvEvent('Downloading the vocals engine (~913MB, one time)')
      await downloadTo(
        CKPT_URL,
        vocalsEnginePath(),
        'vocals engine',
        (pct) => {
          vocalsPct = pct
          for (const listener of vocalsProgressListeners) listener(pct)
        },
        CKPT_SHA256
      )
      sendEnvEvent('Vocals engine ready', 'success')
      return true
    })()
      .catch((err) => {
        sendEnvEvent(
          `Vocals engine download failed: ${err instanceof Error ? err.message : String(err)}. It will retry before the next split.`,
          'error'
        )
        return false
      })
      .finally(() => {
        vocalsEnginePromise = null
        vocalsPct = undefined
      })
  }
  return vocalsEnginePromise.then(detach)
}

/* htdemucs_ft is a bag of 4 checkpoints fetched through demucs' own torch-hub
   loader, so the cache location (TORCH_HOME) matches what separate.py reads */
let ftWeightsPromise: Promise<boolean> | null = null
const ftProgressListeners = new Set<(pct: number) => void>()
let ftVerified = false
const FT_BAG_COUNT = 4

function torchHubFetch(model: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      PYTHON,
      ['-c', `from demucs.pretrained import get_model; get_model(${JSON.stringify(model)})`],
      { env: process.env }
    )
    let lastPct = 0
    let filesDone = 0
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1000)
      for (const piece of chunk.toString().split(/[\r\n]/)) {
        const m = piece.match(/(\d{1,3})%/)
        if (!m) continue
        const pct = Math.min(100, parseInt(m[1], 10))
        if (pct < lastPct) filesDone = Math.min(filesDone + 1, FT_BAG_COUNT - 1)
        lastPct = pct
        const overall = Math.min(99, Math.round(((filesDone + pct / 100) / FT_BAG_COUNT) * 100))
        sendEnvEvent(`fine-tuned engine: ${overall}%`)
        onProgress?.(overall)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onProgress?.(100)
        resolve()
      } else {
        reject(
          new Error(
            stderrTail.split('\n').filter(Boolean).slice(-1).join('') ||
              `fine-tuned engine download exited ${code}`
          )
        )
      }
    })
  })
}

export function ensureFtWeights(onProgress?: (pct: number) => void): Promise<boolean> {
  if (onProgress) ftProgressListeners.add(onProgress)
  const detach = (ok: boolean): boolean => {
    if (onProgress) ftProgressListeners.delete(onProgress)
    return ok
  }
  if (!ftWeightsPromise) {
    ftWeightsPromise = (async () => {
      if (!ftVerified) sendEnvEvent('Checking the fine-tuned engine (~320MB download the first time)')
      await torchHubFetch('htdemucs_ft', (pct) => {
        for (const listener of ftProgressListeners) listener(pct)
      })
      if (!ftVerified) sendEnvEvent('Fine-tuned engine ready', 'success')
      ftVerified = true
      return true
    })()
      .catch((err) => {
        sendEnvEvent(
          `Fine-tuned engine download failed: ${err instanceof Error ? err.message : String(err)}. It will retry before the next split.`,
          'error'
        )
        return false
      })
      .finally(() => {
        ftWeightsPromise = null
      })
  }
  return ftWeightsPromise.then(detach)
}

/* checkpoints for the web engines, fetched into the models folder on first
   use. The vocals model keeps its own downloader above, shared with the
   desktop code path. Every url is pinned (a commit, a tag, or a release
   asset whose hash is checked) and every file carries its sha256; bumping a
   model means updating both */
const MODEL_FILES: Record<Exclude<ModelId, 'vocals'>, { file: string; url: string; sha256: string }> = {
  sw: {
    file: 'BS-Roformer-SW.ckpt',
    url: 'https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/BS-Roformer-SW.ckpt',
    sha256: '24e7d35ee9c64415673d3fd33e06a67cac2c103c5df6267ba1576459c775916e'
  },
  drumsep: {
    file: 'MDX23C-DrumSep-aufr33-jarredou.ckpt',
    url: 'https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs/MDX23C-DrumSep-aufr33-jarredou.ckpt',
    sha256: 'd2a4aa53eb584d21eead358a4e66d1882ad182911be018f052b5da73be9096d0'
  },
  chords: {
    file: 'btc_model_large_voca.ckpt',
    url: 'https://raw.githubusercontent.com/jayg996/BTC-ISMIR19/2682317be668032e6e4b269ded36adaa2ad57df0/test/btc_model_large_voca.pt',
    sha256: '1673d23f8f9a55ae7f9e8b80a51da616debb22675b8d8b67ea6ce0ef37b0ab51'
  },
  notes: {
    file: 'basic-pitch-icassp2022.onnx',
    url: 'https://raw.githubusercontent.com/spotify/basic-pitch/v0.4.0/basic_pitch/saved_models/icassp_2022/nmp.onnx',
    sha256: '2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec'
  },
  // the YPTF.MoE+Multi (noPS) checkpoint from the authors' Hugging Face Space,
  // pinned so a change there cannot swap what runs here. The model code is
  // fetched separately by notes_ymt3.py on first use (same revision)
  'notes-ymt3': {
    file: 'yourmt3-yptf-moe-multi-nops.ckpt',
    url: 'https://huggingface.co/spaces/mimbres/YourMT3/resolve/5e66c1ea173a8186e0d20432b841d3180cc015b5/amt/logs/2024/mc13_256_g4_all_v7_mt3f_sqr_rms_moe_wf4_n8k2_silu_rope_rp_b36_nops/checkpoints/last.ckpt',
    sha256: 'ae38e415c79efd5592dcb9b658cdb99ddb11d4c4e1eaa364cab04a052473fc25'
  },
  // facebook/wav2vec2-base-960h, pinned, for lyrics forced alignment
  lyrics: {
    file: 'wav2vec2-base-960h.safetensors',
    url: 'https://huggingface.co/facebook/wav2vec2-base-960h/resolve/22aad52d435eb6dbaf354bdad9b0da84ce7d6156/model.safetensors',
    sha256: '8aa76ab2243c81747a1f832954586bc566090c83a0ac167df6f31f0fa917d74a'
  }
}

const modelPromises = new Map<ModelId, Promise<boolean>>()
const modelProgress = new Map<ModelId, number>()
const modelListeners = new Map<ModelId, Set<(pct: number) => void>>()

function modelPath(id: ModelId): string {
  return id === 'vocals' ? vocalsEnginePath() : join(modelsDir(), MODEL_FILES[id].file)
}

export function ensureModel(id: ModelId, onProgress?: (pct: number) => void): Promise<boolean> {
  if (id === 'vocals') return ensureVocalsEngine(onProgress)
  if (existsSync(modelPath(id))) return Promise.resolve(true)
  let listeners = modelListeners.get(id)
  if (!listeners) {
    listeners = new Set()
    modelListeners.set(id, listeners)
  }
  if (onProgress) listeners.add(onProgress)
  let promise = modelPromises.get(id)
  if (!promise) {
    const { name, sizeMb } = MODELS[id]
    promise = (async () => {
      mkdirSync(modelsDir(), { recursive: true })
      sendEnvEvent(`Downloading ${name} (${sizeMb} MB, one time)`)
      await downloadTo(
        MODEL_FILES[id].url,
        modelPath(id),
        `${name}`,
        (pct) => {
          modelProgress.set(id, pct)
          for (const listener of modelListeners.get(id) ?? []) listener(pct)
        },
        MODEL_FILES[id].sha256
      )
      sendEnvEvent(`${name} ready`, 'success')
      return true
    })()
      .catch((err) => {
        sendEnvEvent(
          `${name} download failed: ${err instanceof Error ? err.message : String(err)}. It will retry on the next split.`,
          'error'
        )
        return false
      })
      .finally(() => {
        modelPromises.delete(id)
        modelProgress.delete(id)
      })
    modelPromises.set(id, promise)
  }
  return promise.then((ok) => {
    if (onProgress) listeners?.delete(onProgress)
    return ok
  })
}

function modelStatus(): ModelStatus[] {
  return (Object.keys(MODELS) as ModelId[]).map((id) => {
    const downloading = id === 'vocals' ? vocalsEnginePromise !== null : modelPromises.has(id)
    return {
      id,
      name: MODELS[id].name,
      sizeMb: MODELS[id].sizeMb,
      ready: existsSync(modelPath(id)),
      downloading,
      pct: id === 'vocals' ? vocalsPct : modelProgress.get(id)
    }
  })
}

export function engineStatus(): EngineStatus {
  return {
    vocalsDownloading: vocalsEnginePromise !== null,
    vocalsReady: existsSync(vocalsEnginePath()),
    ftDownloading: ftWeightsPromise !== null,
    ftVerified,
    gpuDownloading: false,
    gpuReady: gpuInfo === true,
    models: modelStatus()
  }
}

/* ---------- yt-dlp ---------- */

export async function updateYtDlp(): Promise<boolean> {
  if (state.updating) return false
  state.updating = true
  try {
    sendEnvEvent('Updating yt-dlp...')
    mkdirSync(PY_OVERRIDES, { recursive: true })
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        PYTHON,
        [
          '-m',
          'pip',
          'install',
          '-q',
          '--disable-pip-version-check',
          '--no-cache-dir',
          '--no-deps',
          '--upgrade',
          '--target',
          PY_OVERRIDES,
          'yt-dlp',
          'yt-dlp-ejs'
        ],
        { env: process.env }
      )
      let stderrTail = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString()).slice(-600)
      })
      child.on('close', (code) =>
        code === 0
          ? resolve()
          : reject(new Error(stderrTail.trim().split('\n').slice(-1)[0] || `pip exited ${code}`))
      )
      child.on('error', reject)
    })
    const version = await runCapture(PYTHON, ['-c', 'import yt_dlp; print(yt_dlp.version.__version__)'], 60000)
    sendEnvEvent(`yt-dlp updated (${version.trim()})`, 'success')
    return true
  } catch (err) {
    sendEnvEvent(`yt-dlp update failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
    return false
  } finally {
    state.updating = false
  }
}
