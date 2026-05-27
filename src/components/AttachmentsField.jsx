import React from 'react'
import toast from 'react-hot-toast'

const MAX_FILE_SIZE = 25 * 1024 * 1024 // 25 MB

const ClipIcon = () => (
  <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13"
    />
  </svg>
)

const XIcon = () => (
  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
  </svg>
)

// Shared attachment field used in both AddCustomerModal and CustomerDetails edit mode.
// savedAttachments  — array of {name, url, path, size, type} objects already in DB
// onSavedChange     — called with new savedAttachments array when user removes one
// pendingFiles      — array of File objects not yet uploaded
// onPendingChange   — called with new pendingFiles array when user adds/removes
export default function AttachmentsField({
  savedAttachments = [],
  onSavedChange,
  pendingFiles = [],
  onPendingChange,
}) {
  const handleFileSelect = (e) => {
    if (!e.target.files?.length) return
    const incoming = Array.from(e.target.files)
    const oversize = incoming.filter((f) => f.size > MAX_FILE_SIZE)
    const valid = incoming.filter((f) => f.size <= MAX_FILE_SIZE)
    if (oversize.length) {
      toast.error(
        `${oversize.length} file${oversize.length !== 1 ? 's' : ''} exceeded 25 MB and were skipped`
      )
    }
    if (valid.length) onPendingChange([...pendingFiles, ...valid])
    e.target.value = ''
  }

  return (
    <div className="space-y-2">
      {/* Already-saved attachments */}
      {savedAttachments.map((att, i) => (
        <div
          key={i}
          className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-lg border border-gray-200"
        >
          <span className="text-gray-500">
            <ClipIcon />
          </span>
          <a
            href={att.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-indigo-600 hover:underline flex-1 truncate"
          >
            {att.name}
          </a>
          {att.size && (
            <span className="text-xs text-gray-500 flex-shrink-0">
              {(att.size / 1024).toFixed(0)} KB
            </span>
          )}
          <button
            type="button"
            onClick={() => onSavedChange(savedAttachments.filter((_, j) => j !== i))}
            className="w-5 h-5 flex items-center justify-center rounded text-gray-500 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0"
          >
            <XIcon />
          </button>
        </div>
      ))}

      {/* Pending (not yet uploaded) files */}
      {pendingFiles.map((file, i) => (
        <div
          key={i}
          className="flex items-center gap-2 px-3 py-2 bg-blue-50 rounded-lg border border-blue-200"
        >
          <span className="text-blue-400">
            <ClipIcon />
          </span>
          <span className="text-sm text-gray-700 flex-1 truncate">{file.name}</span>
          <span className="text-xs text-gray-500 flex-shrink-0">
            {(file.size / 1024).toFixed(0)} KB
          </span>
          <button
            type="button"
            onClick={() => onPendingChange(pendingFiles.filter((_, j) => j !== i))}
            className="w-5 h-5 flex items-center justify-center rounded text-gray-500 hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0"
          >
            <XIcon />
          </button>
        </div>
      ))}

      {/* File picker */}
      <label className="flex items-center gap-3 px-4 py-3 border-2 border-dashed border-gray-300 rounded-lg cursor-pointer hover:border-indigo-400 hover:bg-indigo-50 transition-colors group">
        <svg
          className="w-5 h-5 text-gray-500 group-hover:text-indigo-500 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        <span className="text-sm text-gray-500 group-hover:text-indigo-600">Attach files</span>
        <span className="text-xs text-gray-500 ml-auto">PDF, images, docs · max 25 MB each</span>
        <input type="file" multiple className="hidden" onChange={handleFileSelect} />
      </label>
    </div>
  )
}
