import { useEffect, useState } from 'react'
import type { Entry, SharedFile } from '@shared/models'
import { isImageName } from '@shared/models'
import { Icon } from '../../components/Icon'
import { IconButtonBase, ModalHeader, Sheet, SheetPage } from '../../components/Overlay'
import { HStack } from '../../components/Stack'
import { useStore } from '../../store/context'
import { FileDownloadCard } from './FileDownloadCard'
import './attachments.css'

/** Past this a picture stays a download card: it would take long to show and hold a lot of memory. */
const MAX_INLINE_BYTES = 25_000_000

/** A picture an agent shared shows as a picture; any other file, or a picture that won't show, as the download card. */
export function SharedFileView({ entry, file }: { entry: Entry; file: SharedFile }) {
  return isImageName(file.name) && file.size > 0 && file.size <= MAX_INLINE_BYTES ? <SharedImage entry={entry} file={file} /> : <FileDownloadCard entry={entry} file={file} />
}

const mime = (name: string) => {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  return { jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', tiff: 'image/tiff', bmp: 'image/bmp' }[ext] ?? 'image/png'
}

function SharedImage({ entry, file }: { entry: Entry; file: SharedFile }) {
  const store = useStore()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    let alive = true
    let made: string | null = null
    void store.fileDownloads.bytes(store.client, entry.id, file).then((bytes) => {
      if (!alive) return
      if (!bytes) return setFailed(true)
      made = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime(file.name) }))
      setUrl(made)
    })
    return () => {
      alive = false
      if (made) URL.revokeObjectURL(made)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a shared file never changes; its id is its identity
  }, [store, entry.id, file.id])
  // Not readable now, or a format this window can't draw (HEIC): the card still offers the file.
  if (failed) return <FileDownloadCard entry={entry} file={file} />
  if (!url) {
    return (
      <div className="attachment-placeholder">
        <Icon name="photo" size={13} color="var(--tertiary)" />
      </div>
    )
  }
  const copy = async () => {
    try {
      // From the cached bytes: the page's CSP doesn't allow fetching a blob: URL.
      const bytes = await store.fileDownloads.bytes(store.client, entry.id, file)
      if (!bytes) return
      const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime(file.name) }))
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
      const png = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'))
      if (!png) return
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <>
      <button className="attachment-image-button" aria-label={`${file.name}, open`} onClick={() => setOpen(true)}>
        <img src={url} alt={file.name} className="attachment-image thumbnail" onError={() => setFailed(true)} />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} width={720} height={560}>
        <SheetPage>
          <ModalHeader
            title={file.name}
            trailing={
              <HStack gap={4}>
                <IconButtonBase title={copied ? 'Copied' : 'Copy image'} icon={copied ? 'checkmark' : 'square.on.square'} size={28} onClick={() => void copy()} />
                <IconButtonBase title="Save as…" icon="arrow.down.to.line" size={28} onClick={() => void store.fileDownloads.save(store.client, entry.id, file)} />
              </HStack>
            }
          />
          <div className="attachment-viewer">
            <img src={url} alt={file.name} className="attachment-image full" />
          </div>
        </SheetPage>
      </Sheet>
    </>
  )
}
