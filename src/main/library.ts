import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { songsDir, userDataDir } from './env'
import { DEFAULT_STEMS, type Song } from '../shared/types'

function libraryFile(): string {
  return join(userDataDir(), 'library.json')
}

function songsRoot(): string {
  return songsDir()
}

export function songDir(videoId: string): string {
  return join(songsRoot(), videoId)
}

export function stemsDir(videoId: string): string {
  return join(songDir(videoId), 'stems')
}

export function mixWavPath(videoId: string): string {
  return join(songDir(videoId), 'mix.wav')
}

export function rawDownloadPath(videoId: string): string {
  return join(songDir(videoId), 'raw.%(ext)s')
}

export function loadSongs(): Song[] {
  try {
    const raw = readFileSync(libraryFile(), 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data.songs) ? data.songs : []
  } catch {
    return []
  }
}

export function saveSongs(songs: Song[]): void {
  mkdirSync(userDataDir(), { recursive: true })
  writeFileSync(libraryFile(), JSON.stringify({ songs }, null, 2))
}

export function upsertSong(song: Song): Song[] {
  const songs = loadSongs().filter((s) => s.videoId !== song.videoId)
  songs.unshift(song)
  saveSongs(songs)
  return songs
}

export function removeSong(videoId: string): Song[] {
  const songs = loadSongs().filter((s) => s.videoId !== videoId)
  saveSongs(songs)
  rmSync(songDir(videoId), { recursive: true, force: true })
  return songs
}

export function stemsFor(song?: Song | null): string[] {
  return song?.stems?.length ? song.stems : DEFAULT_STEMS
}

export function stemsPresent(videoId: string, stems: string[]): boolean {
  const dir = stemsDir(videoId)
  if (!existsSync(dir)) return false
  return stems.every((name) => existsSync(join(dir, `${name}.wav`)))
}

export async function stemBuffers(videoId: string, stems?: string[]): Promise<Record<string, Uint8Array>> {
  const list = stems ?? stemsFor(loadSongs().find((s) => s.videoId === videoId))
  const dir = stemsDir(videoId)
  const out: Record<string, Uint8Array> = {}
  // async parallel reads so ~400MB of WAV doesn't block the main process
  await Promise.all(
    list.map(async (name) => {
      const file = join(dir, `${name}.wav`)
      if (!existsSync(file)) throw new Error(`Missing stem ${name} for ${videoId}`)
      out[name] = new Uint8Array(await readFile(file))
    })
  )
  return out
}
