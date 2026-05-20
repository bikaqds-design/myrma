import React, { useState, useEffect } from 'react'
import { branding as brandingAPI, notifications as notificationsAPI } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { useAppearance } from '../contexts/AppearanceContext'

export default function BrandingSettings({ currentUserRole, currentUserEmail, initialTab, visibleTabs }) {
  const [activeTab, setActiveTab] = useState(initialTab || 'branding')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  
  // Branding state
  const [branding, setBranding] = useState({
    company_name: 'myRMA',
    logo_url: null,
    primary_color: '#4F46E5',
    secondary_color: '#818CF8',
    accent_color: '#10B981'
  })
  const [logoFile, setLogoFile] = useState(null)
  const [logoPreview, setLogoPreview] = useState(null)

  // Notification state
  const [notificationPreferences, setNotificationPreferences] = useState({
    ticket_created: true,
    ticket_assigned: true,
    ticket_status_changed: true,
    ticket_priority_changed: true,
    comment_added: true,
    ticket_due_soon: true,
    ticket_overdue: true,
    daily_summary: false
  })
  const [emailTemplates, setEmailTemplates] = useState([])
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [showTemplateModal, setShowTemplateModal] = useState(false)

  // Email settings state
  const [emailSettings, setEmailSettings] = useState({
    provider: 'resend',
    api_key: '',
    from_email: 'noreply@yourdomain.com',
    from_name: 'myRMA System',
    is_active: false
  })

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      const [brandingData, prefsData, templatesData] = await Promise.all([
        brandingAPI.getBranding(),
        notificationsAPI.getPreferences(currentUserEmail),
        notificationsAPI.getTemplates()
      ])
      
      setBranding(brandingData)
      if (brandingData.logo_url) {
        setLogoPreview(brandingData.logo_url)
      }

      setNotificationPreferences(prefsData)
      setEmailTemplates(templatesData)

      // Load email settings
      try {
        const emailSettingsData = await notificationsAPI.getEmailSettings()
        if (emailSettingsData) {
          setEmailSettings(emailSettingsData)
        }
      } catch (error) {
        console.error('Error loading email settings:', error)
      }
    } catch (error) {
      console.error('Error loading data:', error)
      toast.error('Failed to load settings')
    } finally {
      setLoading(false)
    }
  }

  const handleLogoChange = (e) => {
    const file = e.target.files[0]
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast.error('Please select an image file')
        return
      }
      
      if (file.size > 2 * 1024 * 1024) {
        toast.error('Logo must be less than 2MB')
        return
      }

      setLogoFile(file)
      const reader = new FileReader()
      reader.onloadend = () => {
        setLogoPreview(reader.result)
      }
      reader.readAsDataURL(file)
    }
  }

  const handleSaveBranding = async () => {
    setSaving(true)
    try {
      let updates = {
        company_name: branding.company_name,
        primary_color: branding.primary_color,
        secondary_color: branding.secondary_color,
        accent_color: branding.accent_color
      }

      if (logoFile) {
        const logoUrl = await brandingAPI.uploadLogo(logoFile)
        updates.logo_url = logoUrl
      } else {
        updates.logo_url = branding.logo_url
      }

      await brandingAPI.updateBranding(updates, currentUserEmail)
      
      toast.success('Branding settings saved successfully!')
      loadData()
      setLogoFile(null)
      
      applyBrandingToApp(updates)
    } catch (error) {
      console.error('Error saving branding:', error)
      toast.error('Failed to save branding settings')
    } finally {
      setSaving(false)
    }
  }

  const applyBrandingToApp = (brandingData) => {
    document.documentElement.style.setProperty('--primary-color', brandingData.primary_color)
    document.documentElement.style.setProperty('--secondary-color', brandingData.secondary_color)
    document.documentElement.style.setProperty('--accent-color', brandingData.accent_color)
  }

  const removeLogo = () => {
    setLogoFile(null)
    setLogoPreview(null)
    setBranding({ ...branding, logo_url: null })
  }

  const handleSaveNotifications = async () => {
    setSaving(true)
    try {
      await notificationsAPI.updatePreferences(currentUserEmail, notificationPreferences)
      toast.success('Notification preferences saved successfully!')
    } catch (error) {
      console.error('Error saving notifications:', error)
      toast.error('Failed to save notification preferences')
    } finally {
      setSaving(false)
    }
  }

  const handleSaveEmailSettings = async () => {
    setSaving(true)
    try {
      await notificationsAPI.updateEmailSettings(emailSettings, currentUserEmail)
      toast.success('Email settings saved successfully!')
      loadData()
    } catch (error) {
      console.error('Error saving email settings:', error)
      toast.error('Failed to save email settings')
    } finally {
      setSaving(false)
    }
  }

  const handleEditTemplate = (template) => {
    setSelectedTemplate(template)
    setShowTemplateModal(true)
  }

  const handleSaveTemplate = async () => {
    if (!selectedTemplate) return
    
    setSaving(true)
    try {
      await notificationsAPI.updateTemplate(
        selectedTemplate.template_name,
        {
          template_subject: selectedTemplate.template_subject,
          template_body: selectedTemplate.template_body
        },
        currentUserEmail
      )
      toast.success('Email template updated successfully!')
      setShowTemplateModal(false)
      loadData()
    } catch (error) {
      console.error('Error saving template:', error)
      toast.error('Failed to save email template')
    } finally {
      setSaving(false)
    }
  }

  const handleSendTestEmail = async (templateName) => {
    try {
      const testVariables = {
        recipient_name: 'Test User',
        rma_number: 'RMA-TEST-001',
        customer_name: 'Test Customer',
        priority: 'High',
        status: 'In Progress',
        product_details: 'Test Product - SN123456',
        issue_description: 'This is a test email',
        company_name: branding.company_name,
        due_date: new Date().toLocaleDateString(),
        old_status: 'New',
        new_status: 'In Progress',
        updated_by: currentUserEmail,
        update_time: new Date().toLocaleString(),
        comment_author: currentUserEmail,
        comment_text: 'This is a test comment',
        days_overdue: '3'
      }

      await notificationsAPI.sendTestEmail(currentUserEmail, templateName, testVariables)
      toast.success('Test email sent successfully! Check your inbox.')
    } catch (error) {
      console.error('Error sending test email:', error)
      toast.error('Failed to send test email')
    }
  }

  if (currentUserRole !== 'admin' && currentUserRole !== 'super_admin') {
    return (
      <div className="text-center py-12">
        <svg className="w-16 h-16 text-red-600 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
        </svg>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h2>
        <p className="text-gray-600">Only administrators can access settings.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full"></div>
      </div>
    )
  }

  const isAppearanceOnly = visibleTabs && visibleTabs.length === 1 && visibleTabs[0] === 'branding'
  const pageTitle = isAppearanceOnly ? 'Appearance' : 'Email & Notifications'
  const pageDesc = isAppearanceOnly ? 'Customize the look and feel of your application' : 'Configure email delivery, notification preferences and templates'

  if (isAppearanceOnly) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{pageTitle}</h2>
          <p className="text-sm text-gray-500 mt-0.5">{pageDesc}</p>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin w-8 h-8 border-4 border-indigo-600 border-t-transparent rounded-full" />
          </div>
        ) : (
          <BrandingTab branding={branding} setBranding={setBranding} logoPreview={logoPreview}
            handleLogoChange={handleLogoChange} removeLogo={removeLogo} saving={saving}
            onSave={handleSaveBranding} currentUserEmail={currentUserEmail} />
        )}
        {showTemplateModal && selectedTemplate && (
          <TemplateModal template={selectedTemplate} onTemplateChange={setSelectedTemplate}
            saving={saving} onSave={handleSaveTemplate} onClose={() => setShowTemplateModal(false)} />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">{pageTitle}</h2>
        <p className="text-sm text-gray-500 mt-0.5">{pageDesc}</p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-200">
        <div className="border-b border-gray-200">
          <nav className="flex gap-8 px-6">
            {(!visibleTabs || visibleTabs.includes('branding')) && (
              <button onClick={() => setActiveTab('branding')}
                className={'py-4 border-b-2 font-medium transition-colors ' + (activeTab === 'branding' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700')}>
                Branding
              </button>
            )}
            {(!visibleTabs || visibleTabs.includes('email-settings')) && (
              <button onClick={() => setActiveTab('email-settings')}
                className={'py-4 border-b-2 font-medium transition-colors ' + (activeTab === 'email-settings' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700')}>
                Email Settings
              </button>
            )}
            {(!visibleTabs || visibleTabs.includes('notifications')) && (
              <button onClick={() => setActiveTab('notifications')}
                className={'py-4 border-b-2 font-medium transition-colors ' + (activeTab === 'notifications' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700')}>
                Notifications
              </button>
            )}
            {(!visibleTabs || visibleTabs.includes('templates')) && (
              <button onClick={() => setActiveTab('templates')}
                className={'py-4 border-b-2 font-medium transition-colors ' + (activeTab === 'templates' ? 'border-indigo-600 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700')}>
                Email Templates
              </button>
            )}
          </nav>
        </div>

        <div className="p-6">
          {activeTab === 'branding' && (
            <BrandingTab
              branding={branding}
              setBranding={setBranding}
              logoPreview={logoPreview}
              handleLogoChange={handleLogoChange}
              removeLogo={removeLogo}
              saving={saving}
              onSave={handleSaveBranding}
              currentUserEmail={currentUserEmail}
            />
          )}

          {activeTab === 'email-settings' && (
            <EmailSettingsTab
              settings={emailSettings}
              setSettings={setEmailSettings}
              saving={saving}
              onSave={handleSaveEmailSettings}
            />
          )}

          {activeTab === 'notifications' && (
            <NotificationsTab
              preferences={notificationPreferences}
              setPreferences={setNotificationPreferences}
              saving={saving}
              onSave={handleSaveNotifications}
            />
          )}

          {activeTab === 'templates' && (
            <TemplatesTab
              templates={emailTemplates}
              onEdit={handleEditTemplate}
              onSendTest={handleSendTestEmail}
            />
          )}
        </div>
      </div>

      {showTemplateModal && selectedTemplate && (
        <TemplateModal
          template={selectedTemplate}
          onTemplateChange={setSelectedTemplate}
          saving={saving}
          onSave={handleSaveTemplate}
          onClose={() => setShowTemplateModal(false)}
        />
      )}
    </div>
  )
}

function BChip({ active, onClick, children }) {
  return (
    <button type="button" onClick={onClick}
      className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${active ? 'border-indigo-600 bg-indigo-50 text-indigo-700 shadow-sm' : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}>
      {children}
    </button>
  )
}

function BToggle({ checked, onChange }) {
  return (
    <button type="button" onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none ${checked ? 'bg-indigo-600' : 'bg-gray-200'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}

function BRow({ label, desc, children, border = true }) {
  return (
    <div className={`flex items-center justify-between gap-6 py-4 ${border ? 'border-b border-gray-100 last:border-0' : ''}`}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900">{label}</p>
        {desc && <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{desc}</p>}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

function BCard({ title, desc, icon, children, action }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {icon && <div className="w-8 h-8 rounded-lg bg-white border border-gray-200 flex items-center justify-center shadow-sm text-indigo-600">{icon}</div>}
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

function BrandingTab({ branding, setBranding, logoPreview, handleLogoChange, removeLogo, saving, onSave, currentUserEmail }) {
  const { darkMode, fontFamily, tableDensity, sidebarCompact, loginBg, dateFormat, timeFormat, faviconUrl, tabTitle, updateAppearance } = useAppearance()
  const update = (partial) => updateAppearance(partial, currentUserEmail)

  // Local draft for tabTitle — prevents context re-render on every keystroke
  const [draftTabTitle, setDraftTabTitle] = React.useState(tabTitle || '')
  React.useEffect(() => { setDraftTabTitle(tabTitle || '') }, [tabTitle])
  // Update browser title live without triggering global re-render
  React.useEffect(() => { document.title = draftTabTitle || 'myRMA' }, [draftTabTitle])

  const handleFaviconUpload = (e) => {
    const file = e.target.files[0]
    if (!file) return
    if (file.size > 1024 * 1024) { return }
    const reader = new FileReader()
    reader.onloadend = () => update({ faviconUrl: reader.result })
    reader.readAsDataURL(file)
  }

  const FONTS = [
    { value: 'inter',    label: 'Inter',          sample: 'Aa' },
    { value: 'roboto',   label: 'Roboto',          sample: 'Aa' },
    { value: 'opensans', label: 'Open Sans',       sample: 'Aa' },
    { value: 'poppins',  label: 'Poppins',         sample: 'Aa' },
    { value: 'system',   label: 'System Default',  sample: 'Aa' },
  ]
  const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY']

  const fmtDate = () => {
    const d = new Date()
    const dd = String(d.getDate()).padStart(2,'0'), mm = String(d.getMonth()+1).padStart(2,'0'), yyyy = d.getFullYear()
    switch(dateFormat) { case 'MM/DD/YYYY': return `${mm}/${dd}/${yyyy}`; case 'YYYY-MM-DD': return `${yyyy}-${mm}-${dd}`; case 'DD-MM-YYYY': return `${dd}-${mm}-${yyyy}`; default: return `${dd}/${mm}/${yyyy}` }
  }
  const fmtTime = () => {
    const d = new Date(); let h = d.getHours(); const m = String(d.getMinutes()).padStart(2,'0')
    if (timeFormat === '12h') { const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${m} ${ampm}` }
    return `${String(h).padStart(2,'0')}:${m}`
  }

  return (
    <div className="space-y-5">

      {/* ── Company Identity ── */}
      <BCard title="Company Identity" desc="Name, logo and brand colors"
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"/></svg>}
      >
        <div className="space-y-4 pt-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Company Name</label>
              <input type="text" value={branding.company_name}
                onChange={e => setBranding({ ...branding, company_name: e.target.value })}
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
                placeholder="myRMA" />
              <p className="text-xs text-gray-400 mt-1">Shown in sidebar and login page</p>
            </div>
          </div>

          {/* Logo */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Company Logo</label>
            {logoPreview ? (
              <div className="flex items-center gap-4">
                <div className="w-24 h-20 border border-gray-200 rounded-xl flex items-center justify-center bg-gray-50 overflow-hidden">
                  <img src={logoPreview} alt="Logo" className="max-w-full max-h-full object-contain p-1" />
                </div>
                <div className="space-y-2">
                  <label className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 cursor-pointer font-medium">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
                    Change Logo
                    <input type="file" accept="image/*" onChange={handleLogoChange} className="hidden" />
                  </label>
                  <button onClick={removeLogo} className="flex items-center gap-2 px-4 py-2 border border-red-200 text-red-600 text-sm rounded-lg hover:bg-red-50 w-full justify-center">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <label className="flex flex-col items-center justify-center border-2 border-dashed border-gray-200 rounded-xl p-6 cursor-pointer hover:border-indigo-400 hover:bg-indigo-50/30 transition-colors group">
                <svg className="w-8 h-8 text-gray-300 group-hover:text-indigo-400 mb-2 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <p className="text-sm text-gray-500 group-hover:text-indigo-600">Click to upload logo</p>
                <p className="text-xs text-gray-400 mt-0.5">PNG, JPG, SVG · Max 2MB</p>
                <input type="file" accept="image/*" onChange={handleLogoChange} className="hidden" />
              </label>
            )}
          </div>

          {/* Brand Colors */}
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3">Brand Colors</label>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              {[
                { key: 'primary_color',   label: 'Primary',   hint: 'Buttons & links' },
                { key: 'secondary_color', label: 'Secondary', hint: 'Hover states' },
                { key: 'accent_color',    label: 'Accent',    hint: 'Success & badges' },
              ].map(({ key, label, hint }) => (
                <div key={key} className="flex items-center gap-3 p-3 border border-gray-200 rounded-xl bg-gray-50">
                  <div className="relative">
                    <input type="color" value={branding[key]}
                      onChange={e => setBranding({ ...branding, [key]: e.target.value })}
                      className="w-10 h-10 rounded-lg cursor-pointer border-0 p-0.5 bg-transparent" />
                    <div className="absolute inset-0 rounded-lg border-2 border-white shadow-sm pointer-events-none" style={{ background: branding[key] }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-700">{label}</p>
                    <input type="text" value={branding[key]}
                      onChange={e => setBranding({ ...branding, [key]: e.target.value })}
                      className="w-full text-xs font-mono text-gray-600 bg-transparent border-0 p-0 focus:outline-none focus:text-indigo-700" />
                    <p className="text-xs text-gray-400">{hint}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Live Preview */}
          <div className="rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 bg-gray-100 border-b border-gray-200">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Live Preview</p>
            </div>
            <div className="p-5 bg-white flex items-center justify-between flex-wrap gap-4">
              <div className="flex items-center gap-3">
                {logoPreview && <img src={logoPreview} alt="" className="w-10 h-10 object-contain rounded-lg border border-gray-100" />}
                <div>
                  <p className="font-bold text-lg leading-none" style={{ color: branding.primary_color }}>{branding.company_name || 'myRMA'}</p>
                  <p className="text-xs text-gray-400 mt-0.5">RMA Management</p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <button style={{ background: branding.primary_color }} className="px-3 py-1.5 text-white text-sm rounded-lg font-medium">Primary</button>
                <button style={{ background: branding.secondary_color }} className="px-3 py-1.5 text-white text-sm rounded-lg font-medium">Secondary</button>
                <button style={{ background: branding.accent_color }} className="px-3 py-1.5 text-white text-sm rounded-lg font-medium">Accent</button>
              </div>
            </div>
          </div>

          <div className="pt-2">
            <button onClick={onSave} disabled={saving}
              className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-xl hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-sm">
              {saving
                ? <><div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />Saving...</>
                : <><svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7"/></svg>Save Branding</>
              }
            </button>
          </div>
        </div>
      </BCard>

      {/* ── Display & Layout ── */}
      <BCard title="Display & Layout" desc="Theme, sidebar, fonts and table density — apply instantly"
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1V5zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zm10 0a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/></svg>}
      >
        <BRow label="Dark Mode" desc="Switch the entire app to a dark theme">
          <BToggle checked={darkMode} onChange={v => update({ darkMode: v })} />
        </BRow>
        <BRow label="Compact Sidebar" desc="Icons-only sidebar — hover to see labels">
          <BToggle checked={sidebarCompact} onChange={v => update({ sidebarCompact: v })} />
        </BRow>

        <div className="py-4 border-b border-gray-100">
          <p className="text-sm font-medium text-gray-900 mb-1">Font Family</p>
          <p className="text-xs text-gray-500 mb-3">Applied globally across all pages</p>
          <div className="flex flex-wrap gap-2">
            {FONTS.map(f => (
              <button key={f.value} type="button" onClick={() => update({ fontFamily: f.value })}
                style={{ fontFamily: f.value === 'system' ? 'system-ui' : f.label }}
                className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${fontFamily === f.value ? 'border-indigo-600 bg-indigo-50 text-indigo-700 shadow-sm' : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}>
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
              { id: 'spacious',     label: 'Spacious',     desc: 'More breathing room' },
              { id: 'comfortable', label: 'Comfortable',  desc: 'Balanced (default)' },
              { id: 'compact',     label: 'Compact',      desc: 'More rows visible' },
            ].map(d => (
              <button key={d.id} type="button" onClick={() => update({ tableDensity: d.id })}
                className={`px-3 py-3 rounded-xl border text-sm font-medium transition-all text-left ${tableDensity === d.id ? 'border-indigo-600 bg-indigo-50 text-indigo-700 shadow-sm' : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'}`}>
                <span className="block font-semibold">{d.label}</span>
                <span className="block text-xs opacity-70 mt-0.5">{d.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <BRow label="Sidebar Position" desc="Coming soon — left or right sidebar" border={false}>
          <span className="text-xs px-2 py-1 bg-gray-100 text-gray-400 rounded-full font-medium">Soon</span>
        </BRow>
      </BCard>

      {/* ── Regional & Formatting ── */}
      <BCard title="Regional & Formatting" desc="Date and time display format"
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 pt-2">
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Date Format</label>
            <select value={dateFormat} onChange={e => update({ dateFormat: e.target.value })}
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none bg-white">
              {DATE_FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Time Format</label>
            <div className="flex gap-2">
              {[{ v: '24h', label: '24-hour (14:30)' }, { v: '12h', label: '12-hour (2:30 PM)' }].map(t => (
                <BChip key={t.v} active={timeFormat === t.v} onClick={() => update({ timeFormat: t.v })}>{t.label}</BChip>
              ))}
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-6 px-4 py-3 bg-indigo-50 rounded-xl border border-indigo-100">
          <svg className="w-4 h-4 text-indigo-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
          <div className="flex gap-6 text-sm">
            <span><span className="text-indigo-500 font-medium">Date: </span><span className="font-mono font-semibold text-gray-800">{fmtDate()}</span></span>
            <span><span className="text-indigo-500 font-medium">Time: </span><span className="font-mono font-semibold text-gray-800">{fmtTime()}</span></span>
          </div>
        </div>
      </BCard>

      {/* ── Browser & Login ── */}
      <BCard title="Browser & Login" desc="Tab title, favicon and login page styling"
        icon={<svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9"/></svg>}
      >
        {/* Tab Title */}
        <div className="py-4 border-b border-gray-100">
          <p className="text-sm font-medium text-gray-900 mb-1">Browser Tab Title</p>
          <p className="text-xs text-gray-500 mb-3">Text shown in the browser tab — updates instantly</p>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg border border-gray-200 flex-1">
              <div className="flex gap-1">
                <div className="w-2.5 h-2.5 rounded-full bg-red-400" />
                <div className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
                <div className="w-2.5 h-2.5 rounded-full bg-green-400" />
              </div>
              <div className="flex-1 bg-white rounded px-2 py-0.5 text-xs text-gray-600 font-medium truncate border border-gray-200">
                {draftTabTitle || 'myRMA'} ×
              </div>
            </div>
          </div>
          <input type="text" value={draftTabTitle}
            onChange={e => setDraftTabTitle(e.target.value)}
            onBlur={() => update({ tabTitle: draftTabTitle })}
            className="mt-2 w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
            placeholder="myRMA 2.0 - RMA Management" />
        </div>

        {/* Favicon */}
        <div className="py-4 border-b border-gray-100">
          <p className="text-sm font-medium text-gray-900 mb-1">Browser Favicon</p>
          <p className="text-xs text-gray-500 mb-3">Icon shown in the browser tab · PNG, ICO, SVG · Max 1MB · Recommended: 32×32 or 64×64 px</p>

          {/* Browser tab preview */}
          <div className="flex items-center gap-2 px-3 py-2 bg-gray-100 rounded-lg border border-gray-200 mb-4 max-w-xs">
            <div className="flex gap-1 flex-shrink-0">
              <div className="w-2 h-2 rounded-full bg-red-400" />
              <div className="w-2 h-2 rounded-full bg-yellow-400" />
              <div className="w-2 h-2 rounded-full bg-green-400" />
            </div>
            <div className="flex-1 bg-white rounded px-2 py-1 flex items-center gap-1.5 border border-gray-200 min-w-0">
              {faviconUrl
                ? <img src={faviconUrl} alt="" style={{ width: 14, height: 14, objectFit: 'contain', flexShrink: 0 }} />
                : <div className="w-3.5 h-3.5 rounded-sm bg-gray-200 flex-shrink-0" />
              }
              <span className="text-xs text-gray-600 truncate">{draftTabTitle || 'myRMA'}</span>
              <span className="text-gray-300 ml-auto text-xs flex-shrink-0">×</span>
            </div>
          </div>

          <div className="flex items-start gap-4">
            {/* Favicon preview box — no forced fixed size on the img itself */}
            <div className={`w-20 h-20 rounded-xl border-2 flex-shrink-0 flex items-center justify-center p-2 ${faviconUrl ? 'border-gray-200 bg-white shadow-sm' : 'border-dashed border-gray-200 bg-gray-50'}`}>
              {faviconUrl ? (
                <img
                  src={faviconUrl}
                  alt="favicon preview"
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
                />
              ) : (
                <svg className="w-7 h-7 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"/>
                </svg>
              )}
            </div>

            <div className="space-y-2 pt-1">
              <label className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm font-medium rounded-lg cursor-pointer transition-colors w-fit">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"/></svg>
                {faviconUrl ? 'Change Favicon' : 'Upload Favicon'}
                <input type="file" accept=".png,.ico,.jpg,.svg" onChange={handleFaviconUpload} className="hidden" />
              </label>
              {faviconUrl && (
                <button type="button" onClick={() => update({ faviconUrl: '' })}
                  className="flex items-center gap-1.5 text-sm text-red-500 hover:text-red-700 font-medium px-2">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Login Background */}
        <div className="py-4">
          <p className="text-sm font-medium text-gray-900 mb-1">Login Page Background</p>
          <p className="text-xs text-gray-500 mb-3">Hex color or CSS gradient shown on the sign-in screen</p>
          <div className="flex items-center gap-3">
            <input type="color" value={loginBg.startsWith('#') ? loginBg : '#eef2ff'}
              onChange={e => update({ loginBg: e.target.value })}
              className="w-10 h-10 rounded-lg cursor-pointer border border-gray-200 p-0.5 bg-transparent flex-shrink-0" />
            <input type="text" value={loginBg} onChange={e => update({ loginBg: e.target.value })}
              className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm font-mono focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none"
              placeholder="#eef2ff or linear-gradient(135deg,#eef2ff,#e0e7ff)" />
            <div className="w-14 h-10 rounded-lg border border-gray-200 flex-shrink-0 shadow-inner" style={{ background: loginBg }} />
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              { label: 'Indigo', value: '#eef2ff' },
              { label: 'Slate',  value: '#f1f5f9' },
              { label: 'Rose',   value: '#fff1f2' },
              { label: 'Teal',   value: '#f0fdfa' },
              { label: 'Gradient', value: 'linear-gradient(135deg,#eef2ff,#fce7f3)' },
              { label: 'Dark',   value: 'linear-gradient(135deg,#1e1b4b,#312e81)' },
            ].map(p => (
              <button key={p.label} type="button" onClick={() => update({ loginBg: p.value })}
                className="flex items-center gap-1.5 px-3 py-1 border border-gray-200 rounded-lg text-xs font-medium text-gray-600 hover:border-indigo-300 hover:bg-indigo-50 transition-colors">
                <span className="w-3 h-3 rounded-full border border-gray-200 flex-shrink-0" style={{ background: p.value }} />
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </BCard>

      <p className="text-xs text-gray-400 text-center pb-2">
        Display settings apply immediately for all users · Branding requires Save
      </p>
    </div>
  )
}

function EmailSettingsTab({ settings, setSettings, saving, onSave }) {
  const [showApiKey, setShowApiKey] = useState(false)

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Email Service Configuration</h3>
        <p className="text-sm text-gray-600">Configure your email service provider to send notifications</p>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex gap-3">
          <svg className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="text-sm font-medium text-blue-900">Get your Resend API Key</p>
            <p className="text-xs text-blue-700 mt-1">
              1. Sign up at <a href="https://resend.com" target="_blank" rel="noopener noreferrer" className="underline">resend.com</a><br/>
              2. Go to API Keys<br/>
              3. Create a new API key<br/>
              4. Copy and paste it below
            </p>
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Email Provider</label>
        <select
          value={settings.provider}
          onChange={(e) => setSettings({ ...settings, provider: e.target.value })}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
        >
          <option value="resend">Resend</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Resend API Key *</label>
        <div className="relative">
          <input
            type={showApiKey ? "text" : "password"}
            value={settings.api_key}
            onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
            className="w-full px-4 py-2 pr-12 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent font-mono"
            placeholder="re_xxxxxxxxxxxxxxxxxxxx"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
          >
            {showApiKey ? '🙈' : '👁️'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-1">Your API key is stored securely and never exposed to the frontend</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">From Email *</label>
          <input
            type="email"
            value={settings.from_email}
            onChange={(e) => setSettings({ ...settings, from_email: e.target.value })}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            placeholder="noreply@yourdomain.com"
          />
          <p className="text-xs text-gray-500 mt-1">Use a verified domain in Resend</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">From Name</label>
          <input
            type="text"
            value={settings.from_name}
            onChange={(e) => setSettings({ ...settings, from_name: e.target.value })}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            placeholder="myRMA System"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 p-4 border border-gray-200 rounded-lg">
        <input
          type="checkbox"
          id="is_active"
          checked={settings.is_active}
          onChange={(e) => setSettings({ ...settings, is_active: e.target.checked })}
          className="w-5 h-5 text-indigo-600 rounded focus:ring-2 focus:ring-indigo-600"
        />
        <label htmlFor="is_active" className="flex-1 cursor-pointer">
          <p className="font-medium text-gray-900">Enable Email Notifications</p>
          <p className="text-sm text-gray-600">Start sending automated email notifications</p>
        </label>
      </div>

      <div className="flex justify-end pt-6 border-t">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {saving ? (
            <>
              <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full"></div>
              Saving...
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Save Settings
            </>
          )}
        </button>
      </div>
    </div>
  )
}

function NotificationsTab({ preferences, setPreferences, saving, onSave }) {
  const notifications = [
    { key: 'ticket_created', label: 'Ticket Created', description: 'Notify when a new RMA ticket is created' },
    { key: 'ticket_assigned', label: 'Ticket Assigned', description: 'Notify when a ticket is assigned to you' },
    { key: 'ticket_status_changed', label: 'Status Changed', description: 'Notify when ticket status is updated' },
    { key: 'ticket_priority_changed', label: 'Priority Changed', description: 'Notify when ticket priority is updated' },
    { key: 'comment_added', label: 'Comment Added', description: 'Notify when someone comments on your tickets' },
    { key: 'ticket_due_soon', label: 'Ticket Due Soon', description: 'Notify 24 hours before ticket due date' },
    { key: 'ticket_overdue', label: 'Ticket Overdue', description: 'Notify when a ticket becomes overdue' },
    { key: 'daily_summary', label: 'Daily Summary', description: 'Receive daily summary of your tickets' }
  ]

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Email Notification Preferences</h3>
        <p className="text-sm text-gray-600">Choose which email notifications you want to receive</p>
      </div>

      <div className="space-y-4">
        {notifications.map((notif) => (
          <label key={notif.key} className="flex items-start gap-4 p-4 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer">
            <input
              type="checkbox"
              checked={preferences[notif.key]}
              onChange={(e) => setPreferences({ ...preferences, [notif.key]: e.target.checked })}
              className="w-5 h-5 text-indigo-600 rounded focus:ring-2 focus:ring-indigo-600 mt-1"
            />
            <div className="flex-1">
              <p className="font-medium text-gray-900">{notif.label}</p>
              <p className="text-sm text-gray-600">{notif.description}</p>
            </div>
          </label>
        ))}
      </div>

      <div className="flex justify-end pt-6 border-t">
        <button
          onClick={onSave}
          disabled={saving}
          className="px-6 py-3 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
        >
          {saving ? (
            <>
              <div className="animate-spin w-5 h-5 border-2 border-white border-t-transparent rounded-full"></div>
              Saving...
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Save Preferences
            </>
          )}
        </button>
      </div>
    </div>
  )
}

function TemplatesTab({ templates, onEdit, onSendTest }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Email Templates</h3>
        <p className="text-sm text-gray-600">Customize email notification templates</p>
      </div>

      <div className="space-y-4">
        {templates.map((template) => (
          <div key={template.id} className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h4 className="font-medium text-gray-900">{template.template_name.replace(/_/g, ' ').toUpperCase()}</h4>
                <p className="text-sm text-gray-600 mt-1">Subject: {template.template_subject}</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {template.variables && template.variables.map((variable) => (
                    <span key={variable} className="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded">
                      {`{{${variable}}}`}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex gap-2 ml-4">
                <button
                  onClick={() => onEdit(template)}
                  className="px-3 py-1 text-sm bg-indigo-100 text-indigo-700 rounded hover:bg-indigo-200"
                >
                  Edit
                </button>
                <button
                  onClick={() => onSendTest(template.template_name)}
                  className="px-3 py-1 text-sm bg-green-100 text-green-700 rounded hover:bg-green-200"
                >
                  Test
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function TemplateModal({ template, onTemplateChange, saving, onSave, onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl p-6 m-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Edit Email Template</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600"
          >
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Template Name</label>
            <input
              type="text"
              value={template.template_name}
              disabled
              className="w-full px-4 py-2 border border-gray-300 rounded-lg bg-gray-50"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Email Subject</label>
            <input
              type="text"
              value={template.template_subject}
              onChange={(e) => onTemplateChange({ ...template, template_subject: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Email Body</label>
            <textarea
              value={template.template_body}
              onChange={(e) => onTemplateChange({ ...template, template_body: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent font-mono text-sm"
              rows="15"
            />
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h4 className="font-medium text-blue-900 mb-2">Available Variables:</h4>
            <div className="flex flex-wrap gap-2">
              {template.variables && template.variables.map((variable) => (
                <code key={variable} className="px-2 py-1 bg-white text-blue-700 text-xs rounded border border-blue-200">
                  {`{{${variable}}}`}
                </code>
              ))}
            </div>
            <p className="text-xs text-blue-700 mt-2">Use these variables in your subject and body. They will be replaced with actual values when sending emails.</p>
          </div>

          <div className="flex gap-3 pt-6 border-t">
            <button
              onClick={onClose}
              className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={onSave}
              disabled={saving}
              className="flex-1 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving...' : 'Save Template'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}