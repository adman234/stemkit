import type { EngineId, SplitOptions, StemId } from './types'

/* Separation engines and per-song options for the web version. The server
   plans a split from these, and the add-song panel describes them with the
   same numbers.

   Scores are median SDR (dB, higher is cleaner) on the 50 MUSDB18 test clips,
   measured for this fork. Guitar, piano and the drum kit have no reference
   stems in that set, so they are not scored. Times are seconds of processing
   per minute of audio, measured on an RTX 4070 SUPER and a desktop CPU. */

export const INSTRUMENTS: StemId[] = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
export const DRUM_KIT: StemId[] = ['kick', 'snare', 'toms', 'hihat', 'ride', 'crash']

export interface EngineInfo {
  id: EngineId
  name: string
  model: string
  blurb: string
  // 1 to 5, for the little meters on the engine cards
  quality: number
  speed: number
  // 4-stem average score, and per stem
  score: number
  scores: Partial<Record<StemId, number>>
  // stems the engine can make, but not well
  roughStems: StemId[]
}

export const ENGINES: EngineInfo[] = [
  {
    id: 'quick',
    name: 'Quick',
    model: 'Demucs v4',
    blurb: 'Fast and solid on drums and bass. Guitar and piano come out rough.',
    quality: 3,
    speed: 5,
    score: 7.8,
    scores: { vocals: 8.5, drums: 9.3, bass: 8.2, other: 5.3 },
    roughStems: ['guitar', 'piano']
  },
  {
    id: 'best',
    name: 'Best',
    model: 'BS-Roformer SW',
    blurb: 'Cleaner on every stem, by about 2 dB on average, with real guitar and piano stems.',
    quality: 5,
    speed: 3,
    score: 10.2,
    scores: { vocals: 11.7, drums: 11.4, bass: 9.6, other: 8.0 },
    roughStems: []
  }
]

export function engineInfo(id: EngineId | undefined): EngineInfo {
  return ENGINES.find((e) => e.id === id) ?? ENGINES[0]
}

export type OptionId = 'studioVocals' | 'secondPass' | 'drumKit' | 'chords'

export interface OptionInfo {
  id: OptionId
  name: string
  // the option does nothing without this instrument selected
  needs?: StemId
  // checkpoints fetched the first time the option is used
  models: ModelId[]
}

export const OPTIONS: OptionInfo[] = [
  { id: 'studioVocals', name: 'Studio vocals', needs: 'vocals', models: ['vocals'] },
  { id: 'secondPass', name: 'Second pass', models: [] },
  { id: 'drumKit', name: 'Split drum kit', needs: 'drums', models: ['drumsep'] },
  { id: 'chords', name: 'Key and chords', models: ['chords'] }
]

export function optionBlurb(id: OptionId, engine: EngineId): string {
  if (id === 'studioVocals') {
    return engine === 'quick'
      ? 'Takes the vocals out first with a dedicated vocal model. Vocals score 11.5 dB instead of 8.5, and less voice leaks into the other stems.'
      : 'Blends in a dedicated vocal model. Vocals score 12.2 dB instead of 11.7.'
  }
  if (id === 'secondPass') {
    return engine === 'quick'
      ? 'Two shifted passes averaged together. A tiny gain in testing, for about twice the work.'
      : 'Twice the overlap between chunks. A tiny gain in testing (under 0.1 dB), for about twice the work.'
  }
  if (id === 'drumKit') {
    return 'Splits the drums into kick, snare, toms, hi-hat, ride and crash, each on its own fader.'
  }
  return 'Works out the key and marks the chords on a timeline you can click through. It listens to the stems without drums or vocals, which is easier to read chords from than the full mix.'
}

/* ---------- model checkpoints ---------- */

export type ModelId = 'vocals' | 'sw' | 'drumsep' | 'chords'

export const MODELS: Record<ModelId, { name: string; sizeMb: number }> = {
  vocals: { name: 'Studio vocals (Mel-Band Roformer)', sizeMb: 913 },
  sw: { name: 'Best engine (BS-Roformer SW)', sizeMb: 699 },
  drumsep: { name: 'Drum kit (MDX23C DrumSep)', sizeMb: 438 },
  chords: { name: 'Key and chords (BTC)', sizeMb: 12 }
}

export function modelsFor(o: SplitOptions): ModelId[] {
  const ids: ModelId[] = []
  if (o.engine === 'best') ids.push('sw')
  if (o.studioVocals && o.stems.includes('vocals')) ids.push('vocals')
  if (o.drumKit && o.stems.includes('drums')) ids.push('drumsep')
  if (o.chords) ids.push('chords')
  return ids
}

/* ---------- planning ---------- */

