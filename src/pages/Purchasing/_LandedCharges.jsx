import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { toUserMessage } from '../../lib/errorMessage'
import { db } from '../../api/supabaseClient'
import { Button, Label, Select, Input } from '../../components/ui'
import { captureException } from '../../lib/sentry'
import { formatMoney } from '../../lib/money'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'
import { CHARGE_TYPES } from './_shared'

/**
 * Landed charges on a vendor invoice — freight, customs, clearance, insurance.
 *
 * These are part of what the goods cost. Left out, every imported item looks
 * cheaper than it was: on an air shipment the freight alone can be a tenth of
 * the invoice, and the margin it inflates gets reported as profit.
 *
 * They are apportioned across the invoice's lines by line value at receipt and
 * folded into unit cost, so they have to be entered BEFORE the goods are
 * received. The database refuses a change afterwards (trg_charges_before_
 * receipt), because by then the cost is already written onto units sitting in a
 * warehouse and editing the charge would leave the two disagreeing with nothing
 * to say which is right.
 *
 * Amounts are in the invoice's own currency, like its line items — the
 * conversion to base currency happens once, at receipt, at the invoice rate.
 */
export default function LandedCharges({
  vendorInvoiceId,
  currency,
  locked,
  canEdit,
  currentUserEmail,
}) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [chargeType, setChargeType] = useState('freight')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)

  const { data: charges = EMPTY_ARRAY } = useQuery({
    queryKey: ['vi-charges', vendorInvoiceId],
    queryFn: () => db.vendorInvoiceCharges.list(vendorInvoiceId),
    enabled: !!vendorInvoiceId,
  })

  const total = charges.reduce((sum, c) => sum + (Number(c.amount) || 0), 0)
  const value = parseFloat(amount)
  const canSave = Number.isFinite(value) && value > 0

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['vi-charges', vendorInvoiceId] })
    // The receipt dialog previews landed cost from these, so it has to re-read.
    queryClient.invalidateQueries({ queryKey: ['vi-landed-costs', vendorInvoiceId] })
  }

  const closeForm = () => {
    setAdding(false)
    setAmount('')
    setDescription('')
  }

  const add = async () => {
    if (!canSave) return
    setBusy(true)
    try {
      await db.vendorInvoiceCharges.create({
        vendorInvoiceId,
        chargeType,
        description,
        amount: value,
        createdBy: currentUserEmail,
      })
      closeForm()
      refresh()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id) => {
    setBusy(true)
    try {
      await db.vendorInvoiceCharges.remove(id)
      refresh()
    } catch (err) {
      captureException(err)
      toast.error(toUserMessage(err))
    } finally {
      setBusy(false)
    }
  }

  // Nothing recorded and nothing can be: not worth a card on the page.
  if (locked && charges.length === 0) return null

  return (
    <div className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-[18px] mb-4">
      <div className="flex items-start justify-between mb-3 gap-3">
        <div>
          <div className="text-[10px] uppercase text-[#6c6760] dark:text-[#9aa4b2]">
            {t('purchasing.landedCharges')}
          </div>
          <p className="text-xs text-[#6c6760] dark:text-[#9aa4b2] mt-0.5">
            {locked ? t('purchasing.chargesLocked') : t('purchasing.chargesHint')}
          </p>
        </div>
        {canEdit && !locked && !adding && (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            {t('purchasing.addCharge')}
          </Button>
        )}
      </div>

      {charges.length === 0 ? (
        <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2]">{t('purchasing.noCharges')}</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {charges.map((c) => (
              <tr key={c.id} className="border-b border-[#f0f2f6] dark:border-[#1a2230]">
                <td className="py-2 text-[#211f1b] dark:text-[#e8ebf0]">
                  {t('purchasing.chargeType_' + c.charge_type)}
                  {c.description && (
                    <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2]"> — {c.description}</span>
                  )}
                </td>
                <td className="py-2 text-end font-medium text-[#211f1b] dark:text-[#e8ebf0] whitespace-nowrap">
                  {formatMoney(c.amount, currency)}
                </td>
                <td className="py-2 w-8 text-end">
                  {canEdit && !locked && (
                    <button
                      type="button"
                      onClick={() => remove(c.id)}
                      disabled={busy}
                      aria-label={t('common.delete')}
                      className="text-[#6c6760] dark:text-[#9aa4b2] hover:text-red-600 disabled:opacity-50"
                    >
                      ×
                    </button>
                  )}
                </td>
              </tr>
            ))}
            <tr>
              <td className="pt-2 font-semibold text-[#211f1b] dark:text-[#e8ebf0]">
                {t('purchasing.chargesTotal')}
              </td>
              <td className="pt-2 text-end font-bold text-indigo-600 dark:text-[#a5b4fc] whitespace-nowrap">
                {formatMoney(total, currency)}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      )}

      {adding && (
        <div className="grid sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-[#e6e9ef] dark:border-[#212a38]">
          <div>
            <Label>{t('purchasing.chargeKind')}</Label>
            <Select
              aria-label={t('purchasing.chargeKind')}
              value={chargeType}
              onChange={(e) => setChargeType(e.target.value)}
            >
              {CHARGE_TYPES.map((k) => (
                <option key={k} value={k}>
                  {t('purchasing.chargeType_' + k)}
                </option>
              ))}
            </Select>
          </div>
          <div className="sm:col-span-2">
            <Label>{t('purchasing.chargeDescription')}</Label>
            <Input
              aria-label={t('purchasing.chargeDescription')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <Label required>{t('purchasing.chargeAmount', { currency })}</Label>
            <Input
              aria-label={t('purchasing.chargeAmount', { currency })}
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="sm:col-span-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={closeForm}>
              {t('common.cancel')}
            </Button>
            <Button onClick={add} disabled={!canSave || busy}>
              {busy ? t('common.saving') : t('common.add')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
