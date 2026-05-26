import React, { useState, useEffect } from 'react'
import { db, branding as brandingAPI } from '../../api/supabaseClient'
import toast from 'react-hot-toast'

const DEFAULT_SECTION_ORDER = ['ticketInfo', 'generalDescription', 'products', 'accessories', 'attachments', 'signatureLine']

const DEFAULT = {
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

const FONTS = [
  { label: 'Calibri', value: 'Calibri, Candara, sans-serif' },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: "'Times New Roman', serif" },
  { label: 'Courier New', value: "'Courier New', monospace" },
]

const SECTIONS_META = [
  { key: 'ticketInfo', label: 'Ticket Information', desc: 'Customer, assigned to, dates, status, priority' },
  { key: 'generalDescription', label: 'General Description', desc: 'RMA description / reason for return' },
  { key: 'products', label: 'Products', desc: 'Product list with serial numbers and issue details' },
  { key: 'accessories', label: 'Accessories Received', desc: 'Items received alongside the products' },
  { key: 'attachments', label: 'Attachments', desc: 'List of uploaded files' },
  { key: 'signatureLine', label: 'Signature Line', desc: 'Customer / technician signature space' },
]

export default function PDFLayout({ currentUserEmail }) {
  const [config, setConfig] = useState(DEFAULT)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [logoUrl, setLogoUrl] = useState(null)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    try {
      const [cfgResult, brandingData] = await Promise.all([db.rmaConfig.getAll(), brandingAPI.getBranding()])
      if (brandingData?.logo_url) setLogoUrl(brandingData.logo_url)

      let savedConfig = null
      if (!cfgResult.missing) {
        const row = cfgResult.data.find(r => r.config_key === 'pdf_layout')
        if (row?.config_value) {
          try {
            savedConfig = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value
          } catch { savedConfig = null }
        }
      }

      if (savedConfig) {
        setConfig({
          ...DEFAULT,
          ...savedConfig,
          sections: { ...DEFAULT.sections, ...(savedConfig.sections || {}) },
          sectionOrder: savedConfig.sectionOrder?.length ? savedConfig.sectionOrder : DEFAULT_SECTION_ORDER,
        })
      } else if (brandingData?.primary_color) {
        setConfig(c => ({ ...c, primaryColor: brandingData.primary_color }))
      }
    } catch {}
    finally { setLoading(false) }
  }

  const save = async () => {
    setSaving(true)
    try {
      await db.rmaConfig.set('pdf_layout', config, currentUserEmail)
      toast.success('PDF layout saved')
    } catch (err) { toast.error(err.message) }
    finally { setSaving(false) }
  }

  const set = (key, val) => setConfig(c => ({ ...c, [key]: val }))
  const setSection = (key, val) => setConfig(c => ({ ...c, sections: { ...c.sections, [key]: val } }))

  const inp = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600'
  const Toggle = ({ checked, onChange }) => (
    <button type="button" onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? 'bg-indigo-600' : 'bg-gray-300'}`}>
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-1'}`} />
    </button>
  )

  if (loading) return <div className="flex justify-center py-16"><div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" /></div>

  const previewColor = config.primaryColor || '#4F46E5'
  const previewFont = config.font || 'Arial, sans-serif'
  const previewFontSize = config.fontSize || 11
  const isLandscape = config.orientation === 'landscape'

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">PDF Layout</h2>
          <p className="text-sm text-gray-500 mt-0.5">Customize how RMA tickets look when printed or exported to PDF</p>
        </div>
        <button onClick={save} disabled={saving} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50">
          {saving ? 'Saving...' : 'Save Layout'}
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">

        {/* ─── Settings Panel ─── */}
        <div className="space-y-5">

          {/* Page Setup */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              Page Setup
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Paper Size</label>
                <select value={config.paperSize} onChange={e => set('paperSize', e.target.value)} className={inp}>
                  <option value="A4">A4 (210 × 297 mm)</option>
                  <option value="Letter">US Letter (8.5 × 11 in)</option>
                  <option value="A5">A5 (148 × 210 mm)</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Orientation</label>
                <div className="flex gap-2">
                  {['portrait', 'landscape'].map(o => (
                    <button key={o} type="button" onClick={() => set('orientation', o)}
                      className={`flex-1 py-2 rounded-lg border text-sm font-medium capitalize transition-colors ${config.orientation === o ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                      {o}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Typography */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h8m-8 6h16" /></svg>
              Typography
            </h3>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Font Family</label>
                <select value={config.font} onChange={e => set('font', e.target.value)} className={inp}>
                  {FONTS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Font Size</label>
                <div className="flex gap-2">
                  {[9, 10, 11, 12].map(s => (
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
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" /></svg>
              Branding & Header
            </h3>
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Header Style</label>
                <div className="flex gap-2">
                  {[{ v: 'colored', l: 'Colored' }, { v: 'minimal', l: 'Minimal' }, { v: 'none', l: 'None' }].map(({ v, l }) => (
                    <button key={v} type="button" onClick={() => set('headerStyle', v)}
                      className={`flex-1 py-2 rounded-lg border text-sm font-medium transition-colors ${config.headerStyle === v ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-gray-600 mb-1.5">Primary Color</label>
                  <div className="flex items-center gap-2">
                    <input type="color" value={config.primaryColor} onChange={e => set('primaryColor', e.target.value)} className="w-10 h-9 rounded border border-gray-300 cursor-pointer p-0.5" />
                    <input type="text" value={config.primaryColor} onChange={e => set('primaryColor', e.target.value)} className={`${inp} font-mono flex-1`} />
                  </div>
                </div>
              </div>
              <div className="space-y-3">
                {[
                  { key: 'showLogo', label: 'Show Company Logo', sub: logoUrl ? 'Using logo from Appearance settings' : 'No logo set — upload one in Appearance' },
                  { key: 'showCompanyName', label: 'Show Company Name' },
                  { key: 'showRmaNumber', label: 'Show RMA Number in Header' },
                  { key: 'showDate', label: 'Show Print Date' },
                ].map(({ key, label, sub }) => (
                  <div key={key} className="flex items-center justify-between">
                    <div>
                      <p className="text-sm text-gray-700">{label}</p>
                      {sub && <p className="text-xs text-gray-500">{sub}</p>}
                    </div>
                    <Toggle checked={!!config[key]} onChange={v => set(key, v)} />
                  </div>
                ))}
                {config.showLogo && (
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1.5">Logo Position</label>
                    <div className="flex gap-2">
                      {['left', 'right'].map(p => (
                        <button key={p} type="button" onClick={() => set('logoPosition', p)}
                          className={`flex-1 py-1.5 rounded-lg border text-sm font-medium capitalize transition-colors ${config.logoPosition === p ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:border-gray-300'}`}>
                          {p}
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
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
              Content Sections
            </h3>
            <p className="text-xs text-gray-500 mb-4">Toggle sections on/off and drag the arrows to reorder them in the PDF</p>
            <div className="space-y-2">
              {(config.sectionOrder || DEFAULT_SECTION_ORDER).map((key, idx, arr) => {
                const meta = SECTIONS_META.find(s => s.key === key)
                if (!meta) return null
                const moveUp = () => {
                  if (idx === 0) return
                  const next = [...arr]
                  ;[next[idx - 1], next[idx]] = [next[idx], next[idx - 1]]
                  setConfig(c => ({ ...c, sectionOrder: next }))
                }
                const moveDown = () => {
                  if (idx === arr.length - 1) return
                  const next = [...arr]
                  ;[next[idx], next[idx + 1]] = [next[idx + 1], next[idx]]
                  setConfig(c => ({ ...c, sectionOrder: next }))
                }
                return (
                  <div key={key} className={`flex items-center gap-3 p-3 rounded-lg border transition-colors ${config.sections[key] ? 'bg-gray-50 border-gray-200' : 'bg-white border-gray-100 opacity-50'}`}>
                    <div className="flex flex-col gap-0.5">
                      <button type="button" onClick={moveUp} disabled={idx === 0}
                        className="p-0.5 text-gray-500 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" /></svg>
                      </button>
                      <button type="button" onClick={moveDown} disabled={idx === arr.length - 1}
                        className="p-0.5 text-gray-500 hover:text-gray-700 disabled:opacity-20 disabled:cursor-not-allowed transition-colors">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" /></svg>
                      </button>
                    </div>
                    <span className="text-xs font-bold text-gray-300 w-4 text-center">{idx + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-gray-700 font-medium">{meta.label}</p>
                      <p className="text-xs text-gray-500">{meta.desc}</p>
                    </div>
                    <Toggle checked={!!config.sections[key]} onChange={v => setSection(key, v)} />
                  </div>
                )
              })}
            </div>
          </div>

          {/* Footer */}
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18" /></svg>
              Footer
            </h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1.5">Custom Footer Text</label>
                <input value={config.footerText} onChange={e => set('footerText', e.target.value)} className={inp} placeholder="e.g. Confidential — For internal use only" />
              </div>
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-700">Show Generated Date</p>
                <Toggle checked={!!config.showGeneratedDate} onChange={v => set('showGeneratedDate', v)} />
              </div>
            </div>
          </div>
        </div>

        {/* ─── Live Preview ─── */}
        <div className="sticky top-0">
          <div className="bg-gray-100 rounded-xl p-6 border border-gray-200">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-4">Preview</p>
            <div className={`bg-white shadow-xl mx-auto overflow-hidden ${isLandscape ? 'max-w-full' : 'max-w-xs'}`}
              style={{ aspectRatio: isLandscape ? '1.414/1' : '1/1.414', fontFamily: previewFont, fontSize: `${previewFontSize * 0.7}px`, color: '#1F2937' }}>
              <div style={{ padding: '12px', height: '100%', display: 'flex', flexDirection: 'column' }}>
                {/* Header */}
                {config.headerStyle !== 'none' && (
                  <div style={{
                    borderBottom: config.headerStyle === 'colored' ? `2px solid ${previewColor}` : '1px solid #E5E7EB',
                    paddingBottom: '8px', marginBottom: '10px',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {config.showLogo && logoUrl && config.logoPosition === 'left' && (
                        <img src={logoUrl} alt="logo" style={{ height: '24px', objectFit: 'contain' }} />
                      )}
                      <div>
                        {config.showCompanyName && <div style={{ fontWeight: 'bold', color: previewColor, fontSize: `${previewFontSize * 0.8}px` }}>Company Name</div>}
                        <div style={{ fontWeight: '600', fontSize: `${previewFontSize * 0.75}px` }}>RMA Ticket</div>
                        {config.showRmaNumber && <div style={{ color: '#6B7280', fontSize: `${previewFontSize * 0.65}px` }}>RMA-18052026-0001</div>}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      {config.showDate && <div style={{ fontSize: `${previewFontSize * 0.6}px`, color: '#6B7280' }}>18/05/2026</div>}
                      {config.showLogo && logoUrl && config.logoPosition === 'right' && (
                        <img src={logoUrl} alt="logo" style={{ height: '24px', objectFit: 'contain', marginLeft: '6px' }} />
                      )}
                    </div>
                  </div>
                )}

                {/* Content sections */}
                <div style={{ flex: 1, overflow: 'hidden' }}>
                  {config.sections.ticketInfo && (
                    <div style={{ marginBottom: '8px' }}>
                      <div style={{ fontSize: `${previewFontSize * 0.6}px`, textTransform: 'uppercase', color: '#6B7280', borderBottom: '1px solid #E5E7EB', paddingBottom: '3px', marginBottom: '5px', letterSpacing: '0.05em' }}>Ticket Information</div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '4px' }}>
                        {['Customer', 'Assigned To', 'Due Date'].map(l => (
                          <div key={l}><div style={{ fontSize: `${previewFontSize * 0.55}px`, color: '#9CA3AF' }}>{l}</div><div style={{ fontSize: `${previewFontSize * 0.65}px`, background: '#F3F4F6', borderRadius: '2px', height: '5px', marginTop: '2px' }} /></div>
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
                      {['Customer Signature', 'Technician Signature'].map(l => (
                        <div key={l} style={{ flex: 1 }}>
                          <div style={{ borderTop: '1px solid #374151', paddingTop: '3px', fontSize: `${previewFontSize * 0.55}px`, color: '#6B7280' }}>{l}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Footer */}
                <div style={{ borderTop: '1px solid #E5E7EB', paddingTop: '5px', marginTop: '8px', display: 'flex', justifyContent: 'space-between', color: '#9CA3AF', fontSize: `${previewFontSize * 0.55}px` }}>
                  <span>{config.footerText || 'myRMA'}</span>
                  {config.showGeneratedDate && <span>Generated: 18/05/2026</span>}
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-gray-500 mt-3">{config.paperSize} · {config.orientation} · {config.fontSize}pt</p>
          </div>
        </div>
      </div>
    </div>
  )
}
