import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ai } from '../api/supabaseClient'

function StarIcon({ className = '' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
    </svg>
  )
}

export default function AIAssist({ contextType, data, className = '' }) {
  const { t } = useTranslation()
  const [state, setState] = useState('idle')
  const [result, setResult] = useState(null)
  const [errMsg, setErrMsg] = useState('')

  const run = async () => {
    setState('loading')
    setErrMsg('')
    try {
      const res = await ai.assist(contextType, data)
      setResult(res)
      setState('done')
    } catch (err) {
      setErrMsg(err.message || t('aiAssist.failed'))
      setState('error')
    }
  }

  if (state === 'idle') {
    return (
      <button
        onClick={run}
        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[#eef2ff] dark:bg-[#1e1b4b] text-[#4338ca] dark:text-[#a5b4fc] hover:bg-[#e0e7ff] dark:hover:bg-[#252060] transition-colors ${className}`}
      >
        <StarIcon className="w-3 h-3" />
        {t('aiAssist.label')}
      </button>
    )
  }

  if (state === 'loading') {
    return (
      <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#eef2ff] dark:bg-[#1e1b4b] ${className}`}>
        <svg className="w-3.5 h-3.5 text-[#4338ca] dark:text-[#a5b4fc] animate-spin" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-xs text-[#4338ca] dark:text-[#a5b4fc] font-medium">Analyzing…</span>
      </div>
    )
  }

  return (
    <div className={`rounded-xl border border-[#c7d2fe] dark:border-[#2e3a8c] bg-[#f5f3ff] dark:bg-[#141830] p-4 ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <StarIcon className="w-3.5 h-3.5 text-[#4338ca] dark:text-[#a5b4fc]" />
          <span className="text-xs font-semibold text-[#4338ca] dark:text-[#a5b4fc]">{t('aiAssist.label')}</span>
        </div>
        <button
          onClick={run}
          className="text-[11px] text-[#746f65] dark:text-[#a4acb7] hover:text-[#4338ca] dark:hover:text-[#a5b4fc] transition-colors"
        >
          {t('aiAssist.regenerate')}
        </button>
      </div>

      {state === 'error' ? (
        <p className="text-xs text-red-500 dark:text-red-400">{errMsg}</p>
      ) : result ? (
        <div className="space-y-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2] mb-1.5">
              Summary
            </p>
            <p className="text-sm text-[#211f1b] dark:text-[#e8ebf0] leading-relaxed">
              {result.summary}
            </p>
          </div>
          <div className="border-t border-[#c7d2fe] dark:border-[#2e3a8c] pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#6c6760] dark:text-[#9aa4b2] mb-1.5">
              {t('aiAssist.suggestedNextAction')}
            </p>
            <div className="flex items-start gap-2">
              <div className="w-1.5 h-1.5 rounded-full bg-[#4338ca] dark:bg-[#a5b4fc] flex-shrink-0 mt-[5px]" />
              <p className="text-sm font-medium text-[#4338ca] dark:text-[#a5b4fc] leading-relaxed">
                {result.suggestion}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
