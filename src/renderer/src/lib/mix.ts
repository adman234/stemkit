import type { StemId } from '../../../shared/types'

// what the engine plays: not muted, and either nothing is soloed or it is
export function isAudible(id: StemId, mutes: Set<StemId>, solos: Set<StemId>): boolean {
  return !mutes.has(id) && (solos.size === 0 || solos.has(id))
}

/* Flip one stem between heard and silent. A preset like Karaoke works through
   solos, which a single chip cannot show, so any solo state is first folded
   into plain mutes (every stem not heard becomes muted, solos are cleared).
   The chip then always shows, and flips, exactly what is heard. */
export function toggleAudible(
  ids: StemId[],
  mutes: Set<StemId>,
  solos: Set<StemId>,
  id: StemId
): { mutes: Set<StemId>; solos: Set<StemId> } {
  const nextMutes = new Set<StemId>()
  for (const s of ids) if (!isAudible(s, mutes, solos)) nextMutes.add(s)
  if (nextMutes.has(id)) nextMutes.delete(id)
  else nextMutes.add(id)
  return { mutes: nextMutes, solos: new Set<StemId>() }
}
