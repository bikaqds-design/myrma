import { supabase } from './client.js'
import { resizeImage } from '../lib/resizeImage.js'

const ALLOWED_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
]
const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024 // 25 MB
const MAX_AVATAR_SIZE = 5 * 1024 * 1024 // 5 MB

function validateAttachment(file) {
  if (file.size > MAX_ATTACHMENT_SIZE) throw new Error(`File too large (max 25 MB): ${file.name}`)
  if (!ALLOWED_ATTACHMENT_TYPES.includes(file.type))
    throw new Error(`File type not allowed: ${file.type}`)
}

/**
 * Make a value safe to use as one segment of a storage object path.
 * (Audit finding BUG-026.)
 *
 * Paths were built by interpolating identifiers straight in — most sharply
 * `products/${productSku}/…` and `brands/${brandName.toLowerCase()}/…`, both of
 * which are free text a manager types. A SKU containing `/` writes into a
 * different folder, and one containing `..` walks out of the products tree
 * entirely, so an object can land somewhere the rest of the app does not expect
 * and another product's folder can be written into.
 *
 * Anything outside [A-Za-z0-9._-] becomes '-', leading dots are stripped so
 * '..' and '.hidden' cannot survive, and an empty result falls back rather than
 * producing a '//' in the path.
 */
function pathSegment(value, fallback = 'unknown') {
  const cleaned = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^\.+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80)
  return cleaned || fallback
}

/** A file extension safe to append; falls back when the name has none. */
function safeExtension(fileName, fallback = 'bin') {
  const raw = String(fileName ?? '').split('.').pop() ?? ''
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 10)
  return cleaned || fallback
}

export const storage = {
  async uploadFile(file, rmaNumber) {
    file = await resizeImage(file) // P-3: downscale images to ≤1200px before upload
    validateAttachment(file)
    const fileName = `${pathSegment(rmaNumber, 'unfiled')}/${Date.now()}_${Math.random().toString(36).substring(7)}.${safeExtension(file.name)}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { name: file.name, url: publicUrl, path: fileName, size: file.size, type: file.type }
  },
  async deleteFile(path) {
    const { error } = await supabase.storage.from('rma-attachments').remove([path])
    if (error) throw error
  },
  /**
   * A datasheet or manual attached to a product.
   *
   * Deliberately does NOT go through resizeImage: these are documents, and
   * while resizeImage passes non-images through untouched, calling it here
   * would imply an image pipeline that does not apply.
   *
   * The path keeps documents beside the product's images but in their own
   * folder, so a bucket listing is readable by a person.
   *
   * NOTE: this bucket is public. Anyone with the URL can read the file without
   * logging in. That is a deliberate choice for product datasheets, which are
   * published vendor material — it would be the wrong choice for anything
   * internal, and anyone adding a new document type here should check first.
   */
  async uploadProductDocument(file, productSku) {
    validateAttachment(file)
    const safeExt = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
    const fileName = `products/${productSku}/docs/${Date.now()}_${Math.random()
      .toString(36)
      .substring(7)}.${safeExt}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { name: file.name, url: publicUrl, path: fileName, size: file.size, type: file.type }
  },

  /** A company-wide document — a price list, a policy, a certificate. Not
   * filed under any product, so it gets its own path rather than living
   * inside `products/`. */
  async uploadCompanyDocument(file) {
    validateAttachment(file)
    const safeExt = (file.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '')
    const fileName = `company-docs/${Date.now()}_${Math.random()
      .toString(36)
      .substring(7)}.${safeExt}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { name: file.name, url: publicUrl, path: fileName, size: file.size, type: file.type }
  },

  async uploadProductImage(file, productSku) {
    file = await resizeImage(file) // P-3
    const fileName = `products/${pathSegment(productSku, 'no-sku')}/${Date.now()}_${Math.random().toString(36).substring(7)}.${safeExtension(file.name)}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { url: publicUrl, path: fileName }
  },
  async uploadAvatar(file, userId) {
    file = await resizeImage(file, 400) // P-3: avatars capped at 400px
    if (file.size > MAX_AVATAR_SIZE) throw new Error('Avatar too large (max 5 MB)')
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type))
      throw new Error('Avatar must be an image (JPEG, PNG, WebP, or GIF)')
    const fileName = `avatars/${pathSegment(userId)}/avatar.${safeExtension(file.name)}`
    const { error } = await supabase.storage
      .from('rma-attachments')
      .upload(fileName, file, { upsert: true })
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return publicUrl
  },
  async uploadBrandLogo(file, brandName) {
    const fileName = `brands/${pathSegment(String(brandName).toLowerCase(), 'no-brand')}/${Date.now()}.${safeExtension(file.name)}`
    const { error } = await supabase.storage
      .from('rma-attachments')
      .upload(fileName, file, { cacheControl: '3600', upsert: false })
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return publicUrl
  },
  async uploadCommentAttachment(file, ticketId) {
    file = await resizeImage(file) // P-3
    validateAttachment(file)
    const fileName = `comments/${pathSegment(ticketId)}/${Date.now()}_${Math.random().toString(36).substring(7)}.${safeExtension(file.name)}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { name: file.name, url: publicUrl, path: fileName, size: file.size, type: file.type }
  },
  async uploadCustomerAttachment(file, folderId) {
    file = await resizeImage(file) // P-3
    validateAttachment(file)
    const fileName = `customers/${pathSegment(folderId)}/${Date.now()}_${Math.random().toString(36).substring(7)}.${safeExtension(file.name)}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { name: file.name, url: publicUrl, path: fileName, size: file.size, type: file.type }
  },
  // relatedType: 'lead' | 'deal' — used by the shared ActivityChatter component
  async uploadActivityAttachment(file, relatedType, relatedId) {
    file = await resizeImage(file) // P-3
    validateAttachment(file)
    const fileName = `${pathSegment(relatedType, 'item')}s/${pathSegment(relatedId)}/${Date.now()}_${Math.random().toString(36).substring(7)}.${safeExtension(file.name)}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { name: file.name, url: publicUrl, path: fileName, size: file.size, type: file.type }
  },
}
