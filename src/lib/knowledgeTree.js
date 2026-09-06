/**
 * The Knowledge Center's folder tree.
 *
 * The Search tab used to be a flat list, on the reasoning that nobody opens
 * this page knowing which product they want. That is still true of searching,
 * and search is still the first thing on the screen -- but it left no way to
 * answer "what have we actually got for AOC?", which is the other half of what
 * a document library is for. So the flat list gained a folder tree beside it,
 * modelled on the catalogue the products already live in:
 *
 *     Brand -> Category -> Subcategory -> Product -> documents
 *
 * -- Why the whole catalogue, not just the folders holding files -------------
 *
 * Decided deliberately (2026-09-03): the tree mirrors the product catalogue
 * one-for-one, so a brand with no datasheets still appears and reads as a gap
 * rather than as an absence of evidence. Today that means 14 brands and 406
 * product folders around 2 documents -- the folder sizes say "0 items" and the
 * Coverage tab exists to work exactly that list down.
 *
 * -- Placement is decided by the product, not by the folder -------------------
 *
 * A product carries brand_id, category_id and subcategory_id independently, so
 * they can disagree -- a category belonging to another brand, a subcategory
 * belonging to another category. Rather than let a mismatch teleport a product
 * under a brand it does not belong to, placement walks down only while each
 * link is consistent with the one above it and stops at the last level that
 * agrees. A product with a foreign category lands directly under its own
 * brand: less specific, never wrong, and it still appears exactly once.
 *
 * That "exactly once" is the invariant worth protecting. A product that
 * appeared twice would double every roll-up above it, and a product that
 * appeared nowhere would make its documents unreachable by browsing while
 * still being findable by search -- which reads as data loss.
 */

export const ROOT_ID = '__root__'

/** Folders sort by what they are, then by name. */
const KIND_RANK = { brand: 0, category: 1, subcategory: 2, product: 3 }

function node(id, kind, name, parentId, extra = {}) {
  return {
    id,
    kind,
    name: name ?? '',
    parentId,
    folders: [],
    documents: [],
    docCount: 0,
    docBytes: 0,
    modified: null,
    ...extra,
  }
}

function laterOf(a, b) {
  if (!a) return b ?? null
  if (!b) return a
  return a > b ? a : b
}

/**
 * Build the tree and an id -> node index.
 *
 * Every argument is optional and defaults to empty, because the four catalogue
 * queries resolve independently and the first render happens before all of
 * them have landed. Rendering an empty tree for one frame beats throwing.
 */
export function buildTree({
  brands = [],
  categories = [],
  subcategories = [],
  products = [],
  documents = [],
} = {}) {
  const root = node(ROOT_ID, 'root', '', null)
  const byId = new Map([[ROOT_ID, root]])

  const brandNodes = new Map()
  for (const b of brands) {
    const n = node(b.id, 'brand', b.brand_name, ROOT_ID, { logoUrl: b.brand_logo_url ?? null })
    brandNodes.set(b.id, n)
    byId.set(b.id, n)
    root.folders.push(n)
  }

  // A category whose brand is missing would otherwise vanish along with every
  // product under it, so it hangs off the root rather than being dropped.
  const categoryNodes = new Map()
  const categoryById = new Map(categories.map((c) => [c.id, c]))
  for (const c of categories) {
    const parent = brandNodes.get(c.brand_id) ?? root
    const n = node(c.id, 'category', c.category_name, parent.id)
    categoryNodes.set(c.id, n)
    byId.set(c.id, n)
    parent.folders.push(n)
  }

  const subcategoryNodes = new Map()
  const subcategoryById = new Map(subcategories.map((s) => [s.id, s]))
  for (const s of subcategories) {
    const parent = categoryNodes.get(s.category_id) ?? root
    const n = node(s.id, 'subcategory', s.subcategory_name, parent.id)
    subcategoryNodes.set(s.id, n)
    byId.set(s.id, n)
    parent.folders.push(n)
  }

  const productNodes = new Map()
  for (const p of products) {
    // Descend only while each link agrees with the one above it. The moment a
    // level disagrees, stop -- the product belongs to the deepest folder that
    // is still consistent with its own brand.
    let parent = brandNodes.get(p.brand_id) ?? root

    const cat = categoryById.get(p.category_id)
    if (cat && cat.brand_id === p.brand_id) {
      parent = categoryNodes.get(cat.id) ?? parent

      const sub = subcategoryById.get(p.subcategory_id)
      if (sub && sub.category_id === cat.id) {
        parent = subcategoryNodes.get(sub.id) ?? parent
      }
    }

    const n = node(p.id, 'product', p.product_name, parent.id, {
      sku: p.sku ?? '',
      imageUrl: p.product_image_url ?? null,
    })
    productNodes.set(p.id, n)
    byId.set(p.id, n)
    parent.folders.push(n)
  }

  // A document whose product is missing from the catalogue is not silently
  // dropped: it is still searchable, so hiding it here would make browsing and
  // searching disagree about what the library contains.
  const orphans = []
  for (const d of documents) {
    const owner = productNodes.get(d.product_id)
    if (owner) owner.documents.push(d)
    else orphans.push(d)
  }
  root.documents.push(...orphans)

  rollUp(root)
  sortTree(root)

  return { root, byId, orphanCount: orphans.length }
}

