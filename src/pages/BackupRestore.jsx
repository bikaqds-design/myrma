import React, { useState } from 'react'
import { backup as backupAPI, db } from '../api/supabaseClient'
import toast from 'react-hot-toast'

export default function BackupRestore({ currentUserRole, currentUserEmail }) {
  const [loading, setLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)

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

  const handleExportProducts = async () => {
    setLoading(true)
    try {
      const data = await backupAPI.exportProducts()
      downloadJSON(data, `products-backup-${new Date().toISOString().split('T')[0]}.json`)
      toast.success(`Exported ${data.length} products successfully!`)
      db.auditLog
        .log(currentUserEmail, 'backup_exported', `Exported ${data.length} products backup`)
        .catch(() => {})
    } catch (error) {
      console.error('Export products error:', error)
      toast.error('Failed to export products')
    } finally {
      setLoading(false)
    }
  }

  const handleExportCustomers = async () => {
    setLoading(true)
    try {
      const data = await backupAPI.exportCustomers()
      downloadJSON(data, `customers-backup-${new Date().toISOString().split('T')[0]}.json`)
      toast.success(`Exported ${data.length} customers successfully!`)
      db.auditLog
        .log(currentUserEmail, 'backup_exported', `Exported ${data.length} customers backup`)
        .catch(() => {})
    } catch (error) {
      console.error('Export customers error:', error)
      toast.error('Failed to export customers')
    } finally {
      setLoading(false)
    }
  }

  const handleExportTickets = async () => {
    setLoading(true)
    try {
      const data = await backupAPI.exportTickets()
      downloadJSON(data, `tickets-backup-${new Date().toISOString().split('T')[0]}.json`)
      toast.success(`Exported ${data.length} tickets successfully!`)
      db.auditLog
        .log(currentUserEmail, 'backup_exported', `Exported ${data.length} tickets backup`)
        .catch(() => {})
    } catch (error) {
      console.error('Export tickets error:', error)
      toast.error('Failed to export tickets')
    } finally {
      setLoading(false)
    }
  }

  const handleExportAll = async () => {
    setLoading(true)
    try {
      const data = await backupAPI.exportAll()
      downloadJSON(data, `myrma-full-backup-${new Date().toISOString().split('T')[0]}.json`)
      toast.success('Complete backup exported successfully!')
      db.auditLog
        .log(currentUserEmail, 'backup_exported', 'Exported complete system backup')
        .catch(() => {})
    } catch (error) {
      console.error('Export all error:', error)
      toast.error('Failed to export complete backup')
    } finally {
      setLoading(false)
    }
  }

  const handleFileUpload = async (event) => {
    const file = event.target.files[0]
    if (!file) return

    if (!file.name.endsWith('.json')) {
      toast.error('Please upload a valid JSON backup file')
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

          // Check if any data exists
          const hasData =
            data.products?.length > 0 || data.customers?.length > 0 || data.tickets?.length > 0

          if (!hasData) {
            toast.error('Backup file contains no data to restore')
            setRestoring(false)
            event.target.value = ''
            return
          }

          // Import only products, customers, and tickets (skip activity due to RLS)
          const results = {
            products: 0,
            customers: 0,
            tickets: 0,
            errors: [],
          }

          // Import Products
          if (data.products && data.products.length > 0) {
            try {
              await backupAPI.importProducts(data.products)
              results.products = data.products.length
            } catch (err) {
              results.errors.push(`Products: ${err.message}`)
            }
          }

          // Import Customers
          if (data.customers && data.customers.length > 0) {
            try {
              await backupAPI.importCustomers(data.customers)
              results.customers = data.customers.length
            } catch (err) {
              results.errors.push(`Customers: ${err.message}`)
            }
          }

          // Import Tickets
          if (data.tickets && data.tickets.length > 0) {
            try {
              await backupAPI.importTickets(data.tickets)
              results.tickets = data.tickets.length
            } catch (err) {
              results.errors.push(`Tickets: ${err.message}`)
            }
          }

          // Show results
          const successCount = results.products + results.customers + results.tickets

          if (successCount > 0) {
            const message = `Restored: ${results.products} products, ${results.customers} customers, ${results.tickets} tickets`
            toast.success(message)
            db.auditLog
              .log(
                currentUserEmail,
                'backup_imported',
                `Restored ${results.products} products, ${results.customers} customers, ${results.tickets} tickets from backup`
              )
              .catch(() => {})

            if (results.errors.length > 0) {
              console.warn('Some errors occurred:', results.errors)
              toast.error('Some data could not be restored. Check console for details.')
            } else {
              toast.success('Refresh the page to see restored data')
            }
          } else {
            toast.error('Failed to restore any data')
          }
        } catch (error) {
          console.error('Restore error:', error)
          toast.error('Failed to restore data: ' + error.message)
        } finally {
          setRestoring(false)
          event.target.value = ''
        }
      }

      reader.onerror = () => {
        toast.error('Failed to read backup file')
        setRestoring(false)
        event.target.value = ''
      }

      reader.readAsText(file)
    } catch (error) {
      console.error('File read error:', error)
      toast.error('Failed to read backup file')
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
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h2>
        <p className="text-gray-600">Only administrators can access backup & restore.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-gray-900">Backup & Restore</h1>
        <p className="text-gray-600 mt-2">Export and import your system data</p>
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
              <h2 className="text-xl font-bold text-gray-900">Export Data</h2>
              <p className="text-sm text-gray-600">Download backup files</p>
            </div>
          </div>

          <div className="space-y-3">
            <button
              onClick={handleExportProducts}
              disabled={loading}
              className="w-full px-4 py-3 bg-white border-2 border-gray-200 text-gray-700 rounded-lg hover:border-blue-500 hover:bg-blue-50 font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-between group"
            >
              <span className="flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-gray-500 group-hover:text-blue-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
                  />
                </svg>
                Export Products
              </span>
              <svg
                className="w-5 h-5 text-gray-500 group-hover:text-blue-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </button>

            <button
              onClick={handleExportCustomers}
              disabled={loading}
              className="w-full px-4 py-3 bg-white border-2 border-gray-200 text-gray-700 rounded-lg hover:border-blue-500 hover:bg-blue-50 font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-between group"
            >
              <span className="flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-gray-500 group-hover:text-blue-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
                  />
                </svg>
                Export Customers
              </span>
              <svg
                className="w-5 h-5 text-gray-500 group-hover:text-blue-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </button>

            <button
              onClick={handleExportTickets}
              disabled={loading}
              className="w-full px-4 py-3 bg-white border-2 border-gray-200 text-gray-700 rounded-lg hover:border-blue-500 hover:bg-blue-50 font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-between group"
            >
              <span className="flex items-center gap-2">
                <svg
                  className="w-5 h-5 text-gray-500 group-hover:text-blue-600"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z"
                  />
                </svg>
                Export RMA Tickets
              </span>
              <svg
                className="w-5 h-5 text-gray-500 group-hover:text-blue-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                />
              </svg>
            </button>

            <div className="pt-3 border-t-2 border-gray-200">
              <button
                onClick={handleExportAll}
                disabled={loading}
                className="w-full px-4 py-4 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-lg hover:from-blue-700 hover:to-indigo-700 font-semibold disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {loading ? (
                  <>
                    <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full"></div>
                    Exporting...
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
                    Export Complete Backup
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
                <p className="font-medium mb-1">Backup Tips:</p>
                <ul className="list-disc list-inside space-y-1 text-blue-700">
                  <li>Download regular backups (weekly recommended)</li>
                  <li>Store backups in a safe location</li>
                  <li>Complete backup includes all system data</li>
                </ul>
              </div>
            </div>
          </div>
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
              <h2 className="text-xl font-bold text-gray-900">Restore Data</h2>
              <p className="text-sm text-gray-600">Upload backup files</p>
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
                  <p className="text-lg font-medium text-gray-900">Restoring data...</p>
                  <p className="text-sm text-gray-600">Please wait, do not close this page</p>
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
                    <p className="text-lg font-medium text-gray-900">Click to upload backup file</p>
                    <p className="text-sm text-gray-600 mt-1">or drag and drop</p>
                  </div>
                  <p className="text-xs text-gray-500">JSON files only</p>
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
                <p className="font-medium mb-1">⚠️ Warning:</p>
                <ul className="list-disc list-inside space-y-1 text-yellow-700">
                  <li>Restore will merge data with existing records</li>
                  <li>Duplicate IDs will be updated</li>
                  <li>Create a backup before restoring</li>
                  <li>Only Products, Customers, and Tickets can be restored</li>
                </ul>
              </div>
            </div>
          </div>

          <div className="mt-6 p-4 bg-gray-50 border border-gray-200 rounded-lg">
            <h3 className="font-medium text-gray-900 mb-2">How to Restore:</h3>
            <ol className="list-decimal list-inside space-y-1 text-sm text-gray-700">
              <li>Click the upload area above</li>
              <li>Select your backup JSON file</li>
              <li>Wait for the restore process to complete</li>
              <li>Refresh the page to see restored data</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  )
}
