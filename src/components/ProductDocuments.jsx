import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { toUserMessage } from '../lib/errorMessage'
import { db, storage } from '../api/supabaseClient'
import { Button, Label, Input, Select, Textarea } from './ui'
import { captureException } from '../lib/sentry'
import { EMPTY_ARRAY } from '../lib/stableEmpty'
import { extractText, EXTRACTABLE_TYPES } from '../lib/pdfText'
import { DOC_TYPES } from '../lib/documentTypes'
import { buildSnippet } from '../lib/snippet'

/**
 * Documents attached to one product — the Knowledge Center's raw material.
 *
 * The upload does two things at once: puts the file in the bucket, and reads
 * the text out of it so the document becomes searchable. The second is the
 * point. A datasheet nobody can search is a file in a folder.
 *
 * Extraction happens here, in the browser, because there is no application
 * server to do it on. It is slow enough to need saying so — a 40-page PDF takes
 * a moment — and it can legitimately fail, which is reported rather than
 * hidden.
 */
export default function ProductDocuments({ product, currentUserEmail, canEdit }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [stage, setStage] = useState(null)
  const [pending, setPending] = useState(null)
  const [form, setForm] = useState({ title: '', docType: 'datasheet', description: '' })

  const { data: docs = EMPTY_ARRAY, isLoading } = useQuery({
    queryKey: ['product-documents', product?.id],
    queryFn: () => db.productDocuments.listForProduct(product.id),
    enabled: !!product?.id,
  })

  const reset = () => {
    setPending(null)
    setForm({ title: '', docType: 'datasheet', description: '' })
    if (fileRef.current) fileRef.current.value = ''
  }

  const onPick = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setPending(file)
    // Seed the title from the filename, minus the extension. Almost always
    // right, and always editable — better than an empty required field.
    setForm((f) => ({ ...f, title: f.title || file.name.replace(/\.[^.]+$/, '') }))
  }

  const upload = async () => {
    if (!pending || !form.title.trim()) return
    setBusy(true)
    try {
      // Extract first. If the file cannot be read we still want to store it,
      // but the status has to be recorded with the row rather than patched in
      // afterwards, where a failure would leave it stuck on 'pending'.
      setStage('extracting')
      const extraction = await extractText(pending)

      setStage('uploading')
      const uploaded = await storage.uploadProductDocument(pending, product.sku || product.id)

      await db.productDocuments.create({
        productId: product.id,
        title: form.title,
        docType: form.docType,
        description: form.description,
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

      queryClient.invalidateQueries({ queryKey: ['product-documents'] })
      queryClient.invalidateQueries({ queryKey: ['knowledge-center'] })
      reset()

      if (extraction.status === 'ok') toast.success(t('documents.uploadedSearchable'))
      else toast.success(t('documents.uploadedNotSearchable'))
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
      setStage(null)
    }
  }

  /**
   * Edit a document's metadata.
   *
   * Title, type and description only. The file, its storage path and the text
   * extracted from it are not editable here: those describe a specific upload,
   * and changing the label on a file is a different act from replacing it.
   * Someone who wants a different file uploads one.
   *
   * Worth knowing: this could not have worked before 20260804. product_documents
   * carried a trigger that set NEW.updated_date on a table whose column is
   * updated_at, so every UPDATE raised. The table had only ever been inserted
   * into and deleted from, so nothing noticed until a restore tried to write it.
   */
  const save = async (doc, patch) => {
    setBusy(true)
    try {
      await db.productDocuments.update(doc.id, patch)
      queryClient.invalidateQueries({ queryKey: ['product-documents'] })
      queryClient.invalidateQueries({ queryKey: ['knowledge-center'] })
      toast.success(t('documents.updated'))
      return true
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const remove = async (doc) => {
    setBusy(true)
    try {
      await db.productDocuments.remove(doc.id)
      // The row is what the app reads, so it goes first: a deleted row with an
      // orphaned file is untidy, a live row pointing at a deleted file is a
      // broken link someone will click.
      try {
        await storage.deleteFile(doc.storage_path)
      } catch (fileErr) {
        captureException(fileErr)
      }
      queryClient.invalidateQueries({ queryKey: ['product-documents'] })
      queryClient.invalidateQueries({ queryKey: ['knowledge-center'] })
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) {
    return <div className="py-8 text-center text-sm text-gray-500">{t('common.loading')}</div>
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] mb-1">
            {t('documents.addTitle')}
          </h3>
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mb-3">
            {t('documents.addHint')}
          </p>

          <input
            ref={fileRef}
            type="file"
            onChange={onPick}
            accept=".pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,image/*"
            aria-label={t('documents.chooseFile')}
            className="block w-full text-sm text-gray-600 dark:text-[#9aa4b2] file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100"
          />

          {pending && (
            <div className="mt-4 grid sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <Label required>{t('documents.title')}</Label>
                <Input
                  aria-label={t('documents.title')}
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                />
              </div>
              <div>
                <Label>{t('documents.type')}</Label>
                <Select
                  aria-label={t('documents.type')}
                  value={form.docType}
                  onChange={(e) => setForm({ ...form, docType: e.target.value })}
                >
                  {DOC_TYPES.map((d) => (
                    <option key={d} value={d}>{t(`documents.type_${d}`)}</option>
                  ))}
                </Select>
              </div>
              <div className="sm:col-span-3">
                <Label>{t('documents.description')}</Label>
                <Textarea
                  aria-label={t('documents.description')}
                  rows={2}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>

              {/* Only PDFs, text and CSV can be read. Saying so before the
                  upload sets the expectation, rather than after, when the
                  document turns out not to be searchable. */}
              {!EXTRACTABLE_TYPES.includes(pending.type) && (
                <p className="sm:col-span-3 text-xs text-amber-600 dark:text-amber-400">
                  {t('documents.notExtractable')}
                </p>
              )}

              <div className="sm:col-span-3 flex items-center justify-end gap-3">
                {stage && (
                  <span className="text-xs text-gray-500 dark:text-[#9aa4b2]">
                    {t(`documents.stage_${stage}`)}
                  </span>
                )}
                <Button variant="secondary" onClick={reset} disabled={busy}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={upload} disabled={busy || !form.title.trim()}>
                  {busy ? t('common.saving') : t('documents.upload')}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {docs.length === 0 ? (
        <div className="py-10 text-center">
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('documents.none')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <DocumentRow
              key={d.id}
              doc={d}
              onRemove={canEdit ? remove : null}
              onSave={canEdit ? save : null}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function DocumentRow({ doc, onRemove, onSave, busy, showProduct = false, query = '' }) {
  const { t } = useTranslation()
  const kb = doc.file_size ? Math.round(doc.file_size / 1024) : null
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(null)

  const beginEdit = () => {
    setDraft({
      title: doc.title ?? '',
      docType: doc.doc_type,
      description: doc.description ?? '',
    })
    setEditing(true)
  }

  const commit = async () => {
    if (!draft.title.trim()) return
    // Only what actually changed. Sending every field would touch updated_at on
    // a document nobody edited, and make the audit trail read as if they had.
    const patch = {}
    if (draft.title.trim() !== (doc.title ?? '')) patch.title = draft.title
    if (draft.docType !== doc.doc_type) patch.docType = draft.docType
    if (draft.description.trim() !== (doc.description ?? '')) {
      patch.description = draft.description
    }
    if (Object.keys(patch).length === 0) {
      setEditing(false)
      return
    }
    if (await onSave(doc, patch)) setEditing(false)
  }
  // Only search results carry a query and a body, so only they get a snippet.
  // A null result means the body genuinely did not match — the document was
  // found on its title — and inventing a passage there would misrepresent it.
  const snippet = useMemo(
    () => (query ? buildSnippet(doc.extracted_text, query) : null),
    [doc.extracted_text, query]
  )

  return (
    <div className="flex items-start gap-3 bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-4">
      <div className="shrink-0 w-9 h-9 rounded-lg bg-indigo-50 dark:bg-indigo-900/20 flex items-center justify-center text-indigo-600 dark:text-[#a5b4fc]">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
        </svg>
      </div>

      {editing ? (
        <div className="min-w-0 flex-1 grid sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <Label required>{t('documents.title')}</Label>
            <Input
              aria-label={t('documents.title')}
              value={draft.title}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </div>
          <div>
            <Label>{t('documents.type')}</Label>
            <Select
              aria-label={t('documents.type')}
              value={draft.docType}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, docType: e.target.value })}
            >
              {DOC_TYPES.map((d) => (
                <option key={d} value={d}>{t(`documents.type_${d}`)}</option>
              ))}
            </Select>
          </div>
          <div className="sm:col-span-3">
            <Label>{t('documents.description')}</Label>
            <Textarea
              aria-label={t('documents.description')}
              rows={2}
              value={draft.description}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            />
          </div>

          {/* The file itself is not editable here, and saying so beats leaving
              someone hunting for a control that does not exist. */}
          <p className="sm:col-span-3 text-[11px] text-gray-400 dark:text-[#6c7280]">
            {t('documents.editFileFixed', { file: doc.file_name })}
          </p>

          <div className="sm:col-span-3 flex items-center justify-end gap-2">
            <Button variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button onClick={commit} disabled={busy || !draft.title.trim()}>
              {busy ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </div>
      ) : (
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <a
            href={doc.file_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-gray-900 dark:text-[#e8ebf0] hover:text-indigo-600 hover:underline"
          >
            {doc.title}
          </a>
          <span className="px-2 py-0.5 text-[10px] uppercase font-semibold rounded-full bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2]">
            {t(`documents.type_${doc.doc_type}`)}
          </span>
          {/* A document that cannot be searched should say so where someone
              looking at it will see it, not only in a report. */}
          {doc.extraction_status !== 'ok' && (
            <span
              className="px-2 py-0.5 text-[10px] uppercase font-semibold rounded-full bg-amber-100 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400"
              title={t(`documents.status_${doc.extraction_status}_hint`)}
            >
              {t('documents.notSearchable')}
            </span>
          )}
        </div>

        {showProduct && doc.product && (
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
            {doc.product.product_name} · {doc.product.sku}
          </p>
        )}
        {doc.description && (
          <p className="text-xs text-gray-600 dark:text-[#9aa4b2] mt-1">{doc.description}</p>
        )}

        {/* The passage that matched, so a list of filenames becomes a list of
            answers and nobody opens six PDFs to find the one that says 180Hz. */}
        {snippet && (
          <p className="text-xs text-gray-600 dark:text-[#9aa4b2] mt-1.5 leading-relaxed bg-gray-50 dark:bg-[#0f1520] rounded-lg px-2.5 py-1.5">
            {snippet.before && '…'}
            {snippet.segments.map((seg, i) =>
              seg.match ? (
                <mark key={i} className="bg-amber-200 dark:bg-amber-500/30 dark:text-[#e8ebf0] rounded px-0.5">
                  {seg.text}
                </mark>
              ) : (
                <React.Fragment key={i}>{seg.text}</React.Fragment>
              )
            )}
            {snippet.after && '…'}
          </p>
        )}
        <p className="text-[11px] text-gray-400 dark:text-[#6c7280] mt-1">
          {doc.file_name}
          {kb !== null && ` · ${kb} KB`}
          {doc.page_count ? ` · ${t('documents.pages', { n: doc.page_count })}` : ''}
        </p>
      </div>

      )}

      {!editing && (onSave || onRemove) && (
        <div className="shrink-0 flex items-center gap-2">
          {onSave && (
            <button
              type="button"
              onClick={beginEdit}
              disabled={busy}
              aria-label={`${t('common.edit')} ${doc.title}`}
              className="text-gray-400 hover:text-indigo-600 disabled:opacity-50"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              onClick={() => onRemove(doc)}
              disabled={busy}
              aria-label={`${t('common.delete')} ${doc.title}`}
              className="text-gray-400 hover:text-red-600 disabled:opacity-50"
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  )
}
