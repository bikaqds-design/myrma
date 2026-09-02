import React, { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { db, branding as brandingAPI } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../../lib/sentry'
import { useBaseCurrency } from '../../hooks/useBaseCurrency'

const DEFAULT_SECTION_ORDER = [
  'ticketInfo',
  'generalDescription',
  'products',
  'accessories',
  'attachments',
  'signatureLine',
]

// RMA ticket layout — stored under config_key 'pdf_layout'. Unchanged design.
const RMA_DEFAULT = {
  paperSize: 'A4',
  orientation: 'portrait',
  font: 'Arial, sans-serif',
  fontSize: 11,
  primaryColor: '#4F46E5',
  headerStyle: 'colored',
  showLogo: false,
  logoPosition: 'right',
  showCompanyName: true,
  showRmaNumber: true,
  showDate: true,
  sections: {
    ticketInfo: true,
    generalDescription: true,
    products: true,
    accessories: true,
    attachments: true,
    signatureLine: false,
  },
  sectionOrder: DEFAULT_SECTION_ORDER,
  footerText: '',
  showGeneratedDate: true,
  showWatermark: false,
}

// Sales documents layout — stored under config_key 'sales_doc_layout'.
// Drives the unified invoice-style layout (documentPdf.js).
const SALES_DEFAULT = {
  companyName: '',
  companyAddress: '',
  companyPhone: '',
  currency: 'EGP',
  primaryColor: '#4338ca',
  font: 'Arial, sans-serif',
  fontSize: 12,
  footerText: '',
  showGeneratedDate: true,
}

const FONTS = [
  { label: 'Calibri', value: 'Calibri, Candara, sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: "'Times New Roman', serif" },
  { label: 'Courier New', value: "'Courier New', monospace" },
]

export default function PDFLayout({ currentUserEmail }) {
  const { t } = useTranslation()
  const baseCurrency = useBaseCurrency()

  const SECTIONS_META = [
    { key: 'ticketInfo',          label: t('cp.pdfLayout.sectionTicketInfo'),     desc: t('cp.pdfLayout.sectionTicketInfoDesc') },
    { key: 'generalDescription',  label: t('cp.pdfLayout.sectionGeneralDesc'),    desc: t('cp.pdfLayout.sectionGeneralDescDesc') },
    { key: 'products',            label: t('cp.pdfLayout.sectionProducts'),       desc: t('cp.pdfLayout.sectionProductsDesc') },
    { key: 'accessories',         label: t('cp.pdfLayout.sectionAccessories'),    desc: t('cp.pdfLayout.sectionAccessoriesDesc') },
    { key: 'attachments',         label: t('cp.pdfLayout.sectionAttachments'),    desc: t('cp.pdfLayout.sectionAttachmentsDesc') },
    { key: 'signatureLine',       label: t('cp.pdfLayout.sectionSignature'),      desc: t('cp.pdfLayout.sectionSignatureDesc') },
  ]

  // Two independent layouts; `tab` selects which one is being edited.
  const [tab, setTab] = useState('sales')
  const [salesConfig, setSalesConfig] = useState(SALES_DEFAULT)
  const [rmaConfig, setRmaConfig] = useState(RMA_DEFAULT)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [logoUrl, setLogoUrl] = useState(null)

  // The active config + setter, so the shared card markup just uses `config`/`set`.
  const isSales = tab === 'sales'
  const config = isSales ? salesConfig : rmaConfig
  const setConfig = isSales ? setSalesConfig : setRmaConfig
  const set = (key, val) => setConfig((c) => ({ ...c, [key]: val }))
  const setSection = (key, val) => setConfig((c) => ({ ...c, sections: { ...c.sections, [key]: val } }))

  useEffect(() => { load() }, [])

  const load = async () => {
    try {
      const [cfgResult, brandingData] = await Promise.all([
        db.rmaConfig.getAll(),
        brandingAPI.getBranding(),
      ])
      if (brandingData?.logo_url) setLogoUrl(brandingData.logo_url)

      const readKey = (key) => {
        if (cfgResult.missing) return null
        const row = cfgResult.data.find((r) => r.config_key === key)
        if (!row?.config_value) return null
        try {
          return typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
        } catch { return null }
      }

      const rmaSaved = readKey('pdf_layout')
      if (rmaSaved) {
        setRmaConfig({
          ...RMA_DEFAULT,
          ...rmaSaved,
          sections: { ...RMA_DEFAULT.sections, ...(rmaSaved.sections || {}) },
          sectionOrder: rmaSaved.sectionOrder?.length ? rmaSaved.sectionOrder : DEFAULT_SECTION_ORDER,
        })
      } else if (brandingData?.primary_color) {
        setRmaConfig((c) => ({ ...c, primaryColor: brandingData.primary_color }))
      }

      const salesSaved = readKey('sales_doc_layout')
      setSalesConfig({
        ...SALES_DEFAULT,
        ...(salesSaved || {}),
        // Seed company name from branding the first time.
        companyName: salesSaved?.companyName || brandingData?.company_name || '',
      })
    } catch (err) {
      captureException(err)
    } finally {
      setLoading(false)
    }
  }

  const save = async () => {
    setSaving(true)
    try {
      const key = isSales ? 'sales_doc_layout' : 'pdf_layout'
      await db.rmaConfig.set(key, config, currentUserEmail)
      toast.success(t('cp.pdfLayout.saved'))
    } catch (err) {
      captureException(err)
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  const inp = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600'
  const Toggle = ({ checked, onChange }) => (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-gray-300'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  )

  if (loading)
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
      </div>
    )

  const previewColor = config.primaryColor || '#4F46E5'
  const previewFont = config.font || 'Arial, sans-serif'
  const previewFontSize = config.fontSize || 11
  const isLandscape = config.orientation === 'landscape'

  const TABS = [
    { id: 'sales', label: t('cp.pdfLayout.tabSalesDocuments') },
    { id: 'rma', label: t('cp.pdfLayout.tabRmaTicket') },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t('cp.pdfLayout.header')}</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            {isSales ? t('cp.pdfLayout.salesSubtitle') : t('cp.pdfLayout.rmaSubtitle')}
          </p>
        </div>
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50"
        >
          {saving ? t('cp.saving') : t('cp.pdfLayout.saveLayout')}
        </button>
      </div>

      {/* Layout tabs */}
      <div className="flex gap-1 border-b border-gray-200">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors ${
              tab === id
                ? 'border-indigo-600 text-indigo-700'
                : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* ─── Settings Panel ─── */}
        <div className="space-y-5">
          {isSales ? (
            <>
              {/* Company Identity — the text bar shown under the logo */}
              <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 mb-1 flex items-center gap-2">
                  <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0H5m14 0h2M5 21H3m9-12h.01M9 9h.01M15 9h.01M9 13h.01M15 13h.01M9 17h.01M15 17h.01" />
                  </svg>
                  {t('cp.pdfLayout.companyIdentity')}
                </h3>
                <p className="text-xs text-gray-500 mb-4">{t('cp.pdfLayout.companyIdentityHint')}</p>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.companyName')}</label>
                    <input value={config.companyName || ''} onChange={(e) => set('companyName', e.target.value)} className={inp} placeholder={t('cp.pdfLayout.companyNamePlaceholder')} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.companyAddress')}</label>
                    <input value={config.companyAddress || ''} onChange={(e) => set('companyAddress', e.target.value)} className={inp} placeholder={t('cp.pdfLayout.companyAddressPlaceholder')} />
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.companyPhone')}</label>
                      <input value={config.companyPhone || ''} onChange={(e) => set('companyPhone', e.target.value)} className={inp} placeholder={t('cp.pdfLayout.companyPhonePlaceholder')} />
                    </div>
                    {/* Read-only on purpose. This was an editable box, which
                        made it a second place to decide what currency the
                        business trades in — set it to USD while the books are
                        kept in EGP and every quotation printed dollars over
                        pound amounts. The base currency is installation config
                        and getPdfLayout() now takes it from there; leaving an
                        editable control that no longer decides anything would
                        be worse than showing the value plainly. */}
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.currency')}</label>
                      <input
                        value={baseCurrency}
                        readOnly
                        aria-readonly="true"
                        className={`${inp} font-mono bg-gray-50 text-gray-600 cursor-not-allowed`}
                      />
                      <p className="text-[11px] text-gray-500 mt-1">{t('cp.pdfLayout.currencyFromConfig')}</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Document Style — accent + font */}
              <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                  </svg>
                  {t('cp.pdfLayout.documentStyle')}
                </h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.primaryColor')}</label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={config.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} className="w-10 h-9 rounded border border-gray-300 cursor-pointer p-0.5" />
                      <input type="text" value={config.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} className={`${inp} font-mono flex-1`} />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.fontFamily')}</label>
                      <select value={config.font} onChange={(e) => set('font', e.target.value)} className={inp}>
                        {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.fontSize')}</label>
                      <div className="flex gap-2">
                        {[11, 12, 13, 14].map((s) => (
                          <button key={s} type="button" onClick={() => set('fontSize', s)}
                            className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${config.fontSize === s ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                            {s}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Page Setup */}
              <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  {t('cp.pdfLayout.pageSetup')}
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.paperSize')}</label>
                    <select value={config.paperSize} onChange={(e) => set('paperSize', e.target.value)} className={inp}>
                      <option value="A4">A4 (210 × 297 mm)</option>
                      <option value="Letter">US Letter (8.5 × 11 in)</option>
                      <option value="A5">A5 (148 × 210 mm)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.orientation')}</label>
                    <div className="flex gap-2">
                      {[{ v: 'portrait', l: t('cp.pdfLayout.portrait') }, { v: 'landscape', l: t('cp.pdfLayout.landscape') }].map(({ v, l }) => (
                        <button key={v} type="button" onClick={() => set('orientation', v)}
                          className={`flex-1 py-2 rounded-lg border text-sm font-medium capitalize transition-colors ${config.orientation === v ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Typography */}
              <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h8m-8 6h16" />
                  </svg>
                  {t('cp.pdfLayout.typography')}
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.fontFamily')}</label>
                    <select value={config.font} onChange={(e) => set('font', e.target.value)} className={inp}>
                      {FONTS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.fontSize')}</label>
                    <div className="flex gap-2">
                      {[9, 10, 11, 12].map((s) => (
                        <button key={s} type="button" onClick={() => set('fontSize', s)}
                          className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${config.fontSize === s ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                          {s}pt
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              {/* Branding & Header */}
              <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
                  <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                  </svg>
                  {t('cp.pdfLayout.brandingHeader')}
                </h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.headerStyle')}</label>
                    <div className="flex gap-2">
                      {[{ v: 'colored', l: t('cp.pdfLayout.headerColored') }, { v: 'minimal', l: t('cp.pdfLayout.headerMinimal') }, { v: 'none', l: t('cp.pdfLayout.headerNone') }].map(({ v, l }) => (
                        <button key={v} type="button" onClick={() => set('headerStyle', v)}
                          className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${config.headerStyle === v ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.primaryColor')}</label>
                    <div className="flex items-center gap-2">
                      <input type="color" value={config.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} className="w-10 h-9 rounded border border-gray-300 cursor-pointer p-0.5" />
                      <input type="text" value={config.primaryColor} onChange={(e) => set('primaryColor', e.target.value)} className={`${inp} font-mono flex-1`} />
                    </div>
                  </div>
                  <div className="space-y-3">
                    {[
                      { key: 'showLogo', label: t('cp.pdfLayout.showLogo'), sub: logoUrl ? t('cp.pdfLayout.logoFromAppearance') : t('cp.pdfLayout.noLogoSet') },
                      { key: 'showCompanyName', label: t('cp.pdfLayout.showCompanyName') },
                      { key: 'showRmaNumber', label: t('cp.pdfLayout.showRmaNumber') },
                      { key: 'showDate', label: t('cp.pdfLayout.showDate') },
                    ].map(({ key, label, sub }) => (
                      <div key={key} className="flex items-center justify-between">
                        <div>
                          <p className="text-sm text-gray-700">{label}</p>
                          {sub && <p className="text-xs text-gray-500">{sub}</p>}
                        </div>
                        <Toggle checked={!!config[key]} onChange={(v) => set(key, v)} />
                      </div>
                    ))}
                    {config.showLogo && (
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.logoPosition')}</label>
                        <div className="flex gap-2">
                          {[{ v: 'left', l: t('cp.pdfLayout.logoLeft') }, { v: 'right', l: t('cp.pdfLayout.logoRight') }].map(({ v, l }) => (
                            <button key={v} type="button" onClick={() => set('logoPosition', v)}
                              className={`flex-1 py-1.5 rounded-lg border text-sm font-medium capitalize transition-colors ${config.logoPosition === v ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                              {l}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Content Sections */}
              <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
                <h3 className="text-sm font-semibold text-gray-900 mb-1 flex items-center gap-2">
                  <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
                  </svg>
                  {t('cp.pdfLayout.contentSections')}
                </h3>
                <p className="text-xs text-gray-500 mb-4">{t('cp.pdfLayout.contentSectionsHint')}</p>
                <div className="space-y-2">
                  {(config.sectionOrder || DEFAULT_SECTION_ORDER).map((key, idx, arr) => {
                    const meta = SECTIONS_META.find((s) => s.key === key)
                    if (!meta) return null
                    const moveUp = () => {
                      if (idx === 0) return
                      const next = [...arr]
                      ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
                      setConfig((c) => ({ ...c, sectionOrder: next }))
                    }
                    const moveDown = () => {
                      if (idx === arr.length - 1) return
                      const next = [...arr]
                      ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
                      setConfig((c) => ({ ...c, sectionOrder: next }))
                    }
                    return (
                      <div key={key} className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${config.sections[key] ? 'bg-gray-50 border-gray-200' : 'bg-white border-gray-100 opacity-50'}`}>
                        <div className="flex flex-col gap-0.5">
                          <button type="button" onClick={moveUp} disabled={idx === 0} className="p-0.5 text-gray-500 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" /></svg>
                          </button>
                          <button type="button" onClick={moveDown} disabled={idx === arr.length - 1} className="p-0.5 text-gray-500 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
                          </button>
                        </div>
                        <span className="text-xs font-bold text-gray-300 w-4 text-center">{idx + 1}</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm text-gray-700 font-medium">{meta.label}</p>
                          <p className="text-xs text-gray-500">{meta.desc}</p>
                        </div>
                        <Toggle checked={!!config.sections[key]} onChange={(v) => setSection(key, v)} />
                      </div>
                    )
                  })}
                </div>
              </div>
            </>
          )}

          {/* Footer — shared by both layouts */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18" />
              </svg>
              {t('cp.pdfLayout.footer')}
            </h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">{t('cp.pdfLayout.footerText')}</label>
                <input value={config.footerText || ''} onChange={(e) => set('footerText', e.target.value)} className={inp} placeholder={t('cp.pdfLayout.footerPlaceholder')} />
              </div>
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-700">{t('cp.pdfLayout.showGeneratedDate')}</p>
                <Toggle checked={!!config.showGeneratedDate} onChange={(v) => set('showGeneratedDate', v)} />
              </div>
            </div>
          </div>
        </div>

        {/* ─── Live Preview ─── */}
        <div className="sticky top-0">
          <div className="bg-gray-100 rounded-xl p-6 border border-gray-200">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">{t('cp.pdfLayout.previewLabel')}</p>
            <div
              className={`bg-white shadow-xl mx-auto overflow-hidden ${!isSales && isLandscape ? 'max-w-full' : 'max-w-xs'}`}
              style={{
                aspectRatio: !isSales && isLandscape ? '1.414/1' : '1/1.414',
                fontFamily: previewFont,
                fontSize: `${previewFontSize * 0.7}px`,
                color: '#1F2937',
              }}
            >
              {isSales ? (
                /* ── Sales document preview ── */
                <div style={{ padding: '16px', height: '100%', display: 'flex', flexDirection: 'column' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '14px' }}>
                    <div style={{ maxWidth: '55%' }}>
                      {logoUrl ? (
                        <img src={logoUrl} alt="logo" style={{ maxHeight: '28px', objectFit: 'contain', marginBottom: '6px', display: 'block' }} />
                      ) : (
                        <div style={{ width: '48px', height: '28px', background: '#eef0f3', borderRadius: '3px', marginBottom: '6px' }} />
                      )}
                      <div style={{ fontWeight: 'bold', textTransform: 'uppercase', fontSize: `${previewFontSize * 0.62}px`, color: '#211f1b' }}>{config.companyName || 'Company Name'}</div>
                      {config.companyAddress && <div style={{ fontSize: `${previewFontSize * 0.55}px`, color: '#5a5f66' }}>{config.companyAddress}</div>}
                      {config.companyPhone && <div style={{ fontSize: `${previewFontSize * 0.55}px`, color: '#5a5f66' }}>{config.companyPhone}</div>}
                      <div style={{ marginTop: '8px' }}>
                        <div style={{ fontSize: `${previewFontSize * 0.5}px`, textTransform: 'uppercase', color: '#9aa0a6' }}>Bill To:</div>
                        <div style={{ fontWeight: 'bold', fontSize: `${previewFontSize * 0.6}px`, color: '#211f1b' }}>Sample Customer</div>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: '42%' }}>
                      <div style={{ fontSize: `${previewFontSize * 1.2}px`, fontWeight: 300, color: '#5a5f66', lineHeight: 1.1 }}>Quotation</div>
                      <div style={{ fontSize: `${previewFontSize * 0.55}px`, color: '#9aa0a6', marginBottom: '8px' }}># QT-12345678</div>
                      <table style={{ marginLeft: 'auto', borderCollapse: 'collapse' }}>
                        <tbody>
                          {[['Date', 'Nov 27, 2024'], ['Payment Terms', 'N/A'], ['Valid Until', 'N/A'], ['PO Number', 'N/A']].map(([l, v]) => (
                            <tr key={l}>
                              <td style={{ fontSize: `${previewFontSize * 0.52}px`, color: '#9aa0a6', textAlign: 'right', paddingRight: '10px' }}>{l}:</td>
                              <td style={{ fontSize: `${previewFontSize * 0.52}px`, color: '#211f1b', fontWeight: 600, textAlign: 'right' }}>{v}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ marginTop: '6px', marginLeft: 'auto', display: 'flex', justifyContent: 'space-between', gap: '16px', background: '#f1f2f4', borderRadius: '4px', padding: '4px 8px' }}>
                        <span style={{ fontWeight: 'bold', fontSize: `${previewFontSize * 0.58}px`, color: '#211f1b' }}>Balance Due:</span>
                        <span style={{ fontWeight: 'bold', fontSize: `${previewFontSize * 0.58}px`, color: previewColor }}>{`${baseCurrency} 104,834.22`}</span>
                      </div>
                    </div>
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr>
                        {['Product', 'Qty', 'Price', 'Total'].map((h) => (
                          <th key={h} style={{ background: '#f4f6f9', textAlign: 'left', padding: '3px 5px', fontSize: `${previewFontSize * 0.5}px`, textTransform: 'uppercase', color: '#6c6760', borderBottom: `1.5px solid ${previewColor}66` }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {[0, 1].map((r) => (
                        <tr key={r}>
                          {[0, 1, 2, 3].map((c) => (
                            <td key={c} style={{ padding: '4px 5px', borderBottom: '1px solid #f0f2f6' }}>
                              <div style={{ height: '5px', background: '#f0f2f4', borderRadius: '2px' }} />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: 'auto', borderTop: '1px solid #E5E7EB', paddingTop: '5px', textAlign: 'center', color: '#9CA3AF', fontSize: `${previewFontSize * 0.5}px` }}>
                    {config.footerText || config.companyName || 'myRMA'}
                    {config.showGeneratedDate ? ` · Generated ${new Date().toLocaleDateString()}` : ''}
                  </div>
                </div>
              ) : (
                /* ── RMA ticket preview ── */
                <div style={{ padding: '12px', height: '100%', display: 'flex', flexDirection: 'column' }}>
                  {config.headerStyle !== 'none' && (
                    <div style={{ borderBottom: config.headerStyle === 'colored' ? `2px solid ${previewColor}` : '1px solid #E5E7EB', paddingBottom: '8px', marginBottom: '10px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {config.showLogo && logoUrl && config.logoPosition === 'left' && <img src={logoUrl} alt="logo" style={{ height: '24px', objectFit: 'contain' }} />}
                        <div>
                          {config.showCompanyName && <div style={{ fontWeight: 'bold', color: previewColor, fontSize: `${previewFontSize * 0.8}px` }}>Company Name</div>}
                          <div style={{ fontWeight: '600', fontSize: `${previewFontSize * 0.75}px` }}>RMA Ticket</div>
                          {config.showRmaNumber && <div style={{ color: '#6B7280', fontSize: `${previewFontSize * 0.65}px` }}>RMA-18052026-0001</div>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        {config.showDate && <div style={{ fontSize: `${previewFontSize * 0.6}px`, color: '#6B7280' }}>18/05/2026</div>}
                        {config.showLogo && logoUrl && config.logoPosition === 'right' && <img src={logoUrl} alt="logo" style={{ height: '24px', objectFit: 'contain', marginLeft: '6px' }} />}
                      </div>
                    </div>
                  )}
                  <div style={{ flex: 1, overflow: 'hidden' }}>
                    {config.sections.ticketInfo && (
                      <div style={{ marginBottom: '8px' }}>
                        <div style={{ fontSize: `${previewFontSize * 0.6}px`, textTransform: 'uppercase', color: '#6B7280', borderBottom: '1px solid #E5E7EB', paddingBottom: '3px', marginBottom: '5px', letterSpacing: '0.05em' }}>Ticket Information</div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px' }}>
                          {['Customer', 'Assigned To', 'Due Date'].map((l) => (
                            <div key={l}>
                              <div style={{ fontSize: `${previewFontSize * 0.55}px`, color: '#9CA3AF' }}>{l}</div>
                              <div style={{ fontSize: `${previewFontSize * 0.65}px`, background: '#F3F4F6', borderRadius: '2px', height: '5px', marginTop: '2px' }} />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {config.sections.generalDescription && (
                      <div style={{ marginBottom: '8px' }}>
                        <div style={{ fontSize: `${previewFontSize * 0.6}px`, textTransform: 'uppercase', color: '#6B7280', borderBottom: '1px solid #E5E7EB', paddingBottom: '3px', marginBottom: '5px', letterSpacing: '0.05em' }}>General Description</div>
                        <div style={{ background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: '3px', height: '18px' }} />
                      </div>
                    )}
                    {config.sections.products && (
                      <div style={{ marginBottom: '8px' }}>
                        <div style={{ fontSize: `${previewFontSize * 0.6}px`, textTransform: 'uppercase', color: '#6B7280', borderBottom: '1px solid #E5E7EB', paddingBottom: '3px', marginBottom: '5px', letterSpacing: '0.05em' }}>Products</div>
                        <div style={{ border: '1px solid #E5E7EB', borderRadius: '3px', padding: '4px', height: '22px' }} />
                      </div>
                    )}
                    {config.sections.signatureLine && (
                      <div style={{ marginTop: 'auto', display: 'flex', gap: '12px' }}>
                        {['Customer Signature', 'Technician Signature'].map((l) => (
                          <div key={l} style={{ flex: 1 }}>
                            <div style={{ borderTop: '1px solid #374151', paddingTop: '3px', fontSize: `${previewFontSize * 0.55}px`, color: '#6B7280' }}>{l}</div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div style={{ borderTop: '1px solid #E5E7EB', paddingTop: '5px', marginTop: '8px', display: 'flex', justifyContent: 'space-between', color: '#9CA3AF', fontSize: `${previewFontSize * 0.55}px` }}>
                    <span>{config.footerText || 'myRMA'}</span>
                    {config.showGeneratedDate && <span>Generated: 18/05/2026</span>}
                  </div>
                </div>
              )}
            </div>
            {!isSales && (
              <p className="text-center text-xs text-gray-500 mt-3">
                {t('cp.pdfLayout.previewInfo', { paperSize: config.paperSize, orientation: config.orientation, fontSize: config.fontSize })}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
