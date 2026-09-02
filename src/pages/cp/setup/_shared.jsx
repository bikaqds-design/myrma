import React from 'react'

/** The card every System Setup panel is built from. */
export function SetupCard({ title, action, children }) {
  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}
