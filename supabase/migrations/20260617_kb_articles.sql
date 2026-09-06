-- FT-10: Knowledge Base / FAQ articles, surfaced in Control Panel (admin CRUD)
-- and on the public, unauthenticated /kb route (published articles only).

CREATE TABLE IF NOT EXISTS kb_articles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title         TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  body          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'general',
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_published  BOOLEAN NOT NULL DEFAULT false,
  created_by    TEXT,
  created_date  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS kb_articles_category_idx ON kb_articles(category);
CREATE INDEX IF NOT EXISTS kb_articles_published_idx ON kb_articles(is_published);

GRANT SELECT, INSERT, UPDATE, DELETE ON kb_articles TO anon, authenticated;

-- set_updated_date() is already defined in 20260524000001_features.sql
DROP TRIGGER IF EXISTS kb_articles_updated_date ON kb_articles;
CREATE TRIGGER kb_articles_updated_date
  BEFORE UPDATE ON kb_articles FOR EACH ROW EXECUTE FUNCTION set_updated_date();

ALTER TABLE kb_articles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS admin_all ON kb_articles;
CREATE POLICY admin_all ON kb_articles
  FOR ALL TO authenticated
  USING (public.rma_is_admin())
  WITH CHECK (public.rma_is_admin());

DROP POLICY IF EXISTS staff_read ON kb_articles;
CREATE POLICY staff_read ON kb_articles
  FOR SELECT TO authenticated
  USING (public.rma_is_staff());

-- Public tracker (/kb) reads as the anon role — only published articles.
DROP POLICY IF EXISTS anon_read_published ON kb_articles;
CREATE POLICY anon_read_published ON kb_articles
  FOR SELECT TO anon
  USING (is_published = true);
