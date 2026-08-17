import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { TICKET_STATUS } from '../../lib/constants'
import { GROUPS, COLOR_MAP } from './_registry'

function fmtCurrency(val) {
  if (!val) return '$0'
  if (val >= 1_000_000) return `$${(val / 1_000_000).toFixed(1)}M`
  if (val >= 1_000) return `$${(val / 1_000).toFixed(1)}K`
  return `$${val.toFixed(0)}`
}

export default function HomeView({ onNavigate, currentUserEmail: _currentUserEmail }) {
  const { t } = useTranslation()
  const { data: stats } = useQuery({
    queryKey: ['control-panel-stats'],
    queryFn: async () => {
      const [tickets, customers, users, deals, pipelines] = await Promise.all([
        db.rmaTickets.list(),
        db.customers.list(),
        db.userRoles.listAllRoles(),
        db.deals.list(),
        db.pipelines.list(),
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
      const openDeals = deals.filter((d) => d.status === 'open')

      // Configuration health, which is the thing an admin console can report
      // and the Dashboard cannot: deals sitting on a stage their own pipeline
      // does not define. There are 24 of them today, all on the B2C board, and
      // until the Pipelines & Stages editor existed there was no way to see it
      // here or fix it anywhere.
      const stagesByPipeline = {}
      for (const p of pipelines) {
        stagesByPipeline[p.id] = new Set((p.stages || []).map((x) => x.id))
      }
      const misStaged = deals.filter(
        (d) => d.pipeline_id && stagesByPipeline[d.pipeline_id] && !stagesByPipeline[d.pipeline_id].has(d.stage)
      ).length

      return {
        openTickets: open,
        overdue,
        customers: customers.length,
        users: users.length,
        openDeals: openDeals.length,
        openDealValue: openDeals.reduce((a, d) => a + (d.value || 0), 0),
        activePipelines: pipelines.filter((p) => p.is_active).length,
        totalPipelines: pipelines.length,
        stageCount: pipelines.reduce((a, p) => a + (p.stages || []).length, 0),
        misStaged,
      }
    },
    staleTime: 2 * 60_000,
  })

  // What an admin governs, not what an operator works on. The old four tiles
  // were total tickets, overdue tickets, customers and users — three of four
  // about 13 RMA tickets, which the Dashboard already reports better and now
  // reports differently, since it leads with CRM.
  const statCards = stats
    ? [
        {
          label: t('cp.statSystemUsers'),
          value: stats.users,
          sub: t('cp.statWithAccess'),
          color: 'purple',
        },
        {
          label: t('cp.statCustomers'),
          value: stats.customers,
          sub: t('cp.statInDatabase'),
          color: 'emerald',
        },
        {
          label: t('cp.statOpenDeals'),
          value: stats.openDeals,
          sub: t('cp.statPipelineValue', { value: fmtCurrency(stats.openDealValue) }),
          color: 'indigo',
        },
        {
          label: t('cp.statOpenTickets'),
          value: stats.openTickets,
          sub:
            stats.overdue > 0
              ? t('cp.statNOverdue', { count: stats.overdue })
              : t('cp.statNoneOverdue'),
          color: stats.overdue > 0 ? 'red' : 'green',
        },
      ]
    : []

  const colorStat = {
    indigo: 'text-indigo-600 dark:text-indigo-300',
    red: 'text-red-600 dark:text-red-300',
    green: 'text-green-600 dark:text-green-300',
    emerald: 'text-emerald-600 dark:text-emerald-300',
    purple: 'text-purple-600 dark:text-purple-300',
  }

  return (
    <div className="space-y-8">
      {/* Quick stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {statCards.map((c) => (
            <div key={c.label} className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-4 shadow-sm">
              <div className={`text-2xl font-bold ${colorStat[c.color]}`}>
                {c.value}
              </div>
              <div className="text-sm font-medium text-gray-700 dark:text-[#e8ebf0] mt-0.5">{c.label}</div>
              <div className="text-xs text-gray-500 dark:text-[#9aa4b2]">{c.sub}</div>
            </div>
          ))}
        </div>
      )}

      {/* Configuration health. This replaced a ticket-status breakdown — a
          straight duplicate of the Dashboard's donuts, on the admin console,
          summarising 13 tickets. An admin console should report on the
          configuration, and in particular on the parts of it that are wrong. */}
      {stats && (
        <div className="flex flex-wrap gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-gray-100 dark:bg-[#1a222f] text-gray-700 dark:text-[#e8ebf0]">
            <span className="font-medium">{t('cp.healthPipelines')}</span>
            <span className="font-bold">
              {stats.activePipelines}/{stats.totalPipelines}
            </span>
          </div>
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm bg-gray-100 dark:bg-[#1a222f] text-gray-700 dark:text-[#e8ebf0]">
            <span className="font-medium">{t('cp.healthStages')}</span>
            <span className="font-bold">{stats.stageCount}</span>
          </div>
          <button
            onClick={() => onNavigate('pipelines')}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm ${
              stats.misStaged > 0
                ? 'bg-red-100 dark:bg-red-500/15 text-red-800 dark:text-red-200'
                : 'bg-green-100 dark:bg-green-500/15 text-green-800 dark:text-green-200'
            }`}
          >
            <span className="font-medium">{t('cp.healthMisStaged')}</span>
            <span className="font-bold">{stats.misStaged}</span>
          </button>
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
