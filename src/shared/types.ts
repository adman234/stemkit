export type StemId =
  | 'vocals'
  | 'drums'
  | 'bass'
  | 'other'
  | 'piano'
  | 'guitar'
  // pieces of the drums stem, when the drum kit split is on
  | 'kick'
  | 'snare'
  | 'toms'
  | 'hihat'
  | 'ride'
  | 'crash'

// web version: which separation engine a split uses (see shared/engines.ts)
export type EngineId = 'quick' | 'best'

export interface SplitOptions {
  engine: EngineId
  // instruments asked for: vocals, drums, bass, guitar, piano, other
  stems: StemId[]
  // dedicated vocal model (Mel-Band Roformer) in addition to the engine
  studioVocals: boolean
  // denser overlap (Demucs: two shifted passes); small gain, about twice the time
  secondPass: boolean
  // split the drums stem into kick, snare, toms, hi-hat, ride and crash
  drumKit: boolean
  // work out the key and the chord progression
  chords: boolean
  // what plays beside the stems: the video, downloaded to stay in step, or
  // only the cover image. Absent on songs from before the choice existed
  picture?: 'video' | 'thumbnail'
}

export interface ChordSegment {
  start: number
  end: number
  // the chord as shown, e.g. 'F#:min7', or 'N' for no chord
  label: string
  // what the model said before rare qualities were folded in
  raw: string
  // set when the chord was corrected by hand in the player
  user?: string
}

export interface ChordData {
  key: {
    tonic: string
    mode: string
    name: string
    // 0 to 1: how far clear of the best key that is not the relative one
    confidence: number
    alternative: string
    relative: string
  }
  tempo: number | null
  beats: number[]
  segments: ChordSegment[]
  duration: number
  // which audio it listened to
  source: string
  model: string
}

export interface ModelStatus {
  id: string
  name: string
  sizeMb: number
  ready: boolean
  downloading: boolean
  pct?: number
}

export const DEFAULT_STEMS: string[] = ['vocals', 'drums', 'bass', 'other']

// roformer_hybrid = mel-band roformer vocals + htdemucs drums/bass/other
export const MODEL_DEFAULT = 'roformer_hybrid'
export const MODEL_EXTENDED = 'htdemucs_6s'

export interface Song {
  videoId: string
  title: string
  duration: number
  addedAt: number
  model?: string
  stems?: string[]
  took?: number
  // web version: the engine and options the song was split with
  options?: SplitOptions
  // web version: a downloaded video file is on the server for this song
  video?: boolean
  // web version: key and chords have been worked out for this song
  chords?: boolean
  // web version: when the stems were last loaded for playing, which is what
  // STEMKIT_KEEP_DAYS measures a song's age from
  lastPlayedAt?: number
}

// web version: progress of a video download
export interface VideoEvent {
  videoId: string
  pct?: number
  ready?: boolean
  error?: string
}

// web version: progress of chord detection on a song already in the library
export interface ChordsEvent {
  videoId: string
  running?: boolean
  ready?: boolean
  error?: string
}

export interface AppSettings {
  shifts: 1 | 2
  htdemucsFt: boolean
  roformerVocals: boolean
  // windows/linux + nvidia: separate on the GPU instead of the CPU. The toggle is
  // only rendered when an NVIDIA GPU is detected; enabling it downloads the
  // CUDA build of torch (~2.5GB) on first use
  gpuSplit: boolean
  // web version: also download the video with each split, so playback runs
  // from the server instead of streaming from YouTube
  downloadVideo: boolean
  // tallest video to download (360, 480 or 720)
  videoHeight: number
  // on a touch device, stop playing when the app goes to the background
  pauseWhenHidden: boolean
  // which set of defaults this file was written against, so a change to them
  // reaches an install that already has a settings file
  rev?: number
}

export const SETTINGS_REV = 2

export const DEFAULT_SETTINGS: AppSettings = {
  shifts: 1,
  htdemucsFt: false,
  roformerVocals: false,
  gpuSplit: true,
  downloadVideo: true,
  videoHeight: 720,
  pauseWhenHidden: true,
  rev: SETTINGS_REV
}

