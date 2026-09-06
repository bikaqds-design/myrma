import { useTranslation } from 'react-i18next'
import { canDo } from '../lib/permissions'
import { useURLTab } from '../hooks/useURLTab'
import UserManagement from './UserManagement'
import BrandingSettings from './BrandingSettings'
import BackupRestore from './BackupRestore'
import Announcements from './cp/Announcements'
import KnowledgeBase from './cp/KnowledgeBase'
import AuditLog from './cp/AuditLog'
import RMAConfig from './cp/RMAConfig'
import DataCleanup from './cp/DataCleanup'
import Integrations from './cp/Integrations'
import CustomFields from './cp/CustomFields'
import PDFLayout from './cp/PDFLayout'
import SystemSetup from './cp/SystemSetup'
import WASettings from './cp/WASettings'
import WATemplates from './cp/WATemplates'
import WALogs from './cp/WALogs'
import WATestCenter from './cp/WATestCenter'
import SendAlert from './cp/SendAlert'
import HomeView from './cp/HomeView'
import PipelineStages from './cp/PipelineStages'
import SLAPolicies from './cp/SLAPolicies'
import AutomationRules from './cp/AutomationRules'
import { ALL_FEATURES } from './cp/_registry'

export default function ControlPanel({ currentUserRole, currentUserEmail, currentUserPermissions, onStartPreview }) {
  const { t } = useTranslation()
  const [section, setSection] = useURLTab('section', null, true)

  if (currentUserRole !== 'admin' && currentUserRole !== 'super_admin') {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <svg
            className="w-16 h-16 text-gray-300 mx-auto mb-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
            />
          </svg>
          <h2 className="text-xl font-semibold text-gray-700 dark:text-[#e8ebf0]">{t('cp.accessRestricted')}</h2>
          <p className="text-gray-500 dark:text-[#9aa4b2] mt-1">{t('cp.accessRestrictedDesc')}</p>
        </div>
      </div>
    )
  }

  const activeFeature = section ? ALL_FEATURES.find((f) => f.id === section) : null

  return (
    <div className="space-y-6">
      {/* Header */}
      {section ? (
        <div className="flex items-center gap-3">
          <button
            onClick={() => setSection(null)}
            className="flex items-center gap-1.5 text-sm text-indigo-600 hover:text-indigo-800 font-medium"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            {t('cp.title')}
          </button>
          <svg
            className="w-4 h-4 text-gray-300"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          {/* An h1, not a span. Opening any of the twenty features replaced the
              page heading with a breadcrumb crumb, so every feature view had no
              h1 at all and the first heading on the page was an h3 nested inside
              a card. Styled to look exactly as it did. */}
          <h1 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{activeFeature?.labelKey ? t(activeFeature.labelKey) : activeFeature?.label}</h1>
        </div>
      ) : (
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-[#e8ebf0]">{t('cp.title')}</h1>
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2] mt-0.5">{t('cp.subtitle')}</p>
        </div>
      )}

      {/* Home view */}
      {!section && <HomeView onNavigate={setSection} currentUserEmail={currentUserEmail} />}

      {/* Feature content */}
      {section === 'users' && (
        <UserManagement
          currentUserRole={currentUserRole}
          currentUserEmail={currentUserEmail}
          currentUserPermissions={currentUserPermissions}
          onPreviewUser={onStartPreview}
        />
      )}
      {section === 'appearance' && (
        <BrandingSettings
          key="appearance"
          currentUserRole={currentUserRole}
          currentUserEmail={currentUserEmail}
          initialTab="branding"
          visibleTabs={['branding']}
        />
      )}
      {section === 'email' && (
        <BrandingSettings
          key="email"
          currentUserRole={currentUserRole}
          currentUserEmail={currentUserEmail}
          initialTab="email-settings"
          visibleTabs={['email-settings', 'notifications', 'templates']}
        />
      )}
      {section === 'backup' && (
        <BackupRestore currentUserRole={currentUserRole} currentUserEmail={currentUserEmail} />
      )}
      {section === 'announcements' && <Announcements currentUserEmail={currentUserEmail} />}
      {section === 'kb' && <KnowledgeBase currentUserEmail={currentUserEmail} />}
      {section === 'broadcast' && <SendAlert currentUserEmail={currentUserEmail} />}
      {section === 'audit' && <AuditLog />}
      {/* The only Control Panel feature with its own permission. The page is
          already admin-gated above, so this changes nothing today — it gives
          the model a word for "may reshape the pipelines", which is a heavier
          action than the rest of the console and worth being able to delegate
          (or withhold) on its own later. */}
      {section === 'pipelines' &&
        (canDo(currentUserRole, currentUserPermissions, 'pipelines', 'manage') ? (
          <PipelineStages currentUserEmail={currentUserEmail} />
        ) : (
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">{t('cp.accessRestrictedDesc')}</p>
        ))}
      {section === 'rmaconfig' && <RMAConfig currentUserEmail={currentUserEmail} />}
      {section === 'cleanup' && <DataCleanup />}
      {section === 'integrations' && <Integrations currentUserEmail={currentUserEmail} />}
      {section === 'customfields' && <CustomFields currentUserEmail={currentUserEmail} />}
      {section === 'pdflayout' && <PDFLayout currentUserEmail={currentUserEmail} />}
      {section === 'system-setup' && <SystemSetup currentUserEmail={currentUserEmail} />}
      {section === 'sla' && <SLAPolicies currentUserEmail={currentUserEmail} />}
      {section === 'automation' && <AutomationRules currentUserEmail={currentUserEmail} />}
      {section === 'wa-settings' && <WASettings currentUserEmail={currentUserEmail} />}
      {section === 'wa-templates' && <WATemplates currentUserEmail={currentUserEmail} />}
      {section === 'wa-logs' && <WALogs currentUserEmail={currentUserEmail} />}
      {section === 'wa-test' && <WATestCenter currentUserEmail={currentUserEmail} />}
    </div>
  )
}
