import { useState, useEffect } from 'react'
import { branding as brandingAPI, notifications as notificationsAPI } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../../lib/sentry'
import { useTranslation } from 'react-i18next'
import BrandingTab from './BrandingTab'
import EmailSettingsTab from './EmailSettingsTab'
import NotificationsTab from './NotificationsTab'
import TemplatesTab from './TemplatesTab'
import TemplateModal from './TemplateModal'

export default function BrandingSettings({
  currentUserRole,
  currentUserEmail,
  initialTab,
  visibleTabs,
}) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState(initialTab || 'branding')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Branding state
  const [branding, setBranding] = useState({
    company_name: 'myCRM',
    logo_url: null,
    primary_color: '#4F46E5',
    secondary_color: '#818CF8',
    accent_color: '#10B981',
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
    daily_summary: false,
  })
  const [emailTemplates, setEmailTemplates] = useState([])
  const [selectedTemplate, setSelectedTemplate] = useState(null)
  const [showTemplateModal, setShowTemplateModal] = useState(false)

  // Email settings state
  const [emailSettings, setEmailSettings] = useState({
    provider: 'resend',
    api_key: '',
    from_email: 'noreply@yourdomain.com',
    from_name: 'myCRM System',
    is_active: false,
  })

  useEffect(() => {
    loadData()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadData = async () => {
    try {
      const [brandingData, prefsData, templatesData] = await Promise.all([
        brandingAPI.getBranding(),
        notificationsAPI.getPreferences(currentUserEmail),
        notificationsAPI.getTemplates(),
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
        captureException(error)
      }
    } catch (error) {
      captureException(error)
      toast.error(t('brandingSettings.failedLoad'))
    } finally {
      setLoading(false)
    }
  }

  const handleLogoChange = (e) => {
    const file = e.target.files[0]
    if (file) {
      if (!file.type.startsWith('image/')) {
        toast.error(t('brandingSettings.selectImageFile'))
        return
      }

      if (file.size > 2 * 1024 * 1024) {
        toast.error(t('brandingSettings.logoTooLarge'))
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
      const updates = {
        company_name: branding.company_name,
        primary_color: branding.primary_color,
        secondary_color: branding.secondary_color,
        accent_color: branding.accent_color,
      }

      if (logoFile) {
        const logoUrl = await brandingAPI.uploadLogo(logoFile)
        updates.logo_url = logoUrl
      } else {
        updates.logo_url = branding.logo_url
      }

      await brandingAPI.updateBranding(updates, currentUserEmail)

      toast.success(t('brandingSettings.brandingSaved'))
      loadData()
      setLogoFile(null)

      applyBrandingToApp(updates)
    } catch (error) {
      captureException(error)
      toast.error(t('brandingSettings.failedSaveBranding'))
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
      toast.success(t('brandingSettings.notifPrefsSaved'))
    } catch (error) {
      captureException(error)
      toast.error(t('brandingSettings.failedSaveNotifPrefs'))
    } finally {
      setSaving(false)
    }
  }

  const handleSaveEmailSettings = async () => {
    setSaving(true)
    try {
      await notificationsAPI.updateEmailSettings(emailSettings, currentUserEmail)
      toast.success(t('brandingSettings.emailSettingsSaved'))
      loadData()
    } catch (error) {
      captureException(error)
      toast.error(t('brandingSettings.failedSaveEmailSettings'))
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
          template_body: selectedTemplate.template_body,
        },
        currentUserEmail
      )
      toast.success(t('brandingSettings.templateUpdated'))
      setShowTemplateModal(false)
      loadData()
    } catch (error) {
      captureException(error)
      toast.error(t('brandingSettings.failedSaveTemplate'))
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
        days_overdue: '3',
      }

      await notificationsAPI.sendTestEmail(currentUserEmail, templateName, testVariables)
      toast.success(t('brandingSettings.testEmailSent'))
    } catch (error) {
      captureException(error)
      toast.error(t('brandingSettings.failedSendTestEmail'))
    }
  }

  if (currentUserRole !== 'admin' && currentUserRole !== 'super_admin') {
    return (
      <div className="text-center py-12">
        <svg
          className="w-16 h-16 text-red-600 mx-auto mb-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">{t('brandingSettings.accessDenied')}</h2>
        <p className="text-gray-600">{t('brandingSettings.adminOnly')}</p>
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
  const pageDesc = isAppearanceOnly
    ? 'Customize the look and feel of your application'
    : 'Configure email delivery, notification preferences and templates'

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
              <button
                onClick={() => setActiveTab('branding')}
                className={
                  'py-4 border-b-2 font-medium transition-colors ' +
                  (activeTab === 'branding'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700')
                }
              >
                Branding
              </button>
            )}
            {(!visibleTabs || visibleTabs.includes('email-settings')) && (
              <button
                onClick={() => setActiveTab('email-settings')}
                className={
                  'py-4 border-b-2 font-medium transition-colors ' +
                  (activeTab === 'email-settings'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700')
                }
              >
                Email Settings
              </button>
            )}
            {(!visibleTabs || visibleTabs.includes('notifications')) && (
              <button
                onClick={() => setActiveTab('notifications')}
                className={
                  'py-4 border-b-2 font-medium transition-colors ' +
                  (activeTab === 'notifications'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700')
                }
              >
                Notifications
              </button>
            )}
            {(!visibleTabs || visibleTabs.includes('templates')) && (
              <button
                onClick={() => setActiveTab('templates')}
                className={
                  'py-4 border-b-2 font-medium transition-colors ' +
                  (activeTab === 'templates'
                    ? 'border-indigo-600 text-indigo-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700')
                }
              >
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
