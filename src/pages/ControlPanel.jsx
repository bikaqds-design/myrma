import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useURLTab } from '../hooks/useURLTab'
import { db } from '../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../lib/sentry'
import { TICKET_STATUS } from '../lib/constants'
import { Spinner } from '../components/ui'
import UserManagement from './UserManagement'
import BrandingSettings from './BrandingSettings'
import BackupRestore from './BackupRestore'
import Announcements from './cp/Announcements'
import AuditLog from './cp/AuditLog'
import RMAConfig from './cp/RMAConfig'
import DataCleanup from './cp/DataCleanup'
import Integrations from './cp/Integrations'
import CustomFields from './cp/CustomFields'
import PDFLayout from './cp/PDFLayout'
import WASettings from './cp/WASettings'
import WATemplates from './cp/WATemplates'
import WALogs from './cp/WALogs'
import WATestCenter from './cp/WATestCenter'

// ─── Feature registry ──────────────────────────────────────────────────────

const GROUPS = [
  {
    id: 'tickets',
    label: 'Ticket Management',
    labelKey: 'cp.groupTickets',
    color: 'indigo',
    features: [
      {
        id: 'rmaconfig',
        label: 'RMA Configuration',
        labelKey: 'cp.rmaConfigLabel',
        desc: 'SLA rules, auto-assignment and ticket defaults',
        descKey: 'cp.rmaConfigDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
            />
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
            />
          </svg>
        ),
      },
      {
        id: 'customfields',
        label: 'Custom Fields',
        labelKey: 'cp.customFieldsLabel',
        desc: 'Add extra fields to tickets and customers',
        descKey: 'cp.customFieldsDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 5a1 1 0 011-1h14a1 1 0 011 1v2a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM4 13a1 1 0 011-1h6a1 1 0 011 1v6a1 1 0 01-1 1H5a1 1 0 01-1-1v-6zM16 13a1 1 0 011-1h2a1 1 0 011 1v6a1 1 0 01-1 1h-2a1 1 0 01-1-1v-6z"
            />
          </svg>
        ),
      },
      {
        id: 'pdflayout',
        label: 'PDF Layout',
        labelKey: 'cp.pdfLayoutLabel',
        desc: 'Customize the ticket print and export template',
        descKey: 'cp.pdfLayoutDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
            />
          </svg>
        ),
      },
    ],
  },
  {
    id: 'users',
    label: 'Users & Communication',
    labelKey: 'cp.groupUsers',
    color: 'emerald',
    features: [
      {
        id: 'users',
        label: 'User Management',
        labelKey: 'cp.userMgmtLabel',
        desc: 'Manage accounts, roles and permissions',
        descKey: 'cp.userMgmtDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"
            />
          </svg>
        ),
      },
      {
        id: 'announcements',
        label: 'Announcements',
        labelKey: 'cp.announcementsLabel',
        desc: 'Post system-wide banners visible to all users',
        descKey: 'cp.announcementsDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 5.882V19.24a1.76 1.76 0 01-3.417.592l-2.147-6.15M18 13a3 3 0 100-6M5.436 13.683A4.001 4.001 0 017 6h1.832c4.1 0 7.625-1.234 9.168-3v14c-1.543-1.766-5.067-3-9.168-3H7a3.988 3.988 0 01-1.564-.317z"
            />
          </svg>
        ),
      },
      {
        id: 'broadcast',
        label: 'Send Alert',
        labelKey: 'cp.sendAlertLabel',
        desc: 'Send instant in-app notifications to users or groups',
        descKey: 'cp.sendAlertDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9"
            />
          </svg>
        ),
      },
    ],
  },
  {
    id: 'appearance',
    label: 'Appearance & Notifications',
    labelKey: 'cp.groupAppearance',
    color: 'purple',
    features: [
      {
        id: 'appearance',
        label: 'Appearance',
        labelKey: 'cp.appearanceLabel',
        desc: 'Logo, colors, dark mode, fonts, sidebar style',
        descKey: 'cp.appearanceDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"
            />
          </svg>
        ),
      },
      {
        id: 'email',
        label: 'Email & Notifications',
        labelKey: 'cp.emailNotifLabel',
        desc: 'Email provider, templates and preferences',
        descKey: 'cp.emailNotifDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
            />
          </svg>
        ),
      },
    ],
  },
  {
    id: 'automation',
    label: 'Automation & Integration',
    labelKey: 'cp.groupAutomation',
    color: 'rose',
    features: [
      {
        id: 'sla',
        label: 'SLA Policies',
        labelKey: 'cp.slaPoliciesLabel',
        desc: 'Auto-set due dates per priority; track breach rates',
        descKey: 'cp.slaPoliciesDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        ),
      },
      {
        id: 'automation',
        label: 'Automation Rules',
        labelKey: 'cp.automationRulesLabel',
        desc: 'Trigger actions automatically when ticket events occur',
        descKey: 'cp.automationRulesDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
        ),
      },
      {
        id: 'webhooks',
        label: 'Outbound Webhooks',
        labelKey: 'cp.webhooksLabel',
        desc: 'Push ticket events to Slack, QuickBooks, and other services',
        descKey: 'cp.webhooksDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
        ),
      },
      {
        id: 'integrations',
        label: 'Email & API',
        labelKey: 'cp.emailApiLabel',
        desc: 'Configure outbound email and external connections',
        descKey: 'cp.emailApiDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
            />
          </svg>
        ),
      },
    ],
  },
  {
    id: 'messaging',
    label: 'WhatsApp & Messaging',
    labelKey: 'cp.groupMessaging',
    color: 'teal',
    features: [
      {
        id: 'wa-settings',
        label: 'Notification Settings',
        labelKey: 'cp.notifSettingsLabel',
        desc: 'Enable providers, per-event toggles, retry and rate-limit config',
        descKey: 'cp.notifSettingsDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
          </svg>
        ),
      },
      {
        id: 'wa-templates',
        label: 'Message Templates',
        labelKey: 'cp.msgTemplatesLabel',
        desc: 'Create, edit and preview WhatsApp message templates with variables',
        descKey: 'cp.msgTemplatesDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-3 3v-3z" />
          </svg>
        ),
      },
      {
        id: 'wa-logs',
        label: 'Notification Logs',
        labelKey: 'cp.notifLogsLabel',
        desc: 'View sent/failed messages, delivery status, retry failed notifications',
        descKey: 'cp.notifLogsDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
        ),
      },
      {
        id: 'wa-test',
        label: 'Test Center',
        labelKey: 'cp.testCenterLabel',
        desc: 'Send test messages, simulate events, run the queue worker manually',
        descKey: 'cp.testCenterDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        ),
      },
    ],
  },
  {
    id: 'data',
    label: 'Data & System',
    labelKey: 'cp.groupData',
    color: 'amber',
    features: [
      {
        id: 'audit',
        label: 'Audit Log',
        labelKey: 'cp.auditLogLabel',
        desc: 'Full trail of all user activity across the system',
        descKey: 'cp.auditLogDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
            />
          </svg>
        ),
      },
      {
        id: 'cleanup',
        label: 'Data Cleanup',
        labelKey: 'cp.dataCleanupLabel',
        desc: 'Remove stale records and identify data quality issues',
        descKey: 'cp.dataCleanupDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
            />
          </svg>
        ),
      },
      {
        id: 'backup',
        label: 'Backup & Restore',
        labelKey: 'cp.backupRestoreLabel',
        desc: 'Export all data and restore from backup files',
        descKey: 'cp.backupRestoreDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
            />
          </svg>
        ),
      },
    ],
  },
]

