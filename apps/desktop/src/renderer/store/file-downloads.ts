import type { SharedFile } from '@shared/models'
import { decodeFileChunk, validateSharedFile } from '../../shared/files.ts'
import type { HostClient } from '../client/host-client'

export type DownloadState = { kind: 'downloading'; received: number } | { kind: 'saved' } | { kind: 'failed'; message: string }
interface Job { cancelled: boolean; handle: string | null }

/** Pictures an agent shared, kept after the first read (a shared file never changes). Bounded: the newest few. */
const imageCache = new Map<string, Uint8Array>()
const IMAGE_CACHE_LIMIT = 24

/** Scoped to one computer store; retiring it cannot save a file into another account. */
export class FileDownloads {
  readonly states = new Map<string, DownloadState>()
  private jobs = new Map<string, Job>()
  private retired = false
  private changed: () => void
  constructor(changed: () => void) { this.changed = changed }

  cancel(id: string) {
    const job = this.jobs.get(id)
    if (!job) return
    job.cancelled = true
    this.jobs.delete(id)
    this.states.delete(id)
    if (job.handle) void window.kith.files.cancel(job.handle).catch(console.error)
    this.changed()
  }

  retire() { this.retired = true; for (const id of this.jobs.keys()) this.cancel(id) }

  /** A shared file's bytes through the same chunked read the download uses (so a remote computer stays
   * within the relay's limits), cached by file id. Null when it can't be read now. */
  async bytes(client: HostClient | null, entryId: string, file: SharedFile): Promise<Uint8Array | null> {
    const cached = imageCache.get(file.id)
    if (cached) return cached
    if (!client || this.retired) return null
    try {
      validateSharedFile(file)
      const out = new Uint8Array(file.size)
      let offset = 0
      while (offset < file.size) {
        const bytes = decodeFileChunk(await client.readFile(entryId, file.id, offset), file.size, offset)
        if (this.retired) return null
        out.set(bytes, offset)
        offset += bytes.length
      }
      imageCache.set(file.id, out)
      if (imageCache.size > IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value as string)
      return out
    } catch {
      return null
    }
  }

  async save(client: HostClient | null, entryId: string, file: SharedFile) {
    if (this.retired || this.jobs.has(file.id)) return
    const job: Job = { cancelled: false, handle: null }
    const alive = () => !job.cancelled && !this.retired
    this.jobs.set(file.id, job)
    this.states.set(file.id, { kind: 'downloading', received: 0 })
    this.changed()
    try {
      validateSharedFile(file)
      if (!client) throw new Error('Connect to this computer to download the file')
      job.handle = await window.kith.files.begin(file)
      if (!job.handle || !alive()) return
      let offset = 0
      // The empty file still performs an authenticated read and verifies its digest.
      do {
        const chunk = await client.readFile(entryId, file.id, offset)
        if (!alive()) return
        const bytes = decodeFileChunk(chunk, file.size, offset)
        if (bytes.length) await window.kith.files.write(job.handle, offset, bytes)
        if (!alive()) return
        offset += bytes.length
        this.states.set(file.id, { kind: 'downloading', received: offset })
        this.changed()
      } while (offset < file.size)
      if (!alive()) return
      await window.kith.files.finish(job.handle)
      if (alive()) this.states.set(file.id, { kind: 'saved' })
    } catch (error) {
      if (alive()) this.states.set(file.id, { kind: 'failed', message: error instanceof Error ? error.message : String(error) })
    } finally {
      if (job.handle) await window.kith.files.cancel(job.handle).catch(console.error)
      if (this.jobs.get(file.id) === job) {
        this.jobs.delete(file.id)
        if (this.states.get(file.id)?.kind === 'downloading') this.states.delete(file.id)
        this.changed()
      }
    }
  }
}
