import { supabase } from '../client.js'
import type { TableResult } from './types.js'

// ── Row types ─────────────────────────────────────────────────────────────────

export interface KBArticleRow {
  id: string
  title: string
  slug: string
  body: string
  category: string
  sort_order: number
  is_published: boolean
  created_by: string | null
  created_date: string
  updated_date: string
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export const kbArticles = {
  /** Admin: every article, published or draft. */
  async list(): Promise<TableResult<KBArticleRow[]>> {
    try {
      const { data, error } = await supabase
        .from('kb_articles')
        .select('*')
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },

  /** Public /kb page: only published articles. Works for anon and authenticated. */
  async listPublished(): Promise<TableResult<KBArticleRow[]>> {
    try {
      const { data, error } = await supabase
        .from('kb_articles')
        .select('*')
        .eq('is_published', true)
        .order('category', { ascending: true })
        .order('sort_order', { ascending: true })
      if (error) {
        if (error.code === '42P01') return { missing: true, data: [] }
        throw error
      }
      return { missing: false, data: data || [] }
    } catch {
      return { missing: true, data: [] }
    }
  },

  async create(article: {
    title: string
    body: string
    category?: string
    sort_order?: number
    is_published?: boolean
    created_by?: string
  }): Promise<KBArticleRow | undefined> {
    const baseSlug = slugify(article.title)
    let slug = baseSlug
    for (let attempt = 1; attempt <= 5; attempt++) {
      const { data: existing } = await supabase
        .from('kb_articles')
        .select('id')
        .eq('slug', slug)
        .maybeSingle()
      if (!existing) break
      slug = `${baseSlug}-${attempt}`
    }
    const { data, error } = await supabase
      .from('kb_articles')
      .insert([{ ...article, slug }])
      .select()
    if (error) throw error
    return data?.[0]
  },

  async update(id: string, article: Partial<KBArticleRow>): Promise<KBArticleRow | undefined> {
    const { data, error } = await supabase
      .from('kb_articles')
      .update(article)
      .eq('id', id)
      .select()
    if (error) throw error
    return data?.[0]
  },

  async delete(id: string): Promise<void> {
    const { error } = await supabase.from('kb_articles').delete().eq('id', id)
    if (error) throw error
  },
}