/** Totals flow upward, so a brand's size is everything beneath it. */
function rollUp(n) {
  let count = n.documents.length
  let bytes = 0
  let modified = null

  for (const d of n.documents) {
    bytes += d.file_size ?? 0
    modified = laterOf(modified, d.updated_at ?? d.created_at ?? null)
  }
  for (const child of n.folders) {
    rollUp(child)
    count += child.docCount
    bytes += child.docBytes
    modified = laterOf(modified, child.modified)
  }

  n.docCount = count
  n.docBytes = bytes
  n.modified = modified
  return n
}

function sortTree(n) {
  n.folders.sort(
    (a, b) =>
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      String(a.name).localeCompare(String(b.name), undefined, { numeric: true })
  )
  n.documents.sort((a, b) =>
    String(a.title ?? '').localeCompare(String(b.title ?? ''), undefined, { numeric: true })
  )
  for (const child of n.folders) sortTree(child)
}

/** Root -> node, for the breadcrumb. Returns [] for an id that is not in the tree. */
export function pathTo(byId, id) {
  const out = []
  let cursor = byId.get(id)
  // A malformed tree with a parent cycle would hang the render rather than
  // show a wrong crumb, so the walk is bounded by the number of nodes.
  let guard = byId.size + 1
  while (cursor && guard-- > 0) {
    out.unshift(cursor)
    cursor = cursor.parentId === null ? null : byId.get(cursor.parentId)
  }
  return out
}

/** Every document at or beneath a node -- what a scoped search runs against. */
export function descendantDocuments(n) {
  if (!n) return []
  const out = [...n.documents]
  for (const child of n.folders) out.push(...descendantDocuments(child))
  return out
}

/** Every product id at or beneath a node, for scoping a server-side search. */
export function descendantProductIds(n, into = new Set()) {
  if (!n) return into
  if (n.kind === 'product') into.add(n.id)
  for (const child of n.folders) descendantProductIds(child, into)
  return into
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/**
 * Bytes as a file manager shows them.
 *
 * Deliberately unlocalised units: B/KB/MB/GB are read as symbols rather than
 * as words, and every file manager an Arabic user has ever opened writes them
 * this way. The number beside them is still bidi-isolated by the caller.
 */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return ''
  if (bytes <= 0) return `0 ${UNITS[0]}`
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1)
  const value = bytes / 1024 ** exponent
  // Whole bytes have no meaningful fraction; everything else reads better with
  // one decimal until it reaches three digits.
  const decimals = exponent === 0 ? 0 : value >= 100 ? 0 : 1
  return `${value.toFixed(decimals)} ${UNITS[exponent]}`
}
