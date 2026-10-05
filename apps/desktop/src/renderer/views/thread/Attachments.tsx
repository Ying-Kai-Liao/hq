import { useEffect, useState } from 'react'
import { isImageName, type Attachment } from '@shared/models'
import { Icon } from '../../components/Icon'
import { ModalHeader, Sheet } from '../../components/Overlay'
import { font } from '../../lib/fonts'
import { useStoreRef } from '../../store/context'

/** The symbol for a file by its extension. */
export function attachmentSymbol(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp', 'tiff', 'bmp'].includes(ext)) return 'photo'
  if (ext === 'pdf') return 'doc.richtext'
  if (['zip', 'gz', 'tar', '7z'].includes(ext)) return 'doc.zipper'
  if (['mov', 'mp4', 'm4v'].includes(ext)) return 'film'
  if (['mp3', 'm4a', 'wav', 'aac'].includes(ext)) return 'waveform'
  return 'doc'
}

export function byteCount(bytes: number) {
  if (bytes < 1000) return `${bytes} bytes`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1000
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** Files sent with a message: images as pictures (click for full size), other files as cards. */
export function AttachmentList({ attachments, botId }: { attachments: Attachment[]; botId: string }) {
  const [viewing, setViewing] = useState<Attachment | null>(null)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      {attachments.map((file) =>
        isImageName(file.name) ? (
          <button key={file.id} aria-label={file.name} onClick={() => setViewing(file)} style={{ borderRadius: 16, overflow: 'hidden', maxWidth: 220, maxHeight: 280, display: 'flex' }}>
            <AttachmentImage file={file} botId={botId} style={{ maxWidth: 220, maxHeight: 280 }} />
          </button>
        ) : (
          <div key={file.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--bubble-user)', borderRadius: 16 }}>
            <Icon name={attachmentSymbol(file.name)} size={16} color="var(--secondary)" />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
              <span style={{ ...font('subheadline'), color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 200 }}>{file.name}</span>
              <span style={{ ...font('caption2'), color: 'var(--tertiary)' }}>{byteCount(file.size)}</span>
            </div>
          </div>
        ),
      )}
      <Sheet open={viewing !== null} onClose={() => setViewing(null)} width={720} height={560}>
        {viewing ? (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--background)' }}>
            <ModalHeader title={viewing.name} />
            <div style={{ flex: 1, minHeight: 0, padding: 12, display: 'grid', placeItems: 'center' }}>
              <AttachmentImage file={viewing} botId={botId} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            </div>
          </div>
        ) : null}
      </Sheet>
    </div>
  )
}

/** A sent image, fetched from the computer once and then read from the cache. */
function AttachmentImage({ file, botId, style }: { file: Attachment; botId: string; style?: React.CSSProperties }) {
  const store = useStoreRef()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let revoked = false
    let made: string | null = null
    void store.attachmentData(file.id, botId).then((data) => {
      if (!data || revoked) return
      made = URL.createObjectURL(new Blob([data as BlobPart]))
      setUrl(made)
    })
    return () => {
      revoked = true
      if (made) URL.revokeObjectURL(made)
    }
  }, [store, file.id, botId])
  if (!url) {
    return (
      <div style={{ width: 160, height: 120, borderRadius: 16, background: 'var(--bubble-user)', display: 'grid', placeItems: 'center' }}>
        <Icon name="photo" size={13} color="var(--tertiary)" />
      </div>
    )
  }
  return <img src={url} alt="" style={{ display: 'block', ...style }} />
}