/* Every instrument, on both engines: the guitar and piano stems cost almost
   nothing (quick switches to the 6-stem demucs, best already separates six),
   and an empty lane is easier to ignore than a missing one is to notice. */
export const DEFAULT_SPLIT: SplitOptions = {
  engine: 'quick',
  stems: [...INSTRUMENTS],
  studioVocals: false,
  secondPass: false,
  drumKit: false,
  chords: true,
  picture: 'video'
}

/* validates options from a client (or localStorage) into a usable shape */
export function normalizeSplit(raw: unknown): SplitOptions {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const engine: EngineId = ENGINES.some((e) => e.id === o.engine) ? (o.engine as EngineId) : 'quick'
  const stems = Array.isArray(o.stems)
    ? INSTRUMENTS.filter((id) => (o.stems as unknown[]).includes(id))
    : [...DEFAULT_SPLIT.stems]
  return {
    engine,
    stems: stems.length ? stems : [...DEFAULT_SPLIT.stems],
    studioVocals: o.studioVocals === true && stems.includes('vocals'),
    secondPass: o.secondPass === true,
    drumKit: o.drumKit === true && stems.includes('drums'),
    chords: o.chords === true,
    picture: o.picture === 'thumbnail' || o.picture === 'video' ? o.picture : undefined
  }
}

/* the stem files a split produces, in display order */
export function outputStems(o: SplitOptions): StemId[] {
  const out: StemId[] = []
  for (const id of INSTRUMENTS) {
    if (!o.stems.includes(id)) continue
    if (id === 'drums' && o.drumKit) out.push(...DRUM_KIT)
    else out.push(id)
  }
  return out
}

/* cache key stored on the song: a re-split with the same tag and stems is
   served from the library */
export function splitTag(o: SplitOptions): string {
  return (
    o.engine +
    (o.studioVocals ? '+vocals' : '') +
    (o.secondPass ? '+2pass' : '') +
    (o.drumKit ? '+kit' : '') +
    (o.chords ? '+chords' : '')
  )
}

export function splitLabel(o: SplitOptions): string {
  const parts = [engineInfo(o.engine).name]
  if (o.studioVocals) parts.push('studio vocals')
  if (o.secondPass) parts.push('second pass')
  if (o.drumKit) parts.push('drum kit')
  if (o.chords) parts.push('chords')
  return parts.join(' · ')
}

/* ---------- time estimates ---------- */

type Step = 'demucs' | 'demucs6' | 'vocals' | 'sw' | 'drumsep' | 'chords'

// seconds of processing per minute of audio
const RATE: Record<'gpu' | 'cpu', Record<Step, number>> = {
  gpu: { demucs: 0.7, demucs6: 0.8, vocals: 2.5, sw: 5.2, drumsep: 1.8, chords: 1.1 },
  cpu: { demucs: 10, demucs6: 11, vocals: 150, sw: 220, drumsep: 75, chords: 5.3 }
}
// the second pass is about the separation models; chord detection ignores it
const SECOND_PASS: Record<Step, number> = {
  demucs: 2.3,
  demucs6: 2.3,
  vocals: 2,
  sw: 2,
  drumsep: 2,
  chords: 1
}
// model load and process start, per step
const OVERHEAD = { gpu: 4, cpu: 6 }
// reading the video, downloading the audio and converting it
const FETCH_SECONDS = 10

export interface PlannedStep {
  step: Step
  seconds: number
}

export function planSteps(o: SplitOptions, minutes: number, gpu: boolean): PlannedStep[] {
  const kind = gpu ? 'gpu' : 'cpu'
  const steps: Step[] = []
  const wantsVocals = o.stems.includes('vocals')
  if (o.studioVocals && wantsVocals) steps.push('vocals')
  if (o.engine === 'best') steps.push('sw')
  else if (o.stems.includes('guitar') || o.stems.includes('piano')) steps.push('demucs6')
  else if (!(o.studioVocals && o.stems.length === 1 && wantsVocals)) steps.push('demucs')
  if (o.drumKit && o.stems.includes('drums')) steps.push('drumsep')
  if (o.chords) steps.push('chords')
  return steps.map((step) => ({
    step,
    seconds: OVERHEAD[kind] + RATE[kind][step] * minutes * (o.secondPass ? SECOND_PASS[step] : 1)
  }))
}

/* whole split, from pasting the link to the song landing in the library */
export function estimateSeconds(o: SplitOptions, minutes: number, gpu: boolean): number {
  return FETCH_SECONDS + planSteps(o, minutes, gpu).reduce((sum, s) => sum + s.seconds, 0)
}

export function fmtEstimate(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds / 5) * 5} s`
  const minutes = seconds / 60
  if (minutes < 10) return `${Math.ceil(minutes * 2) / 2} min`
  return `${Math.ceil(minutes)} min`
}
