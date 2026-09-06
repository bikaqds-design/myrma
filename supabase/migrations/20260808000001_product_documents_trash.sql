-- Soft-delete for product_documents (Knowledge Center Vault redesign, 2026-09-03).
--
-- A document removed from the Vault moves to Trash instead of disappearing.
-- It stays recoverable there for 5 days, after which the app purges it (row
-- and storage file) the next time anyone opens the Vault or Trash — there is
-- no server-side cron for this; see the app-layer comment in
-- src/lib/documentTrash.js for why a lazy, on-visit purge was chosen over one.
--
-- No RLS change is needed: the existing product_documents_manager_write
-- policy already covers UPDATE (trash/restore) and DELETE (purge) for
-- managers and above, the same role that could already remove a document.

alter table public.product_documents
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by text;

-- Every normal read excludes trashed rows, and the purge sweep and Trash
-- view both filter on this column — worth an index once the table has any
-- real volume of turnover.
create index if not exists product_documents_deleted_at_idx
  on public.product_documents (deleted_at);
