import React, { useState } from 'react'
import { backup as backupAPI, db } from '../api/supabaseClient'
import { BACKUP_MODULES } from '../api/backup'
import toast from 'react-hot-toast'
import { captureException } from '../lib/sentry'
import { useTranslation } from 'react-i18next'

export default function BackupRestore({ currentUserRole, currentUserEmail }) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  // What the last export actually contained. A backup you cannot see the shape
  // of is a backup you are trusting on faith.
  const [lastExport, setLastExport] = useState(null)

  const downloadJSON = (data, filename) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }

  const handleExportModule = async (moduleId) => {
    setLoading(true)
    try {
      const data = await backupAPI.exportModule(moduleId)
      downloadJSON(data, `myrma-${moduleId}-${new Date().toISOString().split('T')[0]}.json`)
      if (data.complete) {
        toast.success(
          t('backupRestore.moduleExported', {
            module: t(`backupRestore.module_${moduleId}`),
            rows: data.total_rows,
          })
        )
      } else {
        toast.error(
          t('backupRestore.exportAllPartial', {
            tables: data.failed_tables.map((f) => f.table).join(', '),
          }),
          { duration: 12000 }
        )
      }
      setLastExport(data)
      db.auditLog
        .log(currentUserEmail, 'backup_exported', `Exported ${moduleId} module (${data.total_rows} rows)`)
        .catch(() => {})
    } catch (error) {
      captureException(error)
      toast.error(`${t('backupRestore.failedExportAll')} — ${error.message}`, { duration: 12000 })
    } finally {
      setLoading(false)
    }
  }

  const handleExportAll = async () => {
    setLoading(true)
    try {
      const data = await backupAPI.exportAll()
      downloadJSON(data, `myrma-full-backup-${new Date().toISOString().split('T')[0]}.json`)
      // A partial backup still downloads — it is worth far more than nothing —
      // but it must never be mistaken for a whole one, so the tables that
      // failed are named on screen rather than left in the file for somebody
      // to find later.
      if (data.complete) {
        toast.success(t('backupRestore.exportAllSuccess'))
      } else {
        toast.error(
          t('backupRestore.exportAllPartial', {
            tables: data.failed_tables.map((f) => f.table).join(', '),
          }),
          { duration: 12000 }
        )
      }
      setLastExport(data)
      db.auditLog
        .log(currentUserEmail, 'backup_exported', 'Exported complete system backup')
        .catch(() => {})
    } catch (error) {
      captureException(error)
      // The reason used to go only to Sentry while the screen said "Failed to
      // export" — which names neither the table nor the cause, and leaves
      // somebody staring at a button that does not work.
      toast.error(`${t('backupRestore.failedExportAll')} — ${error.message}`, { duration: 12000 })
    } finally {
      setLoading(false)
    }
  }

  /** What the last export contained, so the file is not trusted on faith. */
  const ExportSummary = () =>
    !lastExport ? null : (
      <div
        className={`mt-4 p-4 rounded-lg border text-sm ${
          lastExport.complete
            ? 'bg-green-50 border-green-200 text-green-800'
            : 'bg-red-50 border-red-200 text-red-800'
        }`}
      >
        <p className="font-medium">{t('backupRestore.exportSummaryTitle')}</p>
        <p>
          {t('backupRestore.exportSummaryRows', {
            rows: lastExport.total_rows,
            tables: Object.keys(lastExport.counts).length,
          })}
        </p>
        <p className="mt-1">
          {lastExport.complete
            ? t('backupRestore.exportSummaryComplete')
            : t('backupRestore.exportSummaryFailed', {
                tables: lastExport.failed_tables.map((f) => `${f.table} (${f.error})`).join('; '),
              })}
        </p>
        {lastExport.skipped_tables?.length > 0 && (
          <p className="mt-1 text-xs opacity-80">
            {t('backupRestore.exportSummarySkipped', {
              tables: lastExport.skipped_tables.join(', '),
            })}
          </p>
        )}
      </div>
    )

  const handleFileUpload = async (event) => {
    const file = event.target.files[0]
    if (!file) return

    if (!file.name.endsWith('.json')) {
      toast.error(t('backupRestore.invalidJsonFile'))
      event.target.value = ''
      return
    }

    setRestoring(true)
    try {
      const reader = new FileReader()
      reader.onload = async (e) => {
        try {
          const backupData = JSON.parse(e.target.result)

          // Validate backup file structure
          if (!backupData.version || !backupData.data) {
            throw new Error('Invalid backup file structure. Missing version or data.')
          }

          const { data } = backupData

          // Any table with rows is worth restoring. This used to look only at
          // products, customers and tickets, so a backup containing nothing but
          // deals, invoices or inventory was rejected as "no data to restore".
          const hasData = Object.values(data).some((rows) => Array.isArray(rows) && rows.length > 0)

          if (!hasData) {
            toast.error(t('backupRestore.noDataToRestore'))
            setRestoring(false)
            event.target.value = ''
            return
          }

          // One call, which restores every table in foreign-key order. The
          // three calls this replaced — importProducts, importCustomers,
          // importTickets — were never implemented, so every restore threw and
          // reported "Failed to restore any data". importAll did exist and was
          // never called.
          const summary = await backupAPI.importAll(backupData)

          toast.success(
            t('backupRestore.restoreSuccessTables', {
              tables: summary.tablesRestored,
              rows: summary.rowsRestored,
            })
          )
          db.auditLog
            .log(
              currentUserEmail,
              'backup_imported',
              `Restored ${summary.rowsRestored} rows across ${summary.tablesRestored} tables from backup`
            )
            .catch(() => {})
          toast.success(t('backupRestore.refreshToSeeData'))
        } catch (error) {
          captureException(error)
          toast.error(t('backupRestore.failedRestoreData', { error: error.message }))
          // A restore that fails halfway has still written everything before
          // the failure. Saying so matters: the alternative is a user who
          // assumes nothing landed and restores again on top of partial data.
          if (error.summary?.tablesRestored) {
            toast(
              t('backupRestore.restorePartialSummary', {
                tables: error.summary.tablesRestored,
                rows: error.summary.rowsRestored,
              })
            )
          }
        } finally {
          setRestoring(false)
          event.target.value = ''
        }
      }

      reader.onerror = () => {
        toast.error(t('backupRestore.failedReadFile'))
        setRestoring(false)
        event.target.value = ''
      }

      reader.readAsText(file)
    } catch (error) {
      captureException(error)
      toast.error(t('backupRestore.failedReadFile'))
      setRestoring(false)
      event.target.value = ''
    }
  }

  if (currentUserRole !== 'admin' && currentUserRole !== 'super_admin') {
    return (
      <div className="text-center py-12">
        <svg
          className="w-16 h-16 text-red-600 mx-auto mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">{t('backupRestore.accessDenied')}</h2>
        <p className="text-gray-600">{t('backupRestore.adminOnly')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">{t('backupRestore.title')}</h1>
        <p className="text-gray-600 mt-2">{t('backupRestore.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Export Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-blue-100 rounded-lg flex items-center justify-center">
              <svg
                className="w-6 h-6 text-blue-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10"
                />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">{t('backupRestore.exportTitle')}</h2>
              <p className="text-sm text-gray-600">{t('backupRestore.exportSubtitle')}</p>
            </div>
          </div>

          <div className="space-y-3">
            {/* One button per module. Each writes the SAME envelope as the
                complete backup, so the restore reads them by the same path —
                the three buttons this replaced wrote a bare array that the
                restore rejected as an invalid file. */}
            <div className="grid sm:grid-cols-2 gap-2">
              {BACKUP_MODULES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => handleExportModule(m.id)}
                  disabled={loading}
                  className="px-4 py-3 bg-white border-2 border-gray-200 text-gray-700 rounded-lg hover:border-blue-500 hover:bg-blue-50 text-start disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <span className="block font-medium">{t(`backupRestore.module_${m.id}`)}</span>
                  <span className="block text-xs text-gray-500">
                    {t('backupRestore.moduleTableCount', { count: m.tables.length })}
                  </span>
                </button>
              ))}
            </div>

            {/* Said here rather than discovered during a recovery. */}
            <p className="text-xs text-gray-500">{t('backupRestore.moduleNotStandalone')}</p>
            <div className="pt-3 border-t-2 border-gray-200">
              <button
                onClick={handleExportAll}
                disabled={loading}
                className="w-full px-4 py-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg hover:from-blue-700 hover:to-indigo-700 font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full"></div>
                    {t('backupRestore.exporting')}
                  </>
                ) : (
                  <>
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                      />
                    </svg>
                    {t('backupRestore.exportAll')}
                  </>
                )}
              </button>
            </div>
          </div>

          <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <div className="flex gap-3">
              <svg
                className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <div className="text-sm text-blue-800">
                <p className="font-medium mb-1">{t('backupRestore.tipsTitle')}</p>
                <ul className="list-disc list-inside space-y-1 text-blue-700">
                  <li>{t('backupRestore.tip1')}</li>
                  <li>{t('backupRestore.tip2')}</li>
                  <li>{t('backupRestore.tip3')}</li>
                  <li>{t('backupRestore.tip4')}</li>
                </ul>
              </div>
            </div>
          </div>

          <ExportSummary />
        </div>

        {/* Restore Section */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 bg-green-100 rounded-lg flex items-center justify-center">
              <svg
                className="w-6 h-6 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">{t('backupRestore.restoreTitle')}</h2>
              <p className="text-sm text-gray-600">{t('backupRestore.restoreSubtitle')}</p>
            </div>
          </div>

          <label className="block">
            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center hover:border-green-500 hover:bg-green-50 transition-colors cursor-pointer">
              <input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                disabled={restoring}
                className="hidden"
              />

              {restoring ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="animate-spin w-12 h-12 border-4 border-green-600 border-t-transparent rounded-full"></div>
                  <p className="text-lg font-medium text-gray-900">{t('backupRestore.restoringData')}</p>
                  <p className="text-sm text-gray-600">{t('backupRestore.pleaseWait')}</p>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center">
                    <svg
                      className="w-8 h-8 text-green-600"
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
                      />
                    </svg>
                  </div>
                  <div>
                    <p className="text-lg font-medium text-gray-900">{t('backupRestore.clickToUpload')}</p>
                    <p className="text-sm text-gray-600 mt-1">{t('backupRestore.orDragDrop')}</p>
                  </div>
                  <p className="text-xs text-gray-500">{t('backupRestore.jsonOnly')}</p>
                </div>
              )}
            </div>
          </label>

          <div className="mt-6 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <div className="flex gap-3">
              <svg
                className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
              <div className="text-sm text-yellow-800">
                <p className="font-medium mb-1">{t('backupRestore.warningTitle')}</p>
                <ul className="list-disc list-inside space-y-1 text-yellow-700">
                  <li>{t('backupRestore.warn1')}</li>
                  <li>{t('backupRestore.warn2')}</li>
                  <li>{t('backupRestore.warn3')}</li>
                  <li>{t('backupRestore.warn4')}</li>
                  {/* The one that actually bites. Restoring without
                      reinstating the counters restarts invoice numbering at 1,
                      straight into codes the restore just recreated. */}
                  <li className="font-medium">{t('backupRestore.warn5')}</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
            <h3 className="font-medium text-gray-900 mb-2">{t('backupRestore.howToRestoreTitle')}</h3>
            <ol className="list-decimal list-inside space-y-1 text-sm text-gray-700">
              <li>{t('backupRestore.step1')}</li>
              <li>{t('backupRestore.step2')}</li>
              <li>{t('backupRestore.step3')}</li>
              <li>{t('backupRestore.step4')}</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
