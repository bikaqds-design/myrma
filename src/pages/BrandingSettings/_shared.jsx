export function BChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${active ? 'border-indigo-600 bg-indigo-50 text-indigo-700 shadow-sm' : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}
    >
      {children}
    </button>
  )
}

export function BToggle({ checked, onChange }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${checked ? 'bg-indigo-600' : 'bg-gray-200'}`}
    >
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`}
      />
    </button>
  )
}

export function BRow({ label, desc, children, border = true }) {
  return (
    <div
      className={`flex items-center justify-between gap-6 py-4 ${border ? 'border-b border-gray-100 last:border-0' : ''}`}
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        {desc && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

export function BCard({ title, desc, icon, children, action }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {icon && (
            <div className="w-8 h-8 rounded-lg bg-white border border-gray-200 flex items-center justify-center shadow-sm text-indigo-600">
              {icon}
            </div>
          )}
          <div>
            <p className="text-sm font-semibold text-gray-900">{title}</p>
            {desc && <p className="text-xs text-gray-500 mt-0.5">{desc}</p>}
          </div>
        </div>
        {action}
      </div>
      <div className="px-6 pb-6 pt-2">{children}</div>
    </div>
  )
}
