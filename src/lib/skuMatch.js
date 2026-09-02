/**
 * Matching uploaded filenames to products by SKU.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A vendor sends 40 datasheets named after their part numbers. Attaching them
 * one product at a time is an afternoon's work, and the filename already says
 * which product each one belongs to. This reads that.
 *
 * ── Why a guess is never silently accepted ──────────────────────────────────
 *
 * Attaching a datasheet to the wrong product is worse than not attaching it:
 * the search then confidently answers questions about the wrong part, and
 * nobody has any reason to doubt it. So matching is deliberately conservative —
 * anything short of an unambiguous match is returned as unmatched, for a person
 * to resolve, rather than as a best guess.
 */

/**
 * Strip a filename to comparable characters.
 *
 * Vendors write the same part number as "XPG-8200-Pro", "xpg 8200 pro" and
 * "XPG_8200_PRO". Removing everything that is not alphanumeric makes those one
 * token, which is the whole trick.
 */
export function normalise(value) {
  return String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** The filename without its extension. */
export function baseName(fileName) {
  return String(fileName ?? '').replace(/\.[^.]+$/, '')
}

/**
 * A SKU shorter than this is not matched by containment.
 *
 * A three-character SKU like "SSD" appears inside half the filenames a vendor
 * will ever send. Requiring four characters before allowing a substring match
 * is the difference between a useful shortcut and a machine that files
 * documents at random. Exact matches are still honoured at any length.
 */
const MIN_CONTAINED_LENGTH = 4

/**
 * Match one filename against a list of products.
 *
 * Returns `{ product, reason }` where reason is:
 *   'exact'     — the filename IS the SKU
 *   'contained' — the SKU appears within the filename
 *   'ambiguous' — several equally good candidates; product is null
 *   'none'      — nothing matched; product is null
 */
export function matchFile(fileName, products) {
  const base = normalise(baseName(fileName))
  if (!base) return { product: null, reason: 'none' }

  const withSku = products.filter((p) => normalise(p.sku))

  const exact = withSku.filter((p) => normalise(p.sku) === base)
  if (exact.length === 1) return { product: exact[0], reason: 'exact' }
  if (exact.length > 1) return { product: null, reason: 'ambiguous' }

  const contained = withSku.filter((p) => {
    const sku = normalise(p.sku)
    return sku.length >= MIN_CONTAINED_LENGTH && base.includes(sku)
  })
  if (contained.length === 0) return { product: null, reason: 'none' }

  // The longest SKU wins. "PS5012" and "PS5012E16" can both sit inside one
  // filename, and the longer is the more specific claim — but only if it is
  // the ONLY one that long, otherwise this is a genuine tie and a person
  // should decide.
  const longest = Math.max(...contained.map((p) => normalise(p.sku).length))
  const best = contained.filter((p) => normalise(p.sku).length === longest)
  if (best.length === 1) return { product: best[0], reason: 'contained' }
  return { product: null, reason: 'ambiguous' }
}

/**
 * Match a batch. Returns one row per file, in the order given, so the caller
 * can render a table the person checks before anything is uploaded.
 */
export function matchFiles(files, products) {
  const list = products ?? []
  return (files ?? []).map((file) => {
    const name = typeof file === 'string' ? file : file.name
    const { product, reason } = matchFile(name, list)
    return { file, fileName: name, product, reason }
  })
}
