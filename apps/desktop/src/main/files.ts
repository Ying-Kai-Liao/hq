import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clipboard } from 'electron'

export async function readFiles(paths: string[]) {
  const out: { name: string; data: Uint8Array }[] = []
  for (const path of paths) {
    try {
      out.push({ name: basename(path), data: new Uint8Array(await fs.readFile(path)) })
    } catch {}
  }
  return out
}

const fileURLFormat = process.platform === 'darwin' ? 'electron application/osclipboard;format="public.file-url"' : 'text/uri-list'

/** ⌘V with a copied file or image: the files it holds (the text field alone would paste a name). */
export async function readClipboardFiles() {
  const items = await clipboard.read()
  const urls: string[] = []
  for (const item of items) {
    if (item.types.includes(fileURLFormat)) {
      const text = await ((await item.getType(fileURLFormat)) as Blob).text()
      urls.push(...text.split(/\r?\n/).filter((l) => l.startsWith('file://')))
    }
  }
  if (urls.length) return readFiles(urls.map((u) => fileURLToPath(u.replace(/\0+$/, ''))))
  const out: { name: string; data: Uint8Array }[] = []
  for (const item of items) {
    const image = item.types.find((t) => t === 'image/png' || t === 'image/jpeg')
    if (image && !item.types.includes('text/plain')) {
      const blob = (await item.getType(image)) as Blob
      out.push({ name: `pasted-${Math.floor(Date.now() / 1000)}.${image === 'image/png' ? 'png' : 'jpg'}`, data: new Uint8Array(await blob.arrayBuffer()) })
    }
  }
  return out
}
