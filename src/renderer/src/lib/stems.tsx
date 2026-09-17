import type { StemId } from '../../../shared/types'
import { MicIcon, DrumIcon, BassIcon, WaveIcon, PianoIcon, GuitarIcon } from '../components/Icons'

export interface StemMeta {
  id: StemId
  label: string
  color: string
  icon: React.ReactNode
}

const ALL_META: Record<StemId, StemMeta> = {
  vocals: { id: 'vocals', label: 'vocals', color: '#A78BFA', icon: <MicIcon /> },
  drums: { id: 'drums', label: 'drums', color: '#F87171', icon: <DrumIcon /> },
  bass: { id: 'bass', label: 'bass', color: '#60A5FA', icon: <BassIcon /> },
  guitar: { id: 'guitar', label: 'guitar', color: '#F472B6', icon: <GuitarIcon /> },
  piano: { id: 'piano', label: 'piano', color: '#FBBF24', icon: <PianoIcon /> },
  other: { id: 'other', label: 'other', color: '#34D399', icon: <WaveIcon /> },
  // drum kit pieces (web version's drum kit split), in the drums' reds
  kick: { id: 'kick', label: 'kick', color: '#EF4444', icon: <DrumIcon /> },
  snare: { id: 'snare', label: 'snare', color: '#F97316', icon: <DrumIcon /> },
  toms: { id: 'toms', label: 'toms', color: '#FB7185', icon: <DrumIcon /> },
  hihat: { id: 'hihat', label: 'hi-hat', color: '#FDBA74', icon: <DrumIcon /> },
  ride: { id: 'ride', label: 'ride', color: '#FCA5A5', icon: <DrumIcon /> },
  crash: { id: 'crash', label: 'crash', color: '#FECDD3', icon: <DrumIcon /> }
}

const PREFERRED_ORDER: StemId[] = [
  'vocals',
  'drums',
  'kick',
  'snare',
  'toms',
  'hihat',
  'ride',
  'crash',
  'bass',
  'guitar',
  'piano',
  'other'
]

export { ALL_META as STEM_INFO, PREFERRED_ORDER }

export function buildStemMeta(available: StemId[]): StemMeta[] {
  return PREFERRED_ORDER.filter((id) => available.includes(id)).map((id) => ALL_META[id])
}