const ALL_FEATURES = GROUPS.flatMap((g) => g.features)
const COLOR_MAP = {
  indigo: {
    bg: 'bg-indigo-50',
    border: 'border-indigo-100',
    icon: 'bg-indigo-100 text-indigo-600',
    label: 'text-indigo-900',
    hover: 'hover:border-indigo-300 hover:bg-indigo-50/80',
  },
  emerald: {
    bg: 'bg-emerald-50',
    border: 'border-emerald-100',
    icon: 'bg-emerald-100 text-emerald-600',
    label: 'text-emerald-900',
    hover: 'hover:border-emerald-300 hover:bg-emerald-50/80',
  },
  purple: {
    bg: 'bg-purple-50',
    border: 'border-purple-100',
    icon: 'bg-purple-100 text-purple-600',
    label: 'text-purple-900',
    hover: 'hover:border-purple-300 hover:bg-purple-50/80',
  },
  amber: {
    bg: 'bg-amber-50',
    border: 'border-amber-100',
    icon: 'bg-amber-100 text-amber-600',
    label: 'text-amber-900',
    hover: 'hover:border-amber-300 hover:bg-amber-50/80',
  },
  rose: {
    bg: 'bg-rose-50',
    border: 'border-rose-100',
    icon: 'bg-rose-100 text-rose-600',
    label: 'text-rose-900',
    hover: 'hover:border-rose-300 hover:bg-rose-50/80',
  },
  teal: {
    bg: 'bg-teal-50',
    border: 'border-teal-100',
    icon: 'bg-teal-100 text-teal-600',
    label: 'text-teal-900',
    hover: 'hover:border-teal-300 hover:bg-teal-50/80',
  },
}

export default function ControlPanel({ currentUserRole, currentUserEmail }) {
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
          <span className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{activeFeature?.labelKey ? t(activeFeature.labelKey) : activeFeature?.label}</span>
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
        <UserManagement currentUserRole={currentUserRole} currentUserEmail={currentUserEmail} />
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
      {section === 'broadcast' && <SendAlert currentUserEmail={currentUserEmail} />}
      {section === 'audit' && <AuditLog />}
      {section === 'rmaconfig' && <RMAConfig currentUserEmail={currentUserEmail} />}
      {section === 'cleanup' && <DataCleanup />}
      {section === 'integrations' && <Integrations currentUserEmail={currentUserEmail} />}
      {section === 'customfields' && <CustomFields currentUserEmail={currentUserEmail} />}
      {section === 'pdflayout' && <PDFLayout currentUserEmail={currentUserEmail} />}
      {section === 'sla' && <SLAPolicies currentUserEmail={currentUserEmail} />}
      {section === 'automation' && <AutomationRules currentUserEmail={currentUserEmail} />}
      {section === 'webhooks' && <WebhooksConfig currentUserEmail={currentUserEmail} />}
      {section === 'wa-settings' && <WASettings currentUserEmail={currentUserEmail} />}
      {section === 'wa-templates' && <WATemplates currentUserEmail={currentUserEmail} />}
      {section === 'wa-logs' && <WALogs currentUserEmail={currentUserEmail} />}
      {section === 'wa-test' && <WATestCenter currentUserEmail={currentUserEmail} />}
    </div>
  )
}

