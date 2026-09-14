import { supabase } from '../client.js'
import { assertUpdated, assertAffected } from './_assertUpdated.js'
import type { PagedResult } from './types.js'
import { fetchPage } from './_paging.js'
import { orIlike } from '../../lib/searchPattern.js'

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
  /**
   * One page of articles, by category then sort order, with the exact count.
   * `publishedOnly` is the public /kb page (anon and authenticated alike);
   * `search` matches title or body. Both screens used to load every article and
   * filter in the browser, capped by the Data API at 1 000 rows. (BUG-066.)
   *
   * `missing` is true when the table is not provisioned.
   */
  async listPage(
    { search, publishedOnly = false }: { search?: string | null; publishedOnly?: boolean },
    page: number,
    pageSize: number
  ): Promise<PagedResult<KBArticleRow>> {
    try {
      return await fetchPage<KBArticleRow>((from, to) => {
        let q = supabase.from('kb_articles').select('*', { count: 'exact' })
        if (publishedOnly) q = q.eq('is_published', true)
        const term = search?.trim()
        if (term) q = q.or(orIlike(['title', 'body'], term))
        return q
          .order('category', { ascending: true })
          .order('sort_order', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to)
      }, page, pageSize)
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (code === '42P01' || code === 'PGRST205') {
        return { missing: true, data: [], count: 0, page: 1, pageSize, totalPages: 0 }
      }
      throw error
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
    return assertUpdated(data, 'Article')
  },

  async delete(id: string): Promise<void> {
    const { data, error } = await supabase.from('kb_articles').delete().eq('id', id).select('id')
    if (error) throw error
    assertAffected(data, 'Article')
  },
}
