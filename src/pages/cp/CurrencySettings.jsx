import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { toUserMessage } from '../../lib/errorMessage'
import { db } from '../../api/supabaseClient'
import { supabase } from '../../api/client'
import { Button, Label, Input, Select } from '../../components/ui'
import { captureException } from '../../lib/sentry'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'

/**
 * Currency settings.
 *
 * This screen did not exist for the first five stages of the currency engine —
 * every knob was reachable only by pasting SQL. That is a fine way to apply a
 * migration and a poor way to run a business.
 *
 * Three things live here, and they are deliberately not equally editable:
 *
 *  1. THE BASE CURRENCY, read-only once any transaction document exists. Every
 *     exchange rate ever recorded is a ratio to it, and every stored amount was
 *     entered against it, so changing it later does not convert anything — it
 *     silently reinterprets every figure in the system. The database refuses it
 *     (rma_guard_base_currency, 20260791). Showing an editable control that the
 *     server would reject would be worse than showing the value plainly with
 *     the reason it is fixed.
 *
 *  2. THE CURRENCIES you can trade in — genuinely editable, and the thing an
 *     administrator actually needs when a new supplier invoices in a currency
 *     the list does not have.
 *
 *  3. WHETHER PURCHASE TAX IS PART OF COST. Off by default: VAT on goods for
 *     resale is recoverable, so including it overstates cost on every line.
 *     Businesses that cannot reclaim it turn this on.
 */
