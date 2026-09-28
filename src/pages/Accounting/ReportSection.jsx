import React from 'react'
import { accountName } from './_ledger'

// One section of a financial report (A-08a): accounts grouped under their
// header with group subtotals and a section total; each account opens its
// entries.

const fmtMoney = (n) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px]'

export default function ReportSection({ title, groups, total, totalLabel, onOpen, lang, extraRows }) {
  return (
    <section className={`${card} overflow-hidden`}>
      <h3 className="px-4 py-2.5 text-sm font-bold text-[#211f1b] dark:text-[#e8ebf0] bg-[#f8f9fb] dark:bg-[#0f1520] border-b border-[#e6e9ef] dark:border-[#212a38]">{title}</h3>
      <table className="w-full text-sm">
        <tbody>
          {groups.map((g) => (
            <React.Fragment key={g.key}>
              {g.label && (
                <tr>
                  <td className="px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-[#6c6760] dark:text-[#9aa4b2]" colSpan={2}>
                    <span className="font-mono">{g.code}</span> {g.label}
                  </td>
                </tr>
              )}
              {g.rows.map((r) => (
                <tr key={r.account_id} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                  <td className="px-4 py-2 ps-8">
                    <button type="button" onClick={() => onOpen(r)} className="text-start text-[#4338ca] dark:text-[#a5b4fc] hover:underline">
                      <span className="font-mono text-xs">{r.code}</span> {accountName(r, lang)}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-end tabular-nums text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(r.amount)}</td>
                </tr>
              ))}
              {g.label && g.rows.length > 1 && (
                <tr className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                  <td className="px-4 py-1.5 ps-8 text-xs text-[#6c6760] dark:text-[#9aa4b2]">{g.label}</td>
                  <td className="px-4 py-1.5 text-end tabular-nums text-xs font-semibold text-[#6c6760] dark:text-[#9aa4b2]">{fmtMoney(g.total)}</td>
                </tr>
              )}
            </React.Fragment>
          ))}
          {extraRows}
        </tbody>
        <tfoot>
          <tr className="border-t border-[#e6e9ef] dark:border-[#212a38]">
            <td className="px-4 py-2.5 font-semibold text-[#211f1b] dark:text-[#e8ebf0]">{totalLabel}</td>
            <td className="px-4 py-2.5 text-end tabular-nums font-bold text-[#211f1b] dark:text-[#e8ebf0]">{fmtMoney(total)}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  )
}
