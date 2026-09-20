import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { userDataDir } from './env'
import { DEFAULT_SETTINGS, SETTINGS_REV, VIDEO_HEIGHTS, type AppSettings } from '../shared/types'

function settingsFile(): string {
  return join(userDataDir(), 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const data = JSON.parse(readFileSync(settingsFile(), 'utf8'))
    return { ...DEFAULT_SETTINGS, ...(data && typeof data === 'object' ? data : {}) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/* A settings file written before the defaults changed keeps the old values
   for ever, since every key is stored explicitly. This moves such a file up
   to the current defaults once, and records that it has been done so a
   setting turned off afterwards stays off. */
/* What each rev changed, applied only to a file written before it: a
   setting turned off after that rev is left alone rather than switched back
   on by a later migration. */
const MIGRATIONS: { rev: number; patch: Partial<AppSettings> }[] = [
  { rev: 1, patch: { gpuSplit: true, downloadVideo: true } },
  { rev: 2, patch: { videoHeight: 720 } }
]

export function migrateSettings(): AppSettings {
  let stored: unknown = null
  try {
    stored = JSON.parse(readFileSync(settingsFile(), 'utf8'))
  } catch {
    // nothing saved yet, so the defaults already apply
    return loadSettings()
  }
  // read the file itself: loadSettings would supply the current rev from the
  // defaults and make every file look up to date
  const rev = stored && typeof stored === 'object' ? Number((stored as { rev?: unknown }).rev ?? 0) : 0
  if (rev >= SETTINGS_REV) return loadSettings()
  const patch = MIGRATIONS.filter((m) => m.rev > rev).reduce((all, m) => ({ ...all, ...m.patch }), {})
  return saveSettings(patch)
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...loadSettings(), ...patch }
  const next: AppSettings = {
    shifts: merged.shifts === 2 ? 2 : 1,
    htdemucsFt: !!merged.htdemucsFt,
    roformerVocals: !!merged.roformerVocals,
    gpuSplit: !!merged.gpuSplit,
    downloadVideo: !!merged.downloadVideo,
    videoHeight: VIDEO_HEIGHTS.includes(Number(merged.videoHeight))
      ? Number(merged.videoHeight)
      : DEFAULT_SETTINGS.videoHeight,
    pauseWhenHidden: merged.pauseWhenHidden !== false,
    rev: SETTINGS_REV
  }
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('settings:changed', next)
  }
  return next
}