export default function CurrencySettings({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const baseCurrency = useBaseCurrency()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ code: '', name: '', symbol: '', decimals: '2' })

  const { data: currencies = EMPTY_ARRAY, isLoading } = useQuery({
    queryKey: ['currencies', 'all'],
    queryFn: async () => {
      const { data, error } = await supabase.from('currencies').select('*').order('code')
      if (error) {
        if (error.code === '42P01' || error.code === 'PGRST205') return []
        throw error
      }
      return data ?? []
    },
  })

  // How many documents lock the base currency. Shown rather than just asserted,
  // because "you cannot change this" is easier to accept with a number on it.
  const { data: lockCount } = useQuery({
    queryKey: ['currencies', 'doc-lock'],
    queryFn: async () => {
      const tables = [
        'crm_invoices', 'quotations', 'sales_orders',
        'purchase_orders', 'vendor_invoices', 'payments', 'vendor_payments',
      ]
      const counts = await Promise.all(
        tables.map(async (table) => {
          const { count, error } = await supabase
            .from(table)
            .select('id', { count: 'exact', head: true })
          return error ? 0 : count ?? 0
        })
      )
      return counts.reduce((a, b) => a + b, 0)
    },
  })

  const { data: taxInCost } = useQuery({
    queryKey: ['currencies', 'tax-in-cost'],
    queryFn: async () => {
      const result = await db.rmaConfig.getAll()
      if (result.missing) return false
      const row = result.data.find((r) => r.config_key === 'purchase_tax_in_cost')
      const v = row?.config_value
      return v === true || v === 'true'
    },
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['currencies'] })

  const setActive = async (code, isActive) => {
    setBusy(true)
    try {
      const { error } = await supabase
        .from('currencies')
        .update({ is_active: isActive })
        .eq('code', code)
      if (error) throw error
      refresh()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const addCurrency = async () => {
    const code = form.code.trim().toUpperCase()
    if (code.length !== 3 || !form.name.trim() || !form.symbol.trim()) return
    setBusy(true)
    try {
      const { error } = await supabase.from('currencies').insert({
        code,
        name: form.name.trim(),
        symbol: form.symbol.trim(),
        decimals: Number(form.decimals) || 2,
      })
      if (error) throw error
      setForm({ code: '', name: '', symbol: '', decimals: '2' })
      setAdding(false)
      refresh()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const toggleTaxInCost = async () => {
    setBusy(true)
    try {
      await db.rmaConfig.set('purchase_tax_in_cost', !taxInCost, currentUserEmail)
      refresh()
      toast.success(t('cp.currency.saved'))
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    )
  }

  const locked = (lockCount ?? 0) > 0
  const codeValid = form.code.trim().length === 3

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900 dark:text-[#e8ebf0]">
          {t('cp.currency.header')}
        </h2>
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-0.5">
          {t('cp.currency.subtitle')}
        </p>
      </div>

      {/* ── Base currency ──────────────────────────────────────────────────── */}
      <Card title={t('cp.currency.baseTitle')}>
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-bold text-gray-900 dark:text-[#e8ebf0]">{baseCurrency}</span>
          <span className="text-sm text-gray-500 dark:text-[#9aa4b2]">
            {currencies.find((c) => c.code === baseCurrency)?.name}
          </span>
        </div>
        <p className="text-sm text-gray-600 dark:text-[#9aa4b2] mt-3">
          {t('cp.currency.baseExplain')}
        </p>
        {locked ? (
          <div className="mt-3 border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 rounded-lg p-3">
            <p className="text-sm text-amber-900 dark:text-amber-300">
              {t('cp.currency.baseLocked', { count: lockCount })}
            </p>
          </div>
        ) : (
          <div className="mt-3 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg p-3">
            <p className="text-sm text-gray-600 dark:text-[#9aa4b2]">
              {t('cp.currency.baseChangeable')}
            </p>
          </div>
        )}
      </Card>

      {/* ── The currency list ──────────────────────────────────────────────── */}
      <Card
        title={t('cp.currency.listTitle')}
        action={
          !adding && (
            <Button variant="secondary" onClick={() => setAdding(true)}>
              {t('cp.currency.add')}
            </Button>
          )
        }
      >
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mb-3">
          {t('cp.currency.listHint')}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[#e6e9ef] dark:border-[#212a38]">
                <th className="py-2 text-start text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.currency.colCode')}</th>
                <th className="py-2 text-start text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.currency.colName')}</th>
                <th className="py-2 text-start text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.currency.colSymbol')}</th>
                <th className="py-2 text-center text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.currency.colDecimals')}</th>
                <th className="py-2 text-end text-xs uppercase text-[#6c6760] dark:text-[#9aa4b2]">{t('cp.currency.colActive')}</th>
              </tr>
            </thead>
            <tbody>
              {currencies.map((c) => {
                const isBase = c.code === baseCurrency
                return (
                  <tr key={c.code} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                    <td className="py-2.5 font-mono font-semibold text-gray-900 dark:text-[#e8ebf0]">
                      {c.code}
                      {isBase && (
                        <span className="ms-2 text-[10px] uppercase font-semibold text-indigo-600 dark:text-[#a5b4fc]">
                          {t('cp.currency.baseTag')}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-gray-700 dark:text-[#e8ebf0]">{c.name}</td>
                    <td className="py-2.5 text-gray-700 dark:text-[#e8ebf0]">{c.symbol}</td>
                    <td className="py-2.5 text-center text-gray-700 dark:text-[#e8ebf0]">{c.decimals}</td>
                    <td className="py-2.5 text-end">
                      {/* The base currency cannot be deactivated: every amount
                          in the system is denominated in it. */}
                      {isBase ? (
                        <span className="text-xs text-gray-400 dark:text-[#9aa4b2]">
                          {t('cp.currency.alwaysOn')}
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setActive(c.code, !c.is_active)}
                          disabled={busy}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                            c.is_active ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-[#2a3441]'
                          }`}
                          aria-label={c.code}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                              c.is_active ? 'translate-x-4' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {adding && (
          <div className="grid sm:grid-cols-5 gap-3 mt-4 pt-4 border-t border-[#e6e9ef] dark:border-[#212a38]">
            <div>
              <Label required>{t('cp.currency.colCode')}</Label>
              <Input
                aria-label={t('cp.currency.colCode')}
                value={form.code}
                maxLength={3}
                placeholder="JPY"
                onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
              />
            </div>
            <div className="sm:col-span-2">
              <Label required>{t('cp.currency.colName')}</Label>
              <Input
                aria-label={t('cp.currency.colName')}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div>
              <Label required>{t('cp.currency.colSymbol')}</Label>
              <Input
                aria-label={t('cp.currency.colSymbol')}
                value={form.symbol}
                onChange={(e) => setForm({ ...form, symbol: e.target.value })}
              />
            </div>
            <div>
              <Label>{t('cp.currency.colDecimals')}</Label>
              <Select
                aria-label={t('cp.currency.colDecimals')}
                value={form.decimals}
                onChange={(e) => setForm({ ...form, decimals: e.target.value })}
              >
                {/* 0 for yen-style currencies, 3 for Kuwaiti-style. Stored per
                    currency so formatting comes from data, not a hardcoded 2. */}
                {['0', '2', '3'].map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </Select>
            </div>
            <div className="sm:col-span-5 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setAdding(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                onClick={addCurrency}
                disabled={busy || !codeValid || !form.name.trim() || !form.symbol.trim()}
              >
                {busy ? t('common.saving') : t('common.add')}
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ── Purchase tax in cost ───────────────────────────────────────────── */}
      <Card title={t('cp.currency.taxTitle')}>
        <div className="flex items-start justify-between gap-4">
          <p className="text-sm text-gray-600 dark:text-[#9aa4b2]">
            {t('cp.currency.taxExplain')}
          </p>
          <button
            type="button"
            onClick={toggleTaxInCost}
            disabled={busy}
            aria-label={t('cp.currency.taxTitle')}
            className={`shrink-0 relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
              taxInCost ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-[#2a3441]'
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                taxInCost ? 'translate-x-4' : 'translate-x-1'
              }`}
            />
          </button>
        </div>
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-3">
          {t('cp.currency.taxRetroactive')}
        </p>
      </Card>
    </div>
  )
}

function Card({ title, action, children }) {
  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px]">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  )
}
