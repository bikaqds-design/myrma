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

export const storage = {
  async uploadFile(file, rmaNumber) {
    file = await resizeImage(file) // P-3: downscale images to ≤1200px before upload
    validateAttachment(file)
    const fileExt = file.name.split('.').pop()
    const fileName = `${rmaNumber}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`
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

  async uploadProductImage(file, productSku) {
    file = await resizeImage(file) // P-3
    const fileExt = file.name.split('.').pop()
    const fileName = `products/${productSku}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`
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
    const fileExt = file.name.split('.').pop()
    const fileName = `avatars/${userId}/avatar.${fileExt}`
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
    const fileExt = file.name.split('.').pop()
    const fileName = `brands/${brandName.toLowerCase()}/${Date.now()}.${fileExt}`
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
    const fileExt = file.name.split('.').pop()
    const fileName = `comments/${ticketId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`
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
    const fileExt = file.name.split('.').pop()
    const fileName = `customers/${folderId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`
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
    const fileExt = file.name.split('.').pop()
    const fileName = `${relatedType}s/${relatedId}/${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`
    const { error } = await supabase.storage.from('rma-attachments').upload(fileName, file)
    if (error) throw error
    const {
      data: { publicUrl },
    } = supabase.storage.from('rma-attachments').getPublicUrl(fileName)
    return { name: file.name, url: publicUrl, path: fileName, size: file.size, type: file.type }
  },
}
