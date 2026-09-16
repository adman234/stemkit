import { createReadStream, statSync } from 'fs'
import { crc32 } from 'zlib'
import type { ServerResponse } from 'http'

/* Minimal streaming ZIP writer for "export all stems". WAV barely
   compresses, so entries are stored uncompressed, which keeps the archive
   size known up front (a real Content-Length, so browsers show download
   progress). Long songs with many float32 stems can pass 4GB, so ZIP64
   records are written whenever a size or offset needs them */

export interface ZipEntry {
  name: string
  path: string
}

const MAX32 = 0xffffffff

interface Planned extends ZipEntry {
  nameBuf: Buffer
  size: number
  offset: number
  dosTime: number
  dosDate: number
  localZip64: boolean
  centralZip64: boolean
}

function dosDateTime(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    dosTime: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    dosDate: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  }
}

function plan(entries: ZipEntry[]): { files: Planned[]; cdOffset: number; cdSize: number; total: number } {
  const files: Planned[] = []
  let offset = 0
  for (const entry of entries) {
    const st = statSync(entry.path)
    const nameBuf = Buffer.from(entry.name, 'utf8')
    const localZip64 = st.size >= MAX32
    const centralZip64 = localZip64 || offset >= MAX32
    files.push({ ...entry, nameBuf, size: st.size, offset, localZip64, centralZip64, ...dosDateTime(st.mtime) })
    offset += 30 + nameBuf.length + (localZip64 ? 20 : 0) + st.size
  }
  const cdOffset = offset
  let cdSize = 0
  for (const f of files) cdSize += 46 + f.nameBuf.length + (f.centralZip64 ? 28 : 0)
  const zip64End = cdOffset + cdSize >= MAX32 || files.length >= 0xffff
  const total = cdOffset + cdSize + (zip64End ? 56 + 20 : 0) + 22
  return { files, cdOffset, cdSize, total }
}

async function send(res: ServerResponse, buf: Buffer): Promise<void> {
  if (res.destroyed) throw new Error('client went away')
  if (!res.write(buf)) {
    await new Promise<void>((resolve, reject) => {
      res.once('drain', resolve)
      res.once('close', () => reject(new Error('client went away')))
    })
  }
}

async function fileCrc(path: string): Promise<number> {
  let crc = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    crc = crc32(chunk as Buffer, crc)
  }
  return crc >>> 0
}

export function zipSize(entries: ZipEntry[]): number {
  return plan(entries).total
}

export async function writeZip(res: ServerResponse, entries: ZipEntry[]): Promise<void> {
  const { files, cdOffset, cdSize } = plan(entries)
  const crcs: number[] = []

  for (const f of files) {
    const crc = await fileCrc(f.path)
    crcs.push(crc)
    const header = Buffer.alloc(30 + f.nameBuf.length + (f.localZip64 ? 20 : 0))
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(f.localZip64 ? 45 : 20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 names
    header.writeUInt16LE(0, 8) // stored
    header.writeUInt16LE(f.dosTime, 10)
    header.writeUInt16LE(f.dosDate, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(f.localZip64 ? MAX32 : f.size, 18)
    header.writeUInt32LE(f.localZip64 ? MAX32 : f.size, 22)
    header.writeUInt16LE(f.nameBuf.length, 26)
    header.writeUInt16LE(f.localZip64 ? 20 : 0, 28)
    f.nameBuf.copy(header, 30)
    if (f.localZip64) {
      const extra = 30 + f.nameBuf.length
      header.writeUInt16LE(0x0001, extra)
      header.writeUInt16LE(16, extra + 2)
      header.writeBigUInt64LE(BigInt(f.size), extra + 4)
      header.writeBigUInt64LE(BigInt(f.size), extra + 12)
    }
    await send(res, header)
    for await (const chunk of createReadStream(f.path, { highWaterMark: 1 << 20 })) {
      await send(res, chunk as Buffer)
    }
  }

  const central: Buffer[] = []
  files.forEach((f, i) => {
    const rec = Buffer.alloc(46 + f.nameBuf.length + (f.centralZip64 ? 28 : 0))
    rec.writeUInt32LE(0x02014b50, 0)
    rec.writeUInt16LE(f.centralZip64 ? 45 : 20, 4)
    rec.writeUInt16LE(f.centralZip64 ? 45 : 20, 6)
    rec.writeUInt16LE(0x0800, 8)
    rec.writeUInt16LE(0, 10)
    rec.writeUInt16LE(f.dosTime, 12)
    rec.writeUInt16LE(f.dosDate, 14)
    rec.writeUInt32LE(crcs[i], 16)
    rec.writeUInt32LE(f.centralZip64 ? MAX32 : f.size, 20)
    rec.writeUInt32LE(f.centralZip64 ? MAX32 : f.size, 24)
    rec.writeUInt16LE(f.nameBuf.length, 28)
    rec.writeUInt16LE(f.centralZip64 ? 28 : 0, 30)
    rec.writeUInt16LE(0, 32) // comment
    rec.writeUInt16LE(0, 34) // disk
    rec.writeUInt16LE(0, 36) // internal attrs
    rec.writeUInt32LE(0, 38) // external attrs
    rec.writeUInt32LE(f.centralZip64 ? MAX32 : f.offset, 42)
    f.nameBuf.copy(rec, 46)
    if (f.centralZip64) {
      const extra = 46 + f.nameBuf.length
      rec.writeUInt16LE(0x0001, extra)
      rec.writeUInt16LE(24, extra + 2)
      rec.writeBigUInt64LE(BigInt(f.size), extra + 4)
      rec.writeBigUInt64LE(BigInt(f.size), extra + 12)
      rec.writeBigUInt64LE(BigInt(f.offset), extra + 20)
    }
    central.push(rec)
  })
  await send(res, Buffer.concat(central))

  const zip64End = cdOffset + cdSize >= MAX32 || files.length >= 0xffff
  if (zip64End) {
    const rec = Buffer.alloc(56 + 20)
    rec.writeUInt32LE(0x06064b50, 0)
    rec.writeBigUInt64LE(44n, 4)
    rec.writeUInt16LE(45, 12)
    rec.writeUInt16LE(45, 14)
    rec.writeUInt32LE(0, 16)
    rec.writeUInt32LE(0, 20)
    rec.writeBigUInt64LE(BigInt(files.length), 24)
    rec.writeBigUInt64LE(BigInt(files.length), 32)
    rec.writeBigUInt64LE(BigInt(cdSize), 40)
    rec.writeBigUInt64LE(BigInt(cdOffset), 48)
    // locator
    rec.writeUInt32LE(0x07064b50, 56)
    rec.writeUInt32LE(0, 60)
    rec.writeBigUInt64LE(BigInt(cdOffset + cdSize), 64)
    rec.writeUInt32LE(1, 72)
    await send(res, rec)
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(zip64End ? 0xffff : files.length, 8)
  end.writeUInt16LE(zip64End ? 0xffff : files.length, 10)
  end.writeUInt32LE(zip64End ? MAX32 : cdSize, 12)
  end.writeUInt32LE(zip64End ? MAX32 : cdOffset, 16)
  end.writeUInt16LE(0, 20)
  await send(res, end)
}
