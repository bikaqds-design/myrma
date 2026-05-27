/**
 * resizeImage.js — client-side image downscaling before upload (P-3)
 *
 * Resizes JPEG / PNG / WebP images to at most `maxWidth` pixels wide using
 * an off-screen canvas. Other file types (PDFs, docs, GIFs, SVGs) pass through
 * unchanged. If the image is already ≤ maxWidth it is returned as-is to avoid
 * unnecessary re-encoding.
 */

/** Image types that can be drawn to a canvas and re-encoded. */
const RESIZABLE_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp'])

/**
 * Downscale `file` to at most `maxWidth` pixels wide.
 * Returns a Promise<File> — resolves with the (possibly resized) file.
 *
 * @param {File} file
 * @param {number} [maxWidth=1200]
 * @param {number} [quality=0.85]  JPEG/WebP quality (0–1)
 * @returns {Promise<File>}
 */
export async function resizeImage(file, maxWidth = 1200, quality = 0.85) {
  if (!RESIZABLE_TYPES.has(file.type)) return file

  return new Promise((resolve) => {
    const img = new Image()
    const objectUrl = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(objectUrl)

      // Already within limit — return original to avoid re-encoding artefacts
      if (img.width <= maxWidth) {
        resolve(file)
        return
      }

      const scale = maxWidth / img.width
      const canvas = document.createElement('canvas')
      canvas.width = maxWidth
      canvas.height = Math.round(img.height * scale)

      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)

      // PNG stays PNG (lossless); everything else → JPEG
      const outType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file)
            return
          }
          resolve(new File([blob], file.name, { type: outType, lastModified: Date.now() }))
        },
        outType,
        outType === 'image/jpeg' ? quality : undefined
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      resolve(file) // pass through on error
    }

    img.src = objectUrl
  })
}
