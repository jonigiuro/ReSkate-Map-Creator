import { httpPreviewThumbUrl } from './assetLibrary'

export type ThumbTarget = {
  assetFile: string
  revision: number
}

/** Pieces in this folder that still need Blender to make a thumbnail. */
export async function missingPreviews(files: string[]): Promise<string[]> {
  if (files.length === 0) return []
  const desktop = window.reskateDesktop
  if (desktop?.missingPreviews && window.location.protocol === 'file:') {
    return desktop.missingPreviews(files)
  }
  const response = await fetch('/api/library-preview-missing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  })
  if (!response.ok) throw new Error('Could not check thumbnails')
  const data = (await response.json()) as { missing?: unknown }
  return Array.isArray(data.missing) ? data.missing.filter((file): file is string => typeof file === 'string') : []
}

/** Builds the thumbnail when it is missing, then returns a URL the library can show. */
export async function ensureThumbnail(assetFile: string, revision: number): Promise<string> {
  const desktop = window.reskateDesktop
  if (desktop?.previewThumb && window.location.protocol === 'file:') {
    return desktop.previewThumb(assetFile)
  }
  const response = await fetch(`/api/library-preview-build?file=${encodeURIComponent(assetFile)}`)
  if (!response.ok) throw new Error('Could not create the thumbnail')
  return httpPreviewThumbUrl(assetFile, revision)
}

export async function mapPool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>) {
  if (items.length === 0) return
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}
