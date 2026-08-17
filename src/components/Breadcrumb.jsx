import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

// ── Control Panel section → group + feature label keys ───────────────────────
const CP_GROUPS = [
  { labelKey: 'cp.groupTickets', sections: ['rmaconfig', 'customfields', 'pdflayout'] },
  { labelKey: 'cp.groupUsers', sections: ['users', 'announcements', 'broadcast'] },
  { labelKey: 'cp.groupAppearance', sections: ['appearance', 'email'] },
  { labelKey: 'cp.groupAutomation', sections: ['sla', 'automation', 'webhooks', 'integrations'] },
  { labelKey: 'cp.groupMessaging', sections: ['wa-settings', 'wa-templates', 'wa-logs', 'wa-test'] },
  { labelKey: 'cp.groupData', sections: ['audit', 'cleanup', 'backup'] },
]

const CP_FEATURE_KEYS = {
  rmaconfig: 'cp.rmaConfigLabel',
  customfields: 'cp.customFieldsLabel',
  pdflayout: 'cp.pdfLayoutLabel',
  users: 'cp.userMgmtLabel',
  announcements: 'cp.announcementsLabel',
  broadcast: 'cp.sendAlertLabel',
  appearance: 'cp.appearanceLabel',
  email: 'cp.emailNotifLabel',
  sla: 'cp.slaPoliciesLabel',
  automation: 'cp.automationRulesLabel',
  webhooks: 'cp.webhooksLabel',
  integrations: 'cp.emailApiLabel',
  'wa-settings': 'cp.notifSettingsLabel',
  'wa-templates': 'cp.msgTemplatesLabel',
  'wa-logs': 'cp.notifLogsLabel',
  'wa-test': 'cp.testCenterLabel',
  audit: 'cp.auditLogLabel',
  cleanup: 'cp.dataCleanupLabel',
  backup: 'cp.backupRestoreLabel',
}

function buildCrumbs(pathname, searchParams, t) {
  // Customer detail
  if (pathname.startsWith('/customers/')) {
    return [
      { label: t('customers.title'), href: '/customers' },
      { label: t('customerDetails.title'), href: null },
    ]
  }

  // Product detail
  if (pathname.startsWith('/products/')) {
    return [
      { label: t('products.title'), href: '/products' },
      { label: t('products.tabDetails'), href: null },
    ]
  }

  // Inventory sub-tabs (skip default 'overview')
  if (pathname === '/inventory') {
    const tab = searchParams.get('tab')
    const LABELS = {
      'by-product': 'inventory.allUnits',
      'received': 'inventory.received',
      'under-repair': 'inventory.underRepair',
      'repaired': 'inventory.repaired',
      'cant-repair': 'inventory.cantRepair',
      'rma-stock': 'inventory.rmaStock',
      'warehouses': 'inventory.warehouses',
    }
    if (tab && LABELS[tab]) {
      return [
        { label: t('inventory.title'), href: '/inventory' },
        { label: t(LABELS[tab]), href: null },
      ]
    }
  }

  // Products sub-tabs (skip default 'products')
  if (pathname === '/products') {
    const tab = searchParams.get('tab')
    if (tab === 'hierarchy') {
      return [
        { label: t('products.title'), href: '/products' },
        { label: t('products.tabHierarchy'), href: null },
      ]
    }
  }

  // Reports sub-tabs (skip default 'tickets')
  if (pathname === '/reports') {
    const tab = searchParams.get('tab')
    const LABELS = {
      customers: 'reports.tabCustomers',
      technicians: 'reports.tabTechnicians',
      financial: 'reports.tabFinancial',
    }
    if (tab && LABELS[tab]) {
      return [
        { label: t('reports.title'), href: '/reports' },
        { label: t(LABELS[tab]), href: null },
      ]
    }
  }

  // Control Panel — 3-level: CP › Group › Feature
  if (pathname === '/control-panel') {
    const section = searchParams.get('section')
    if (section) {
      const group = CP_GROUPS.find((g) => g.sections.includes(section))
      const featureKey = CP_FEATURE_KEYS[section]
      if (group && featureKey) {
        return [
          { label: t('cp.title'), href: '/control-panel' },
          { label: t(group.labelKey), href: `/control-panel?section=${group.sections[0]}` },
          { label: t(featureKey), href: null },
        ]
      }
    }
  }

  // Account Settings sub-tabs (skip default 'Profile')
  if (pathname === '/account') {
    const tab = searchParams.get('tab')
    const LABELS = {
      Security: 'accountSettings.tabSecurity',
      Notifications: 'accountSettings.tabNotifications',
      Appearance: 'accountSettings.tabAppearance',
      Activity: 'accountSettings.tabActivity',
    }
    if (tab && LABELS[tab]) {
      return [
        { label: t('accountSettings.title'), href: '/account' },
        { label: t(LABELS[tab]), href: null },
      ]
    }
  }

  return null
}

export default function Breadcrumb() {
  const { pathname } = useLocation()
  const [searchParams] = useSearchParams()
  const { t, i18n } = useTranslation()
  const isRtl = i18n.language === 'ar'

  const crumbs = buildCrumbs(pathname, searchParams, t)
  if (!crumbs) return null

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex items-center gap-1 px-4 md:px-8 pt-4 pb-1 text-[12px] flex-shrink-0"
    >
      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1
        return (
          <span key={i} className="flex items-center gap-1">
            {i > 0 && (
              <svg
                className={`w-3 h-3 text-[#746f65] dark:text-[#a4acb7] flex-shrink-0 ${isRtl ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            )}
            {isLast || !crumb.href ? (
              <span className="text-[#211f1b] dark:text-[#e8ebf0] font-[500]">{crumb.label}</span>
            ) : (
              <Link
                to={crumb.href}
                className="text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#4338ca] dark:hover:text-[#a5b4fc] transition-colors"
              >
                {crumb.label}
              </Link>
            )}
          </span>
        )
      })}
    </nav>
  )
}
