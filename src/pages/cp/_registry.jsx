// ─── Feature registry ──────────────────────────────────────────────────────
// Shared by ControlPanel.jsx (routing/access-gate) and HomeView.jsx (tile grid).

export const GROUPS = [
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
        id: 'kb',
        label: 'Knowledge Base',
        labelKey: 'cp.kbLabel',
        desc: 'FAQ articles shown on the public tracker page',
        descKey: 'cp.kbDesc',
        icon: (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s4.832.477 6 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
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

export const ALL_FEATURES = GROUPS.flatMap((g) => g.features)

export const COLOR_MAP = {
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
