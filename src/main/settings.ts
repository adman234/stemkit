import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { BrowserWindow } from 'electron'
import { userDataDir } from './env'
import { DEFAULT_SETTINGS, VIDEO_HEIGHTS, type AppSettings } from '../shared/types'

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

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const merged = { ...loadSettings(), ...patch }
  const next: AppSettings = {
    shifts: merged.shifts === 2 ? 2 : 1,
    htdemucsFt: !!merged.htdemucsFt,
    roformerVocals: !!merged.roformerVocals,
    gpuSplit: !!merged.gpuSplit,
    hideVideo: !!merged.hideVideo,
    downloadVideo: !!merged.downloadVideo,
    videoHeight: VIDEO_HEIGHTS.includes(Number(merged.videoHeight))
      ? Number(merged.videoHeight)
      : DEFAULT_SETTINGS.videoHeight
  }
  writeFileSync(settingsFile(), JSON.stringify(next, null, 2))
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('settings:changed', next)
  }
  return next
}
