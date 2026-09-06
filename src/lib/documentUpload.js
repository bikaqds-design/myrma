import { db, storage } from '../api/supabaseClient'
import { extractText } from './pdfText'

/**
 * The document upload sequence, shared by every place a document can be
 * attached to a product.
 *
 * Before this it was written once, inline, in `ProductDocuments.jsx`. The
 * Vault gained its own inline upload for a product folder (2026-09-03) and
 * needed the exact same extract → upload → create sequence — duplicating it
 * would let the two drift, and a fix applied to one silently miss the other.
 */
export async function uploadProductDocument({
  product,
  file,
  title,
  docType,
  description,
  currentUserEmail,
  onStage,
}) {
  // Extract first. If the file cannot be read we still want to store it, but
  // the status has to be recorded with the row rather than patched in
  // afterwards, where a failure would leave it stuck on 'pending'.
  onStage?.('extracting')
  const extraction = await extractText(file)

  onStage?.('uploading')
  const uploaded = await storage.uploadProductDocument(file, product.sku || product.id)

  return db.productDocuments.create({
    productId: product.id,
    title,
    docType,
    description,
    fileName: uploaded.name,
    fileUrl: uploaded.url,
    storagePath: uploaded.path,
    fileSize: uploaded.size,
    mimeType: uploaded.type,
    extractedText: extraction.text,
    extractionStatus: extraction.status,
    pageCount: extraction.pages,
    uploadedBy: currentUserEmail,
  })
}

/**
 * The same extract → upload → create sequence, for a document that belongs
 * to the company rather than a product — a price list, a policy, a
 * certificate. No product to derive a storage path from, and no doc_type:
 * there is no catalogue slot for these to collide over the way a product's
 * datasheet does, so there is nothing for an upload here to conflict with.
 */
export async function uploadCompanyDocument({ file, title, description, currentUserEmail, onStage }) {
  onStage?.('extracting')
  const extraction = await extractText(file)

  onStage?.('uploading')
  const uploaded = await storage.uploadCompanyDocument(file)

  return db.companyDocuments.create({
    title,
    description,
    fileName: uploaded.name,
    fileUrl: uploaded.url,
    storagePath: uploaded.path,
    fileSize: uploaded.size,
    mimeType: uploaded.type,
    extractedText: extraction.text,
    extractionStatus: extraction.status,
    pageCount: extraction.pages,
    uploadedBy: currentUserEmail,
  })
}

/**
 * Whether this product already carries a document of this type, live or
 * trashed, before a new upload proceeds.
 *
 * A live match is the one actually being superseded — "Replace" moves it to
 * Trash before the new upload runs. A trashed-only match is informational:
 * the uploader typed the same kind of document they deleted a moment ago,
 * and deserves to know rather than silently end up with two.
 */
export async function findUploadConflict(productId, docType) {
  const matches = await db.productDocuments.findByProductAndType(productId, docType)
  if (matches.length === 0) return null
  const live = matches.find((m) => !m.deleted_at)
  return { existing: live ?? matches[0], isTrashed: !live }
}
