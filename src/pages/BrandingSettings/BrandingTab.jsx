import React from 'react'
import toast from 'react-hot-toast'
import { useTranslation } from 'react-i18next'
import { useAppearance } from '../../contexts/AppearanceContext'
import { Button, Input } from '../../components/ui'
import { BChip, BToggle, BRow, BCard } from './_shared'

export default function BrandingTab({
  branding,
  setBranding,
  logoPreview,
  handleLogoChange,
  removeLogo,
  saving,
  onSave,
  currentUserEmail,
}) {
  const {

    fontFamily,
    tableDensity,
    sidebarCompact,
    loginBg,
    dateFormat,
    timeFormat,
    faviconUrl,
    tabTitle,
    updateAppearance,
  } = useAppearance()
  const update = (partial) => updateAppearance(partial, currentUserEmail)
  const { t } = useTranslation()

  // Local draft for tabTitle — prevents context re-render on every keystroke
  const [draftTabTitle, setDraftTabTitle] = React.useState(tabTitle || '')
  React.useEffect(() => {
    setDraftTabTitle(tabTitle || '')
  }, [tabTitle])
  // Update browser title live without triggering global re-render
  React.useEffect(() => {
    document.title = draftTabTitle || 'myCRM'
  }, [draftTabTitle])

  const handleFaviconUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    if (file.size > 1024 * 1024) {
      toast.error(t('brandingSettings.faviconTooLarge'))
      return
    }
    const reader = new FileReader()
    reader.onloadend = () => {
      update({ faviconUrl: reader.result })
      toast.success(t('brandingSettings.faviconUpdated'))
    }
    reader.onerror = () => toast.error(t('brandingSettings.failedReadFavicon'))
    reader.readAsDataURL(file)
  }

  const FONTS = [
    { value: 'inter', label: 'Inter', sample: 'Aa' },
    { value: 'roboto', label: 'Roboto', sample: 'Aa' },
    { value: 'opensans', label: 'Open Sans', sample: 'Aa' },
    { value: 'poppins', label: 'Poppins', sample: 'Aa' },
    { value: 'system', label: 'System Default', sample: 'Aa' },
  ]
  const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY']

  const fmtDate = () => {
    const d = new Date()
    const dd = String(d.getDate()).padStart(2, '0'),
      mm = String(d.getMonth() + 1).padStart(2, '0'),
      yyyy = d.getFullYear()
    switch (dateFormat) {
      case 'MM/DD/YYYY':
        return `${mm}/${dd}/${yyyy}`
      case 'YYYY-MM-DD':
        return `${yyyy}-${mm}-${dd}`
      case 'DD-MM-YYYY':
        return `${dd}-${mm}-${yyyy}`
      default:
        return `${dd}/${mm}/${yyyy}`
    }
  }
  const fmtTime = () => {
    const d = new Date()
    let h = d.getHours()
    const m = String(d.getMinutes()).padStart(2, '0')
    if (timeFormat === '12h') {
      const ampm = h >= 12 ? 'PM' : 'AM'
      h = h % 12 || 12
      return `${h}:${m} ${ampm}`
    }
    return `${String(h).padStart(2, '0')}:${m}`
  }

  return (
    <div className="space-y-5">
      {/* ── Company Identity ── */}
      <BCard
        title="Company Identity"
        desc="Name, logo and brand colors"
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"
            />
          </svg>
        }
      >
        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                Company Name
              </label>
              <Input
                type="text"
                value={branding.company_name}
                onChange={(e) => setBranding({ ...branding, company_name: e.target.value })}
                placeholder="myCRM"
              />
              <p className="text-xs text-gray-500 mt-1">Shown in sidebar and login page</p>
            </div>
          </div>

          {/* Logo */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
              Company Logo
            </label>
            {logoPreview ? (
              <div className="flex items-center gap-4">
                <div className="w-24 h-20 border border-gray-200 rounded-xl flex items-center justify-center bg-gray-50 overflow-hidden">
                  <img
                    src={logoPreview}
                    alt="Logo"
                    className="max-w-full max-h-full object-contain p-1"
                  />
                </div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 cursor-pointer font-medium">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                      />
                    </svg>
                    Change Logo
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleLogoChange}
                      className="hidden"
                    />
                  </label>
                  <button
                    onClick={removeLogo}
                    className="flex items-center gap-2 px-4 py-2 border border-red-200 text-red-600 text-sm rounded-lg hover:bg-red-50 w-full justify-center"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                      />
                    </svg>
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center border-2 border-dashed border-gray-200 rounded-xl p-6 cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/30 transition-colors group">
                <svg
                  className="w-8 h-8 text-gray-300 group-hover:text-indigo-400 mb-2 transition-colors"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
                <p className="text-sm text-gray-500 group-hover:text-indigo-600">
                  Click to upload logo
                </p>
                <p className="text-xs text-gray-500 mt-0.5">PNG, JPG, SVG · Max 2MB</p>
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleLogoChange}
                  className="hidden"
                />
              </label>
            )}
          </div>

          {/* Brand Colors */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">
              Brand Colors
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { key: 'primary_color', label: 'Primary', hint: 'Buttons & links' },
                { key: 'secondary_color', label: 'Secondary', hint: 'Hover states' },
                { key: 'accent_color', label: 'Accent', hint: 'Success & badges' },
              ].map(({ key, label, hint }) => (
                <div
                  key={key}
                  className="flex items-center gap-3 p-3 border border-gray-200 rounded-xl bg-gray-50"
                >
                  <div className="relative">
                    <input
                      type="color"
                      value={branding[key]}
                      onChange={(e) => setBranding({ ...branding, [key]: e.target.value })}
                      className="w-10 h-10 rounded-lg cursor-pointer border-0 p-0.5 bg-transparent"
                    />
                    <div
                      className="absolute inset-0 rounded-lg border-2 border-white shadow-sm pointer-events-none"
                      style={{ background: branding[key] }}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-700">{label}</p>
                    <input
                      type="text"
                      value={branding[key]}
                      onChange={(e) => setBranding({ ...branding, [key]: e.target.value })}
                      className="w-full text-xs font-mono text-gray-600 bg-transparent border-0 p-0 focus:outline-none focus:text-indigo-700"
                    />
                    <p className="text-xs text-gray-500">{hint}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Live Preview */}
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 bg-gray-100 border-b border-gray-200">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                Live Preview
              </p>
            </div>
            <div className="p-5 bg-white flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-3">
                {logoPreview && (
                  <img
                    src={logoPreview}
                    alt=""
                    className="w-10 h-10 object-contain rounded-lg border border-gray-100"
                  />
                )}
                <div>
                  <p
                    className="font-bold text-lg leading-none"
                    style={{ color: branding.primary_color }}
                  >
                    {branding.company_name || 'myCRM'}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">RMA Management</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button
                  style={{ background: branding.primary_color }}
                  className="px-3 py-1.5 text-white text-sm rounded-lg font-medium"
                >
                  Primary
                </button>
                <button
                  style={{ background: branding.secondary_color }}
                  className="px-3 py-1.5 text-white text-sm rounded-lg font-medium"
                >
                  Secondary
                </button>
                <button
                  style={{ background: branding.accent_color }}
                  className="px-3 py-1.5 text-white text-sm rounded-lg font-medium"
                >
                  Accent
                </button>
              </div>
            </div>
          </div>

          <div className="pt-2">
            <Button loading={saving} onClick={onSave}>
              Save Branding
            </Button>
          </div>
        </div>
      </BCard>

      {/* ── Display & Layout ── */}
      <BCard
        title="Display & Layout"
        desc="Theme, sidebar, fonts and table density — apply instantly"
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"
            />
          </svg>
        }
      >
        <BRow label="Compact Sidebar" desc="Icons-only sidebar — hover to see labels">
          <BToggle checked={sidebarCompact} onChange={(v) => update({ sidebarCompact: v })} />
        </BRow>

        <div className="py-4 border-b border-gray-100">
          <p className="text-sm font-medium text-gray-900 mb-1">Font Family</p>
          <p className="text-xs text-gray-500 mb-3">Applied globally across all pages</p>
          <div className="flex flex-wrap gap-2">
            {FONTS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => update({ fontFamily: f.value })}
                style={{ fontFamily: f.value === 'system' ? 'system-ui' : f.label }}
                className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${fontFamily === f.value ? 'border-indigo-600 bg-indigo-50 text-indigo-700 shadow-sm' : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <div className="py-4 border-b border-gray-100">
          <p className="text-sm font-medium text-gray-900 mb-1">Table Density</p>
          <p className="text-xs text-gray-500 mb-3">Controls row height in all data tables</p>
          <div className="grid grid-cols-3 gap-2">
            {[
              { id: 'spacious', label: 'Spacious', desc: 'More breathing room' },
              { id: 'comfortable', label: 'Comfortable', desc: 'Balanced (default)' },
              { id: 'compact', label: 'Compact', desc: 'More rows visible' },
            ].map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => update({ tableDensity: d.id })}
                className={`px-3 py-3 rounded-xl border text-sm font-medium transition-all text-left ${tableDensity === d.id ? 'border-indigo-600 bg-indigo-50 text-indigo-700 shadow-sm' : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}
              >
                <span className="block font-semibold">{d.label}</span>
                <span className="block text-xs opacity-70 mt-0.5">{d.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <BRow label="Sidebar Position" desc="Coming soon — left or right sidebar" border={false}>
          <span className="text-xs px-2 py-1 bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2] rounded-full font-medium">
            Soon
          </span>
        </BRow>
      </BCard>

      {/* ── Regional & Formatting ── */}
      <BCard
        title="Regional & Formatting"
        desc="Date and time display format"
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        }
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-2">
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Date Format
            </label>
            <select
              value={dateFormat}
              onChange={(e) => update({ dateFormat: e.target.value })}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none bg-white"
            >
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Time Format
            </label>
            <div className="flex gap-2">
              {[
                { v: '24h', label: '24-hour (14:30)' },
                { v: '12h', label: '12-hour (2:30 PM)' },
              ].map((t) => (
                <BChip
                  key={t.v}
                  active={timeFormat === t.v}
                  onClick={() => update({ timeFormat: t.v })}
                >
                  {t.label}
                </BChip>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-6 px-4 py-3 bg-indigo-50 rounded-xl border border-indigo-100">
          <svg
            className="w-4 h-4 text-indigo-400 flex-shrink-0"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
            />
          </svg>
          <div className="flex gap-6 text-sm">
            <span>
              <span className="text-indigo-500 font-medium">Date: </span>
              <span className="font-mono font-semibold text-gray-800">{fmtDate()}</span>
            </span>
            <span>
              <span className="text-indigo-500 font-medium">Time: </span>
              <span className="font-mono font-semibold text-gray-800">{fmtTime()}</span>
            </span>
          </div>
        </div>
      </BCard>

      {/* ── Browser & Login ── */}
      <BCard
        title="Browser & Login"
        desc="Tab title, favicon and login page styling"
        icon={
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"
            />
          </svg>
        }
      >
        {/* Tab Title */}
        <div className="py-4 border-b border-gray-100">
          <p className="text-sm font-medium text-gray-900 mb-1">Browser Tab Title</p>
          <p className="text-xs text-gray-500 mb-3">
            Text shown in the browser tab — updates instantly
          </p>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg border border-gray-200 flex-1">
              <div className="flex gap-1">
                <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
              </div>
              <div className="flex-1 bg-white rounded px-2 py-0.5 text-xs text-gray-600 font-medium truncate border border-gray-200">
                {draftTabTitle || 'myCRM'} ×
              </div>
            </div>
          </div>
          <Input
            type="text"
            value={draftTabTitle}
            onChange={(e) => setDraftTabTitle(e.target.value)}
            onBlur={() => update({ tabTitle: draftTabTitle })}
            className="mt-2"
            placeholder="myCRM — Business Management"
          />
        </div>

        {/* Favicon */}
        <div className="py-4 border-b border-gray-100">
          <p className="text-sm font-medium text-gray-900 mb-1">Browser Favicon</p>
          <p className="text-xs text-gray-500 mb-3">
            Icon shown in the browser tab · PNG, ICO, SVG · Max 1MB · Recommended: 32×32 or 64×64 px
          </p>

          {/* Browser tab preview */}
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg border border-gray-200 mb-4 max-w-xs">
            <div className="flex gap-1 flex-shrink-0">
              <div className="w-2 h-2 rounded-full bg-red-400" />
              <div className="w-2 h-2 rounded-full bg-yellow-400" />
              <div className="w-2 h-2 rounded-full bg-green-400" />
            </div>
            <div className="flex-1 bg-white rounded px-2 py-1 flex items-center gap-1.5 border border-gray-200 min-w-0">
              {faviconUrl ? (
                <img src={faviconUrl} alt="" className="w-3.5 h-3.5 object-contain flex-shrink-0" />
              ) : (
                <div className="w-3.5 h-3.5 rounded-sm bg-gray-200 flex-shrink-0" />
              )}
              <span className="text-xs text-gray-600 truncate">{draftTabTitle || 'myCRM'}</span>
              <span className="text-gray-300 ml-auto text-xs flex-shrink-0">×</span>
            </div>
          </div>

          <div className="flex items-start gap-4">
            {/* Favicon preview box — no forced fixed size on the img itself */}
            <div
              className={`w-20 h-20 rounded-xl border-2 flex-shrink-0 flex items-center justify-center p-2 ${faviconUrl ? 'border-gray-200 bg-white shadow-sm' : 'border-dashed border-gray-200 bg-gray-50'}`}
            >
              {faviconUrl ? (
                <img
                  src={faviconUrl}
                  alt="favicon preview"
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    display: 'block',
                  }}
                />
              ) : (
                <svg
                  className="w-7 h-7 text-gray-300"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                  />
                </svg>
              )}
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg cursor-pointer transition-colors w-fit">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                  />
                </svg>
                {faviconUrl ? 'Change Favicon' : 'Upload Favicon'}
                <input
                  type="file"
                  accept=".png,.ico,.jpg,.svg"
                  onChange={handleFaviconUpload}
                  className="hidden"
                />
              </label>
              {faviconUrl && (
                <button
                  type="button"
                  onClick={() => update({ faviconUrl: '' })}
                  className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 font-medium px-2"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                    />
                  </svg>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Login Background */}
        <div className="py-4">
          <p className="text-sm font-medium text-gray-900 mb-1">Login Page Background</p>
          <p className="text-xs text-gray-500 mb-3">
            Hex color or CSS gradient shown on the sign-in screen
          </p>
          <div className="flex items-center gap-3">
            <input
              type="color"
              value={loginBg.startsWith('#') ? loginBg : '#eef2ff'}
              onChange={(e) => update({ loginBg: e.target.value })}
              className="w-10 h-10 rounded-lg cursor-pointer border border-gray-200 p-0.5 bg-transparent flex-shrink-0"
            />
            <input
              type="text"
              value={loginBg}
              onChange={(e) => update({ loginBg: e.target.value })}
              className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              placeholder="#eef2ff or linear-gradient(135deg,#eef2ff,#e0e7ff)"
            />
            <div
              className="w-14 h-10 rounded-lg border border-gray-200 flex-shrink-0 shadow-inner"
              style={{ background: loginBg }}
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              { label: 'Indigo', value: '#eef2ff' },
              { label: 'Slate', value: '#f1f5f9' },
              { label: 'Rose', value: '#fff1f2' },
              { label: 'Teal', value: '#f0fdfa' },
              { label: 'Gradient', value: 'linear-gradient(135deg,#eef2ff,#fce7f3)' },
              { label: 'Dark', value: 'linear-gradient(135deg,#1e1b4b,#312e81)' },
            ].map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => update({ loginBg: p.value })}
                className="flex items-center gap-1.5 px-3 py-1 border border-gray-200 rounded-lg text-xs font-medium text-gray-600 hover:border-indigo-300 hover:bg-indigo-50 transition-colors"
              >
                <span
                  className="w-3 h-3 rounded-full border border-gray-200 flex-shrink-0"
                  style={{ background: p.value }}
                />
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </BCard>

      <p className="text-xs text-gray-500 text-center pb-2">
        Display settings apply immediately for all users · Branding requires Save
      </p>
    </div>
  )
}
