import React, { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db, storage } from '../api/supabaseClient'
import { Button, Label, Select } from '../components/ui'
import { captureException } from '../lib/sentry'
import { EMPTY_ARRAY } from '../lib/stableEmpty'
import { extractText } from '../lib/pdfText'
import { DOC_TYPES } from '../lib/documentTypes'
import { matchFiles } from '../lib/skuMatch'

/**
 * Attaching a folder of vendor datasheets in one pass.
 *
 * ── Why the matches are shown before anything happens ───────────────────────
 *
 * The filename usually says which product a datasheet belongs to, so the SKU
 * matcher can do the filing. But filing a datasheet under the wrong product is
 * worse than not filing it at all — the search then answers questions about the
 * wrong part, confidently, and nobody has cause to doubt it. So the match table
 * is the whole feature: every row is shown, with how it was matched, and
 * nothing uploads until someone has looked. Rows the matcher could not resolve
 * are left for a person rather than guessed at.
 *
 * ── Why the uploads run one at a time ───────────────────────────────────────
 *
 * Reading the text out of a PDF happens in this tab, on the main thread. Firing
 * forty of them at once would lock the browser for a minute and look like a
 * crash. One at a time is slower on paper and far better to sit in front of,
 * because the row you are watching keeps moving.
 */
export default function KnowledgeUpload({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const fileRef = useRef(null)
  const cancelRef = useRef(false)

  const [rows, setRows] = useState([])
  const [docType, setDocType] = useState('datasheet')
  const [busy, setBusy] = useState(false)

  const { data: products = EMPTY_ARRAY } = useQuery({
    queryKey: ['products'],
    queryFn: () => db.products.list(),
    staleTime: 5 * 60_000,
  })

  // Sorted for the manual picker: someone hunting for a product scans by SKU.
  const productOptions = useMemo(
    () => [...products].sort((a, b) => String(a.sku ?? '').localeCompare(String(b.sku ?? ''))),
    [products]
  )

  const onPick = (e) => {
    const files = [...(e.target.files ?? [])]
    if (files.length === 0) return
    setRows(
      matchFiles(files, products).map((m) => ({
        ...m,
        productId: m.product?.id ?? '',
        status: m.product ? 'ready' : 'unmatched',
        error: null,
      }))
    )
  }

  const reset = () => {
    setRows([])
    if (fileRef.current) fileRef.current.value = ''
  }

  const setRowProduct = (index, productId) =>
    setRows((rs) =>
      rs.map((r, i) =>
        i === index
          ? { ...r, productId, status: productId ? 'ready' : 'unmatched', reason: 'manual' }
          : r
      )
    )

  const skipRow = (index) =>
    setRows((rs) => rs.map((r, i) => (i === index ? { ...r, status: 'skipped' } : r)))

  const uploadable = rows.filter((r) => r.status === 'ready' && r.productId)

  const run = async () => {
    if (uploadable.length === 0 || busy) return
    setBusy(true)
    cancelRef.current = false

    const update = (index, patch) =>
      setRows((rs) => rs.map((r, i) => (i === index ? { ...r, ...patch } : r)))

    let done = 0
    let failed = 0

    for (let i = 0; i < rows.length; i++) {
      if (cancelRef.current) break
      const row = rows[i]
      if (row.status !== 'ready' || !row.productId) continue

      const product = products.find((p) => p.id === row.productId)
      if (!product) {
        update(i, { status: 'failed', error: t('bulkUpload.errorNoProduct') })
        failed++
        continue
      }

      try {
        update(i, { status: 'extracting' })
        const extraction = await extractText(row.file)

        if (cancelRef.current) {
          update(i, { status: 'ready' })
          break
        }

        update(i, { status: 'uploading' })
        const uploaded = await storage.uploadProductDocument(row.file, product.sku || product.id)

        await db.productDocuments.create({
          productId: product.id,
          // The filename minus its extension, which is what a person would
          // have typed anyway. Editable afterwards on the product.
          title: row.fileName.replace(/\.[^.]+$/, ''),
          docType,
          description: null,
          fileName: uploaded.name,
          fileUrl: uploaded.url,
          storagePath: uploaded.path,
          fileSize: uploaded.size,
          mimeType: uploaded.type,
          extractedText: extraction.text,
          extractionStatus: extraction.status,
          pageCount: extraction.pages,
          uploadedBy: currentUserEmail ?? null,
        })

        update(i, { status: 'done', searchable: extraction.status === 'ok' })
        done++
      } catch (err) {
        captureException(err)
        // One bad file must not abandon the other thirty-nine.
        update(i, { status: 'failed', error: err.message })
        failed++
      }
    }

    queryClient.invalidateQueries({ queryKey: ['product-documents'] })
    queryClient.invalidateQueries({ queryKey: ['knowledge-center'] })
    queryClient.invalidateQueries({ queryKey: ['document-coverage'] })
    setBusy(false)

    if (failed === 0) toast.success(t('bulkUpload.finished', { count: done }))
    else toast.error(t('bulkUpload.finishedWithErrors', { count: done, failed }))
  }

  const statusStyles = {
    ready: 'text-gray-500 dark:text-[#9aa4b2]',
    unmatched: 'text-amber-600 dark:text-amber-400',
    extracting: 'text-indigo-600 dark:text-[#a5b4fc]',
    uploading: 'text-indigo-600 dark:text-[#a5b4fc]',
    done: 'text-green-600 dark:text-green-400',
    failed: 'text-red-600 dark:text-red-400',
    skipped: 'text-gray-400 dark:text-[#6c7280]',
  }

  return (
    <div className="space-y-4">
      <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0] mb-1">
          {t('bulkUpload.title')}
        </h3>
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mb-3">{t('bulkUpload.hint')}</p>

        <div className="grid sm:grid-cols-3 gap-3 items-end">
          <div className="sm:col-span-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              onChange={onPick}
              disabled={busy}
              accept=".pdf,.txt,.csv,.doc,.docx,.xls,.xlsx,image/*"
              aria-label={t('bulkUpload.chooseFiles')}
              className="block w-full text-sm text-gray-600 dark:text-[#9aa4b2] file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100 disabled:opacity-50"
            />
          </div>
          <div>
            <Label>{t('documents.type')}</Label>
            <Select
              aria-label={t('documents.type')}
              value={docType}
              disabled={busy}
              onChange={(e) => setDocType(e.target.value)}
            >
              {DOC_TYPES.map((d) => (
                <option key={d} value={d}>{t(`documents.type_${d}`)}</option>
              ))}
            </Select>
          </div>
        </div>
      </div>

      {rows.length > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3 justify-between">
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">
              {t('bulkUpload.summary', {
                total: rows.length,
                matched: rows.filter((r) => r.productId).length,
                unmatched: rows.filter((r) => r.status === 'unmatched').length,
              })}
            </p>
            <div className="flex items-center gap-2">
              {busy ? (
                <Button variant="secondary" onClick={() => (cancelRef.current = true)}>
                  {t('bulkUpload.stopAfterCurrent')}
                </Button>
              ) : (
                <Button variant="secondary" onClick={reset}>
                  {t('common.clear')}
                </Button>
              )}
              <Button onClick={run} disabled={busy || uploadable.length === 0}>
                {busy
                  ? t('common.saving')
                  : t('bulkUpload.uploadN', { count: uploadable.length })}
              </Button>
            </div>
          </div>

          <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[#e6e9ef] dark:border-[#212a38]">
                  <th className="text-start px-4 py-2.5 text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] font-semibold">
                    {t('bulkUpload.file')}
                  </th>
                  <th className="text-start px-4 py-2.5 text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] font-semibold">
                    {t('bulkUpload.product')}
                  </th>
                  <th className="text-start px-4 py-2.5 text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2] font-semibold">
                    {t('bulkUpload.status')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => (
                  <tr
                    key={`${row.fileName}-${i}`}
                    className="border-b border-[#e6e9ef] dark:border-[#212a38] last:border-0"
                  >
                    <td className="px-4 py-2.5 align-top">
                      <p className="text-gray-900 dark:text-[#e8ebf0] break-all">{row.fileName}</p>
                      {/* How the match was made, so an odd one is obvious. */}
                      {row.productId && row.reason !== 'manual' && (
                        <p className="text-[11px] text-gray-400 dark:text-[#6c7280]">
                          {t(`bulkUpload.reason_${row.reason}`)}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-2.5 align-top min-w-[240px]">
                      <Select
                        value={row.productId}
                        disabled={busy || row.status === 'done'}
                        aria-label={`${t('bulkUpload.product')} ${row.fileName}`}
                        onChange={(e) => setRowProduct(i, e.target.value)}
                      >
                        <option value="">{t('bulkUpload.chooseProduct')}</option>
                        {productOptions.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.sku} — {p.product_name}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-4 py-2.5 align-top whitespace-nowrap">
                      <span className={`text-xs ${statusStyles[row.status] ?? ''}`}>
                        {t(`bulkUpload.status_${row.status}`)}
                      </span>
                      {row.status === 'done' && row.searchable === false && (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400">
                          {t('documents.notSearchable')}
                        </p>
                      )}
                      {row.error && (
                        <p className="text-[11px] text-red-600 dark:text-red-400 max-w-[220px] break-words">
                          {row.error}
                        </p>
                      )}
                      {row.status === 'unmatched' && !busy && (
                        <button
                          type="button"
                          onClick={() => skipRow(i)}
                          className="block text-[11px] text-gray-400 hover:text-gray-600 underline"
                        >
                          {t('bulkUpload.skip')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