export const VIDEO_HEIGHTS = [360, 480, 720]

export interface EngineStatus {
  vocalsDownloading: boolean
  vocalsReady: boolean
  ftDownloading: boolean
  ftVerified: boolean
  // cuda torch engine (windows/linux + nvidia only)
  gpuDownloading: boolean
  gpuReady: boolean
  // web version: optional model checkpoints and their download state
  models?: ModelStatus[]
}

export interface EnvStatus {
  python: { found: boolean; path?: string; version?: string }
  ffmpeg: { found: boolean; path?: string }
  ready: boolean
  bootstrapping: boolean
  updating: boolean
  gpu?: boolean
  // windows/linux only: an NVIDIA GPU was detected (gates the GPU toggle in Settings)
  nvidiaGpu?: boolean
}

export interface EnvEvent {
  message: string
  level: 'info' | 'error' | 'success'
}

export type JobStage = 'metadata' | 'download' | 'convert' | 'separate' | 'finalize'

export interface JobProgress {
  videoId: string
  title?: string
  stage: JobStage
  pct: number
  message?: string
  model?: string
}

export interface JobDone {
  videoId: string
  song: Song
}

export interface JobFailed {
  videoId: string
  message: string
}

export type JobEvent =
  | { kind: 'progress'; data: JobProgress }
  | { kind: 'done'; data: JobDone }
  | { kind: 'failed'; data: JobFailed }

export interface SearchResult {
  videoId: string
  title: string
  channel?: string
  duration?: number
}

export interface UpdateEvent {
  status: 'checking' | 'available' | 'none' | 'progress' | 'downloaded' | 'error'
  version?: string
  pct?: number
}

export interface StemKitApi {
  envStatus(): Promise<EnvStatus>
  envBootstrap(): Promise<boolean>
  envUpdateYtDlp(): Promise<boolean>
  listSongs(): Promise<Song[]>
  deleteSong(videoId: string): Promise<void>
  getBuffers(videoId: string): Promise<Record<string, Uint8Array>>
  // web version: the playback formats this browser can decode, best first
  stemFormats?(): string[]
  // web version: one stem at a time, so a phone never holds the whole song
  // in memory twice over. compressed is false when it fell back to the WAV
  getStemBuffer?(
    videoId: string,
    stem: string,
    format?: string
  ): Promise<{ bytes: Uint8Array; compressed: boolean; type?: string; format?: string }>
  exportStem(videoId: string, stem: string): Promise<{ saved: boolean; path?: string }>
  exportAllStems(videoId: string): Promise<{ saved: boolean; path?: string; count?: number }>
  searchYouTube(query: string): Promise<SearchResult[]>
  // options is only understood by the web server; the desktop app ignores it
  startJob(
    url: string,
    model?: string,
    stems?: string[],
    options?: SplitOptions
  ): Promise<{ started: boolean }>
  cancelJob(videoId?: string): Promise<void>
  openExternal(url: string): Promise<void>
  getAppVersion(): Promise<string>
  installUpdate(): void
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getThumb(videoId: string): Promise<string | null>
  onThumbCached(cb: (videoId: string) => void): () => void
  enginesStatus(): Promise<EngineStatus>
  fetchEngine(which: string): Promise<void>
  onUpdateEvent(cb: (ev: UpdateEvent) => void): () => void
  onJobEvent(cb: (ev: JobEvent) => void): () => void
  onEnvEvent(cb: (ev: EnvEvent) => void): () => void
  onSettingsChange(cb: (settings: AppSettings) => void): () => void
  // web version only: downloading the video for local playback
  fetchVideo?(videoId: string): Promise<void>
  onVideoEvent?(cb: (ev: VideoEvent) => void): () => void
  // web version only: key and chords
  getChords?(videoId: string): Promise<ChordData | null>
  detectChords?(videoId: string): Promise<void>
  // corrects one chord by hand; null puts the detected one back
  setChordLabel?(videoId: string, start: number, label: string | null): Promise<ChordData>
  onChordsEvent?(cb: (ev: ChordsEvent) => void): () => void
}
