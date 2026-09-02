/**
 * Extracting the text out of an uploaded document, in the browser.
 *
 * This is the difference between a Knowledge Center and a folder of PDFs. A
 * file in a bucket is findable only by whoever remembers its name; its text is
 * what makes "which board takes DDR5" answerable — first by search, later by
 * handing the relevant passages to a language model.
 *
 * ── Why in the browser ───────────────────────────────────────────────────────
 *
 * There is no application server to do it on. Doing it at upload time costs one
 * slow moment on a page someone is already waiting on, once per document, and
 * needs no new infrastructure.
 *
 * ── What it cannot do ────────────────────────────────────────────────────────
 *
 * A scanned datasheet is a picture of text. Nothing here will read it — that
 * needs OCR, which is a much heavier dependency. Rather than pretend, the
 * result says `empty` and the document is stored and viewable but flagged as
 * not searchable. A document that silently never appears in search results is
 * worse than one labelled as such.
 */

export const EXTRACT_OK = 'ok'
export const EXTRACT_EMPTY = 'empty'
export const EXTRACT_FAILED = 'failed'
export const EXTRACT_UNSUPPORTED = 'unsupported'

/** Types we can currently read. Everything else stores fine but is not searchable. */
export const EXTRACTABLE_TYPES = ['application/pdf', 'text/plain', 'text/csv']

/**
 * Collapse the whitespace pdfjs produces.
 *
 * A PDF's text comes out as positioned fragments, so naive joining gives runs
 * of spaces and newlines that bloat the stored text and add nothing to search.
 *
 * The two patterns below are built from character codes rather than typed
 * literally: a raw NUL or non-breaking space in source is invisible to whoever
 * reads it next, and both are exactly what PDF producers emit.
 */
const NUL = new RegExp(String.fromCharCode(0), 'g')
const HORIZONTAL_SPACE = new RegExp('[ \t' + String.fromCharCode(160) + ']+', 'g')

export function normaliseText(raw) {
  if (!raw) return ''
  return String(raw)
    .replace(NUL, '')
    // A non-breaking space separates words as far as search is concerned.
    .replace(HORIZONTAL_SPACE, ' ')
    // Trim spaces around a newline WITHOUT collapsing blank lines. The obvious
    // /\s*\n\s*/ swallows them, which means a paragraph break never survives —
    // and chunkText's preference for breaking at one could then never fire.
    // Horizontal runs are already single spaces by this point.
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Split a document into overlapping passages.
 *
 * A language model cannot be handed a 40-page datasheet, and search results are
 * more useful pointing at a passage than at a whole file. The overlap matters:
 * a specification split exactly across a boundary would otherwise be findable
 * from neither side.
 */
export function chunkText(text, { size = 1200, overlap = 200 } = {}) {
  const clean = normaliseText(text)
  if (!clean) return []
  if (clean.length <= size) return [clean]

  const chunks = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length)
    // Prefer to break at a paragraph or sentence rather than mid-word.
    if (end < clean.length) {
      const window = clean.slice(start, end)
      const breakAt = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '))
      if (breakAt > size * 0.5) end = start + breakAt + 1
    }
    chunks.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks.filter(Boolean)
}

/**
 * Read the text out of a file.
 *
 * Never throws: a document that cannot be read is still worth storing, so the
 * failure is a status rather than an exception that loses the upload.
 */
export async function extractText(file) {
  if (!file) return { status: EXTRACT_FAILED, text: '', pages: null }

  const type = file.type || ''

  if (type === 'text/plain' || type === 'text/csv') {
    try {
      const text = normaliseText(await file.text())
      return { status: text ? EXTRACT_OK : EXTRACT_EMPTY, text, pages: null }
    } catch {
      return { status: EXTRACT_FAILED, text: '', pages: null }
    }
  }

  if (type !== 'application/pdf') {
    return { status: EXTRACT_UNSUPPORTED, text: '', pages: null }
  }

  try {
    // Imported lazily: pdfjs is large, and most sessions never upload a
    // document. Loading it on every page would tax everyone for the few.
    const pdfjs = await import('pdfjs-dist')
    pdfjs.GlobalWorkerOptions.workerSrc = (
      await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
    ).default

    const buffer = await file.arrayBuffer()
    const doc = await pdfjs.getDocument({ data: buffer }).promise

    const pages = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      pages.push(content.items.map((item) => item.str ?? '').join(' '))
    }
    const text = normaliseText(pages.join('\n\n'))

    return {
      // A PDF that parses but yields nothing is a scan. Distinguishing that
      // from a failure tells the user whether OCR would help.
      status: text ? EXTRACT_OK : EXTRACT_EMPTY,
      text,
      pages: doc.numPages,
    }
  } catch {
    return { status: EXTRACT_FAILED, text: '', pages: null }
  }
}
