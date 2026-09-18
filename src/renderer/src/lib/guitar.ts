import shapes from './guitar-chords.json'

/* Guitar voicings for the chords the timeline shows. guitar-chords.json is a
   committed subset of chords-db (github.com/tombatossals/chords-db, MIT):
   the twelve roots, the eight qualities the timeline uses, three shapes each,
   which is 22 KB instead of the 900 KB database */

export interface GuitarShape {
  // one entry per string, low E first: -1 is muted, 0 is open
  frets: number[]
  fingers: number[]
  // the fret the diagram starts at
  baseFret: number
  // fret numbers that are barred
  barres: number[]
}

const TABLE = shapes as Record<string, GuitarShape[]>

/* 'F#:min7' and 'C' both have to find their way into the table */
export function shapesFor(label: string): GuitarShape[] {
  if (!label || label === 'N') return []
  const [root, quality] = label.split(':')
  return TABLE[`${root}:${quality ?? 'maj'}`] ?? []
}