// ─── SEND ALERT ─────────────────────────────────────────────────────────────

const ALERT_TYPES = [
  {
    value: 'system_announcement',
    label: 'Announcement',
    icon: '📢',
    desc: 'General system message',
  },
  { value: 'custom_alert', label: 'Warning', icon: '⚠️', desc: 'Important action required' },
]

const ALERT_TARGETS = [
  { value: 'all', label: 'Everyone', icon: '👥', roles: ['super_admin', 'admin', 'technician'] },
  { value: 'admins', label: 'Admins only', icon: '🔑', roles: ['super_admin', 'admin'] },
  { value: 'technicians', label: 'Technicians', icon: '🔧', roles: ['technician'] },
  { value: 'email', label: 'Specific email', icon: '✉️', roles: [] },
]

function SendAlert({ currentUserEmail }) {
  const [type, setType] = useState('system_announcement')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [target, setTarget] = useState('all')
  const [specificEmail, setSpecificEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSend = async () => {
    if (!title.trim() || !message.trim()) {
      toast.error('Title and message are required')
      return
    }
    if (target === 'email' && !specificEmail.trim()) {
      toast.error('Enter a recipient email address')
      return
    }
    setSending(true)
    try {
      const targetConfig = ALERT_TARGETS.find((t) => t.value === target)
      await db.notifications.create({
        type,
        title: title.trim(),
        message: message.trim(),
        createdBy: currentUserEmail,
        targetRoles: targetConfig.roles,
        targetEmails: target === 'email' ? [specificEmail.trim()] : [],
      })
      toast.success('Alert sent')
      db.auditLog
        .log(currentUserEmail, 'alert_sent', `Sent alert "${title.trim()}" to ${target}`)
        .catch(() => {})
      setSent(true)
      setTitle('')
      setMessage('')
      setSpecificEmail('')
      setTimeout(() => setSent(false), 3000)
    } catch (err) {
      captureException(err, { page: 'ControlPanel', context: 'sendAlert' })
      toast.error(`Failed to send: ${err.message}`)
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-6 space-y-6">
        {/* Type */}
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-3">
            Alert Type
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {ALERT_TYPES.map((t) => (
              <button
                key={t.value}
                onClick={() => setType(t.value)}
                className={`flex items-center gap-3 p-3.5 rounded-xl border-2 text-left transition-colors ${type === t.value ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 dark:border-[#212a38] hover:border-gray-300 dark:border-[#212a38] bg-white dark:bg-[#121823]'}`}
              >
                <span className="text-2xl">{t.icon}</span>
                <div>
                  <p className="text-sm font-semibold text-gray-800">{t.label}</p>
                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">{t.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Title */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
            Title <span className="text-red-500">*</span>
          </label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={100}
            className="w-full px-3 py-2.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
            placeholder="e.g. System maintenance tonight at 11pm"
          />
        </div>

        {/* Message */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
            Message <span className="text-red-500">*</span>
          </label>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            maxLength={500}
            className="w-full px-3 py-2.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent resize-none"
            placeholder="Describe the alert in detail..."
          />
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] text-right mt-1">{message.length}/500</p>
        </div>

        {/* Target */}
        <div>
          <p className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-3">
            Send To
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ALERT_TARGETS.map((t) => (
              <button
                key={t.value}
                onClick={() => setTarget(t.value)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-colors ${target === t.value ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:border-gray-300 dark:border-[#212a38] bg-white dark:bg-[#121823]'}`}
              >
                <span>{t.icon}</span>
                {t.label}
              </button>
            ))}
          </div>
          {target === 'email' && (
            <input
              value={specificEmail}
              onChange={(e) => setSpecificEmail(e.target.value)}
              type="email"
              className="w-full mt-3 px-3 py-2.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
              placeholder="recipient@example.com"
            />
          )}
        </div>

        {/* Send */}
        <div className="pt-2 border-t border-gray-100 dark:border-[#212a38]">
          <button
            onClick={handleSend}
            disabled={sending || !title.trim() || !message.trim()}
            className={`px-6 py-2.5 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-all flex items-center gap-2 ${sent ? 'bg-green-600 hover:bg-green-700' : 'bg-indigo-600 hover:bg-indigo-700'}`}
          >
            {sending ? (
              <>
                <Spinner size="sm" color="white" />
                Sending...
              </>
            ) : sent ? (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Alert Sent!
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                </svg>
                Send Alert
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── HOME VIEW ─────────────────────────────────────────────────────────────

function HomeView({ onNavigate, currentUserEmail: _currentUserEmail }) {
  const { t } = useTranslation()
  const { data: stats } = useQuery({
    queryKey: ['control-panel-stats'],
    queryFn: async () => {
      const [tickets, customers, products, users] = await Promise.all([
        db.rmaTickets.list(),
        db.customers.list(),
        db.products.list(),
        db.userRoles.listAllRoles(),
      ])
      const byStatus = tickets.reduce((a, t) => {
        a[t.ticket_status] = (a[t.ticket_status] || 0) + 1
        return a
      }, {})
      const open =
        (byStatus[TICKET_STATUS.OPEN] || 0) +
        (byStatus[TICKET_STATUS.IN_PROGRESS] || 0) +
        (byStatus[TICKET_STATUS.ON_HOLD] || 0)
      const overdue = tickets.filter(
        (t) =>
          t.due_date &&
          new Date(t.due_date) < new Date() &&
          t.ticket_status !== TICKET_STATUS.CLOSED &&
          t.ticket_status !== TICKET_STATUS.CANCELLED
      ).length
      return {
        total: tickets.length,
        open,
        overdue,
        completed: byStatus[TICKET_STATUS.CLOSED] || 0,
        customers: customers.length,
        products: products.length,
        users: users.length,
        byStatus,
      }
    },
    staleTime: 2 * 60_000,
  })

  const statCards = stats
    ? [
        { label: t('cp.statTotalTickets'), value: stats.total, sub: `${stats.open} ${t('cp.statOpen')}`, color: 'indigo' },
        {
          label: t('cp.statOverdue'),
          value: stats.overdue,
          sub: t('cp.statPastDue'),
          color: stats.overdue > 0 ? 'red' : 'green',
        },
        { label: t('cp.statCustomers'), value: stats.customers, sub: t('cp.statInDatabase'), color: 'emerald' },
        { label: t('cp.statSystemUsers'), value: stats.users, sub: t('cp.statWithAccess'), color: 'purple' },
      ]
    : []

  const colorStat = {
    indigo: 'bg-indigo-50 text-indigo-600',
    red: 'bg-red-50 text-red-600',
    green: 'bg-green-50 text-green-600',
    emerald: 'bg-emerald-50 text-emerald-600',
    purple: 'bg-purple-50 text-purple-600',
  }

  return (
    <div className="space-y-8">
      {/* Quick stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {statCards.map((c) => (
            <div key={c.label} className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-4 shadow-sm">
              <div className={`text-2xl font-bold ${colorStat[c.color].split(' ')[1]}`}>
                {c.value}
              </div>
              <div className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mt-0.5">{c.label}</div>
              <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{c.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Ticket status row */}
      {stats && (
        <div className="flex flex-wrap gap-3">
          {[
            { label: 'New', color: 'bg-pink-100 text-pink-800' },
            { label: 'In Progress', color: 'bg-blue-100 text-blue-800' },
            { label: 'On Hold', color: 'bg-yellow-100 text-yellow-800' },
            { label: 'Completed', color: 'bg-green-100 text-green-800' },
            { label: 'Cancelled', color: 'bg-gray-100 dark:bg-[#1a2230] text-gray-700 dark:text-[#e8ebf0]' },
          ].map(({ label, color }) => (
            <div
              key={label}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm ${color}`}
            >
              <span className="font-medium">{t(`statusValues.${label}`, label)}</span>
              <span className="font-bold">{stats.byStatus[label] || 0}</span>
            </div>
          ))}
        </div>
      )}

      {/* Feature groups */}
      {GROUPS.map((group) => {
        const c = COLOR_MAP[group.color]
        return (
          <div key={group.id}>
            <h2 className="text-base font-semibold text-gray-900 dark:text-[#e8ebf0] mb-3">{group.labelKey ? t(group.labelKey) : group.label}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {group.features.map((f) => (
                <button
                  key={f.id}
                  onClick={() => onNavigate(f.id)}
                  className={`group bg-white dark:bg-[#121823] border border-gray-200 dark:border-[#212a38] rounded-xl p-4 text-left transition-all hover:shadow-md ${c.hover}`}
                >
                  <div
                    className={`w-9 h-9 rounded-lg flex items-center justify-center mb-3 ${c.icon}`}
                  >
                    {f.icon}
                  </div>
                  <div className="font-semibold text-gray-900 dark:text-[#e8ebf0] text-sm group-hover:text-indigo-700">
                    {f.labelKey ? t(f.labelKey) : f.label}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1 leading-relaxed">{f.descKey ? t(f.descKey) : f.desc}</div>
                  <div className="mt-3 flex items-center gap-1 text-xs font-medium text-indigo-600 opacity-0 group-hover:opacity-100 transition-opacity">
                    {t('cp.open')}
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 5l7 7-7 7"
                      />
                    </svg>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── SLA POLICIES ───────────────────────────────────────────────────────────

const PRIORITIES = ['Critical', 'High', 'Medium', 'Low']

function SLAPolicies({ currentUserEmail }) {
  const queryClient = useQueryClient()
  const { data: config, isLoading: slaLoading } = useQuery({
    queryKey: ['sla-config'],
    queryFn: () => db.slaConfig.get(),
  })
  const [localConfig, setLocalConfig] = useState(null)
  const [saving, setSaving] = useState(false)

  // Keep local editable copy in sync with fetched config
  React.useEffect(() => {
    if (config && !localConfig) setLocalConfig(config)
  }, [config, localConfig])

  const updatePolicy = (priority, hours) => {
    setLocalConfig((prev) => ({
      ...prev,
      policies: prev.policies.map((p) =>
        p.priority === priority ? { ...p, hours: Number(hours) } : p
      ),
    }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await db.slaConfig.save(localConfig, currentUserEmail)
      queryClient.invalidateQueries({ queryKey: ['sla-config'] })
      toast.success('SLA policies saved')
      db.auditLog
        .log(currentUserEmail, 'sla_updated', 'Updated SLA policy configuration')
        .catch(() => {})
    } catch (e) {
      captureException(e, { page: 'ControlPanel', context: 'saveSLA' })
      toast.error('Failed to save: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  if (slaLoading || !localConfig)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )

  return (
    <div className="max-w-2xl space-y-6">
      <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">SLA Policies</h3>
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-0.5">
              Auto-set ticket due dates based on priority when a new ticket is created.
            </p>
          </div>
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <span className="text-sm text-gray-600 dark:text-[#9aa4b2] font-medium">Enabled</span>
            <button
              onClick={() => setLocalConfig((c) => ({ ...c, enabled: !c.enabled }))}
              className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${localConfig.enabled ? 'bg-indigo-600' : 'bg-gray-300'}`}
            >
              <span
                className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white dark:bg-[#121823] shadow transition-transform ${localConfig.enabled ? 'translate-x-4' : 'translate-x-0'}`}
              />
            </button>
          </label>
        </div>

        <div className={`space-y-3 ${!localConfig.enabled ? 'opacity-50 pointer-events-none' : ''}`}>
          {PRIORITIES.map((p) => {
            const policy = localConfig.policies?.find((pl) => pl.priority === p) || {
              priority: p,
              hours: 72,
            }
            const colors = {
              Critical: 'text-red-600',
              High: 'text-orange-600',
              Medium: 'text-yellow-600',
              Low: 'text-green-600',
            }
            return (
              <div key={p} className="flex items-center gap-4 p-3 bg-gray-50 dark:bg-[#0f1520] rounded-lg">
                <span className={`w-20 text-sm font-semibold ${colors[p]}`}>{p}</span>
                <div className="flex items-center gap-2 flex-1">
                  <input
                    type="number"
                    min={1}
                    max={8760}
                    value={policy.hours}
                    onChange={(e) => updatePolicy(p, e.target.value)}
                    className="w-24 px-3 py-1.5 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
                  />
                  <span className="text-sm text-gray-500 dark:text-[#9aa4b2]">hours</span>
                  <span className="text-xs text-gray-500 dark:text-[#9aa4b2] ml-2">
                    (
                    {policy.hours >= 24 ? `${(policy.hours / 24).toFixed(1)}d` : `${policy.hours}h`}
                    )
                  </span>
                </div>
              </div>
            )
          })}

          <div className="flex items-center gap-3 pt-2">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <button
                onClick={() => setLocalConfig((c) => ({ ...c, pauseOnHold: !c.pauseOnHold }))}
                className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${localConfig.pauseOnHold ? 'bg-indigo-600' : 'bg-gray-300'}`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white dark:bg-[#121823] shadow transition-transform ${localConfig.pauseOnHold ? 'translate-x-4' : 'translate-x-0'}`}
                />
              </button>
              <span className="text-sm text-gray-600 dark:text-[#9aa4b2]">
                Pause SLA clock when ticket is "On Hold"
              </span>
            </label>
          </div>
        </div>

        <div className="pt-3 border-t border-gray-100 dark:border-[#212a38]">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            {saving ? <Spinner size="sm" color="white" /> : null} Save Policies
          </button>
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
        <strong>How it works:</strong> When SLA is enabled, creating a new ticket will automatically
        set its due date based on the priority selected. The due date can always be overridden
        manually in the ticket form.
      </div>
    </div>
  )
}

// ─── AUTOMATION RULES ───────────────────────────────────────────────────────

const TRIGGER_OPTIONS = [
  { value: 'ticket_created', label: 'Ticket Created' },
  { value: 'ticket_updated', label: 'Ticket Updated' },
  { value: 'ticket_status_changed', label: 'Status Changed' },
  { value: 'ticket_assigned', label: 'Ticket Assigned' },
  { value: 'ticket_overdue', label: 'Ticket Overdue' },
]
const FIELD_OPTIONS = [
  { value: 'ticket_status', label: 'Status' },
  { value: 'priority', label: 'Priority' },
  { value: 'assigned_technician', label: 'Technician' },
  { value: 'customer_name', label: 'Customer Name' },
]
const OP_OPTIONS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'starts_with', label: 'starts with' },
]
const ACTION_TYPES = [
  { value: 'change_status', label: 'Change Status' },
  { value: 'change_priority', label: 'Change Priority' },
  { value: 'assign_technician', label: 'Assign Technician' },
  { value: 'create_notification', label: 'Send Notification' },
]
const STATUS_OPTIONS = ['New', 'In Progress', 'On Hold', 'Completed', 'Cancelled']
const PRIORITY_OPTIONS = ['Critical', 'High', 'Medium', 'Low']

const EMPTY_RULE = () => ({
  id: Date.now(),
  name: 'New Rule',
  enabled: true,
  trigger: 'ticket_created',
  conditions: [],
  actions: [{ type: 'change_status', value: 'In Progress' }],
})

function AutomationRules({ currentUserEmail }) {
  const queryClient = useQueryClient()
  const { data: fetchedRules } = useQuery({
    queryKey: ['automation-rules'],
    queryFn: () => db.automationRules.list(),
  })
  const [rules, setRules] = useState(null)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)

  React.useEffect(() => {
    if (fetchedRules && !rules) setRules(fetchedRules || [])
  }, [fetchedRules, rules])

  const saveAll = async (newRules) => {
    setSaving(true)
    try {
      await db.automationRules.save(newRules, currentUserEmail)
      setRules(newRules)
      queryClient.invalidateQueries({ queryKey: ['automation-rules'] })
      toast.success('Automation rules saved')
    } catch (e) {
      captureException(e, { page: 'ControlPanel', context: 'saveAutomationRules' })
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const deleteRule = (id) => saveAll(rules.filter((r) => r.id !== id))
  const toggleRule = (id) =>
    saveAll(rules.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r)))
  const saveEdit = () => {
    if (!editing.name.trim()) {
      toast.error('Rule name is required')
      return
    }
    const exists = rules.find((r) => r.id === editing.id)
    const updated = exists
      ? rules.map((r) => (r.id === editing.id ? editing : r))
      : [...rules, editing]
    saveAll(updated).then(() => setEditing(null))
  }

  if (!rules)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )

  if (editing) {
    return (
      <div className="max-w-2xl space-y-4">
        <div className="flex items-center gap-3 mb-2">
          <button
            onClick={() => setEditing(null)}
            className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            Back
          </button>
          <span className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">{editing.name || 'New Rule'}</span>
        </div>

        <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-5 space-y-5">
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
              Rule Name
            </label>
            <input
              value={editing.name}
              onChange={(e) => setEditing((r) => ({ ...r, name: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
              placeholder="e.g. Auto-escalate critical tickets"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
              Trigger Event
            </label>
            <select
              value={editing.trigger}
              onChange={(e) => setEditing((r) => ({ ...r, trigger: e.target.value }))}
              className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 bg-white dark:bg-[#121823]"
            >
              {TRIGGER_OPTIONS.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Conditions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                Conditions <span className="font-normal text-gray-500 dark:text-[#9aa4b2]">(all must match)</span>
              </label>
              <button
                onClick={() =>
                  setEditing((r) => ({
                    ...r,
                    conditions: [
                      ...r.conditions,
                      { field: 'priority', op: 'equals', value: 'Critical' },
                    ],
                  }))
                }
                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
              >
                + Add Condition
              </button>
            </div>
            {editing.conditions.length === 0 && (
              <p className="text-xs text-gray-500 dark:text-[#9aa4b2] italic">
                No conditions — rule runs on all tickets
              </p>
            )}
            {editing.conditions.map((c, i) => (
              <div key={i} className="flex gap-2 items-center mb-2">
                <select
                  value={c.field}
                  onChange={(e) =>
                    setEditing((r) => {
                      const conds = [...r.conditions]
                      conds[i] = { ...conds[i], field: e.target.value }
                      return { ...r, conditions: conds }
                    })
                  }
                  className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm bg-white dark:bg-[#121823]"
                >
                  {FIELD_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
                <select
                  value={c.op}
                  onChange={(e) =>
                    setEditing((r) => {
                      const conds = [...r.conditions]
                      conds[i] = { ...conds[i], op: e.target.value }
                      return { ...r, conditions: conds }
                    })
                  }
                  className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm bg-white dark:bg-[#121823]"
                >
                  {OP_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <input
                  value={c.value}
                  onChange={(e) =>
                    setEditing((r) => {
                      const conds = [...r.conditions]
                      conds[i] = { ...conds[i], value: e.target.value }
                      return { ...r, conditions: conds }
                    })
                  }
                  className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm"
                  placeholder="value"
                />
                <button
                  onClick={() =>
                    setEditing((r) => ({
                      ...r,
                      conditions: r.conditions.filter((_, j) => j !== i),
                    }))
                  }
                  className="text-red-400 hover:text-red-600"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider">
                Actions <span className="font-normal text-gray-500 dark:text-[#9aa4b2]">(executed in order)</span>
              </label>
              <button
                onClick={() =>
                  setEditing((r) => ({
                    ...r,
                    actions: [
                      ...r.actions,
                      { type: 'create_notification', title: 'Alert', value: '' },
                    ],
                  }))
                }
                className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
              >
                + Add Action
              </button>
            </div>
            {editing.actions.map((a, i) => (
              <div key={i} className="flex gap-2 items-center mb-2">
                <select
                  value={a.type}
                  onChange={(e) =>
                    setEditing((r) => {
                      const acts = [...r.actions]
                      acts[i] = { ...acts[i], type: e.target.value }
                      return { ...r, actions: acts }
                    })
                  }
                  className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm bg-white dark:bg-[#121823]"
                >
                  {ACTION_TYPES.map((at) => (
                    <option key={at.value} value={at.value}>
                      {at.label}
                    </option>
                  ))}
                </select>
                {a.type === 'change_status' && (
                  <select
                    value={a.value}
                    onChange={(e) =>
                      setEditing((r) => {
                        const acts = [...r.actions]
                        acts[i] = { ...acts[i], value: e.target.value }
                        return { ...r, actions: acts }
                      })
                    }
                    className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm bg-white dark:bg-[#121823]"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                )}
                {a.type === 'change_priority' && (
                  <select
                    value={a.value}
                    onChange={(e) =>
                      setEditing((r) => {
                        const acts = [...r.actions]
                        acts[i] = { ...acts[i], value: e.target.value }
                        return { ...r, actions: acts }
                      })
                    }
                    className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm bg-white dark:bg-[#121823]"
                  >
                    {PRIORITY_OPTIONS.map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                )}
                {(a.type === 'assign_technician' || a.type === 'create_notification') && (
                  <input
                    value={a.value}
                    onChange={(e) =>
                      setEditing((r) => {
                        const acts = [...r.actions]
                        acts[i] = { ...acts[i], value: e.target.value }
                        return { ...r, actions: acts }
                      })
                    }
                    className="flex-1 px-2 py-1.5 border border-gray-300 dark:border-[#212a38] rounded text-sm"
                    placeholder={
                      a.type === 'assign_technician' ? 'email@example.com' : 'Notification message'
                    }
                  />
                )}
                <button
                  onClick={() =>
                    setEditing((r) => ({ ...r, actions: r.actions.filter((_, j) => j !== i) }))
                  }
                  className="text-red-400 hover:text-red-600"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>
            ))}
          </div>

          <div className="flex gap-3 pt-2 border-t border-gray-100 dark:border-[#212a38]">
            <button
              onClick={saveEdit}
              disabled={saving}
              className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
            >
              {saving ? <Spinner size="sm" color="white" /> : null} Save Rule
            </button>
            <button
              onClick={() => setEditing(null)}
              className="px-5 py-2 bg-gray-100 dark:bg-[#1a2230] text-gray-700 dark:text-[#e8ebf0] text-sm font-medium rounded-lg hover:bg-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">
          {rules.length} rule{rules.length !== 1 ? 's' : ''} configured
        </p>
        <button
          onClick={() => setEditing(EMPTY_RULE())}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          New Rule
        </button>
      </div>

      {rules.length === 0 ? (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-dashed border-gray-300 dark:border-[#212a38] p-10 text-center">
          <svg
            className="w-10 h-10 text-gray-300 mx-auto mb-3"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">No automation rules yet</p>
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">
            Rules automatically act on tickets when events occur
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {rules.map((rule) => (
            <div key={rule.id} className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-gray-900 dark:text-[#e8ebf0]">{rule.name}</span>
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full font-medium ${rule.enabled ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#9aa4b2]'}`}
                    >
                      {rule.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">
                    Trigger:{' '}
                    <span className="font-medium text-gray-700 dark:text-[#e8ebf0]">
                      {TRIGGER_OPTIONS.find((t) => t.value === rule.trigger)?.label}
                    </span>
                    {rule.conditions.length > 0 && (
                      <>
                        {' '}
                        · {rule.conditions.length} condition
                        {rule.conditions.length !== 1 ? 's' : ''}
                      </>
                    )}
                    · {rule.actions.length} action{rule.actions.length !== 1 ? 's' : ''}
                  </div>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => toggleRule(rule.id)}
                    className={`text-xs px-3 py-1 rounded-lg font-medium ${rule.enabled ? 'bg-yellow-50 text-yellow-700 hover:bg-yellow-100' : 'bg-green-50 text-green-700 hover:bg-green-100'}`}
                  >
                    {rule.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => setEditing({ ...rule })}
                    className="text-xs px-3 py-1 rounded-lg font-medium bg-gray-50 dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-100 dark:bg-[#1a2230]"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => deleteRule(rule.id)}
                    className="text-xs px-3 py-1 rounded-lg font-medium bg-red-50 text-red-600 hover:bg-red-100"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── OUTBOUND WEBHOOKS ──────────────────────────────────────────────────────

const WEBHOOK_EVENTS = [
  'ticket_created',
  'ticket_updated',
  'ticket_status_changed',
  'ticket_assigned',
  'ticket_overdue',
  'customer_created',
  'customer_deleted',
  'invoice_created',
  'invoice_paid',
]

const EMPTY_HOOK = () => ({
  id: Date.now(),
  name: '',
  url: '',
  secret: '',
  enabled: true,
  events: [],
})

function WebhooksConfig({ currentUserEmail }) {
  const queryClient = useQueryClient()
  const { data: fetchedHooks } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => db.webhooks.list(),
  })
  const [hooks, setHooks] = useState(null)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(null)

  React.useEffect(() => {
    if (fetchedHooks && !hooks) setHooks(fetchedHooks || [])
  }, [fetchedHooks, hooks])

  const saveAll = async (newHooks) => {
    setSaving(true)
    try {
      await db.webhooks.save(newHooks, currentUserEmail)
      setHooks(newHooks)
      queryClient.invalidateQueries({ queryKey: ['webhooks'] })
      toast.success('Webhooks saved')
    } catch (e) {
      captureException(e, { page: 'ControlPanel', context: 'saveWebhooks' })
      toast.error(e.message)
    } finally {
      setSaving(false)
    }
  }

  const saveEdit = () => {
    if (!editing.name.trim() || !editing.url.trim()) {
      toast.error('Name and URL are required')
      return
    }
    try {
      new URL(editing.url)
    } catch {
      toast.error('Invalid URL')
      return
    }
    const exists = hooks.find((h) => h.id === editing.id)
    const updated = exists
      ? hooks.map((h) => (h.id === editing.id ? editing : h))
      : [...hooks, editing]
    saveAll(updated).then(() => setEditing(null))
  }

  const testHook = async (hook) => {
    setTesting(hook.id)
    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(hook.secret ? { 'X-myRMA-Secret': hook.secret } : {}),
        },
        body: JSON.stringify({
          event: 'test',
          timestamp: new Date().toISOString(),
          data: { message: 'Test from myRMA' },
        }),
      })
      res.ok
        ? toast.success(`Webhook responded: ${res.status}`)
        : toast.error(`Webhook returned ${res.status}`)
    } catch (err) {
      captureException(err, { page: 'ControlPanel', context: 'testWebhook' })
      toast.error('Failed to reach webhook URL')
    } finally {
      setTesting(null)
    }
  }

  if (!hooks)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )

  if (editing)
    return (
      <div className="max-w-lg space-y-4">
        <div className="flex items-center gap-3 mb-2">
          <button
            onClick={() => setEditing(null)}
            className="text-sm text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-1"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            Back
          </button>
          <span className="text-sm font-semibold text-gray-900 dark:text-[#e8ebf0]">
            {editing.name || 'New Webhook'}
          </span>
        </div>
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-5 space-y-4">
          {[
            { label: 'Name', key: 'name', placeholder: 'e.g. Notify Slack', type: 'text' },
            {
              label: 'Endpoint URL',
              key: 'url',
              placeholder: 'https://hooks.slack.com/...',
              type: 'url',
            },
            {
              label: 'Secret Header (optional)',
              key: 'secret',
              placeholder: 'Sent as X-myRMA-Secret',
              type: 'text',
            },
          ].map((f) => (
            <div key={f.key}>
              <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
                {f.label}
              </label>
              <input
                type={f.type}
                value={editing[f.key]}
                onChange={(e) => setEditing((h) => ({ ...h, [f.key]: e.target.value }))}
                className="w-full px-3 py-2 border border-gray-300 dark:border-[#212a38] rounded-lg text-sm focus:ring-2 focus:ring-indigo-600"
                placeholder={f.placeholder}
              />
            </div>
          ))}

          <div>
            <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-2">
              Events to Send <span className="font-normal">(leave empty = all events)</span>
            </label>
            <div className="flex flex-wrap gap-2">
              {WEBHOOK_EVENTS.map((ev) => (
                <button
                  key={ev}
                  onClick={() =>
                    setEditing((h) => ({
                      ...h,
                      events: h.events.includes(ev)
                        ? h.events.filter((e) => e !== ev)
                        : [...h.events, ev],
                    }))
                  }
                  className={`px-2.5 py-1 text-xs rounded-full font-medium border transition-colors ${editing.events.includes(ev) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white dark:bg-[#121823] text-gray-600 dark:text-[#9aa4b2] border-gray-300 dark:border-[#212a38] hover:border-indigo-400'}`}
                >
                  {ev}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-2 border-t border-gray-100 dark:border-[#212a38]">
            <button
              onClick={saveEdit}
              disabled={saving}
              className="px-5 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
            >
              {saving ? <Spinner size="sm" color="white" /> : null} Save Webhook
            </button>
            <button
              onClick={() => setEditing(null)}
              className="px-5 py-2 bg-gray-100 dark:bg-[#1a2230] text-gray-700 dark:text-[#e8ebf0] text-sm font-medium rounded-lg hover:bg-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    )

  return (
    <div className="max-w-2xl space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">
          {hooks.length} webhook{hooks.length !== 1 ? 's' : ''} configured
        </p>
        <button
          onClick={() => setEditing(EMPTY_HOOK())}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Webhook
        </button>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-xs text-blue-700">
        Webhooks send a POST request with JSON payload{' '}
        <code className="bg-blue-100 px-1 rounded">{'{ event, timestamp, data }'}</code> to your URL
        on selected events.
      </div>

      {hooks.length === 0 ? (
        <div className="bg-white dark:bg-[#121823] rounded-xl border border-dashed border-gray-300 dark:border-[#212a38] p-10 text-center">
          <p className="text-sm text-gray-500 dark:text-[#9aa4b2]">No webhooks configured</p>
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">
            Push ticket events to Slack, QuickBooks, Zapier, and more
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {hooks.map((h) => (
            <div key={h.id} className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-gray-900 dark:text-[#e8ebf0]">{h.name}</span>
                    <span
                      className={`px-2 py-0.5 text-xs rounded-full font-medium ${h.enabled ? 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400' : 'bg-gray-100 dark:bg-[#1a2230] text-gray-500 dark:text-[#9aa4b2]'}`}
                    >
                      {h.enabled ? 'Active' : 'Disabled'}
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-[#9aa4b2] font-mono mt-0.5 truncate">{h.url}</div>
                  {h.events.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {h.events.map((e) => (
                        <span
                          key={e}
                          className="px-1.5 py-0.5 bg-gray-100 dark:bg-[#1a2230] text-gray-600 dark:text-[#9aa4b2] text-xs rounded"
                        >
                          {e}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button
                    onClick={() => testHook(h)}
                    disabled={testing === h.id}
                    className="text-xs px-3 py-1 rounded-lg font-medium bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                  >
                    {testing === h.id ? '…' : 'Test'}
                  </button>
                  <button
                    onClick={() => setEditing({ ...h })}
                    className="text-xs px-3 py-1 rounded-lg font-medium bg-gray-50 dark:bg-[#0f1520] text-gray-700 dark:text-[#e8ebf0] hover:bg-gray-100 dark:bg-[#1a2230]"
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => saveAll(hooks.filter((wh) => wh.id !== h.id))}
                    className="text-xs px-3 py-1 rounded-lg font-medium bg-red-50 text-red-600 hover:bg-red-100"
                  >
                    Delete
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
