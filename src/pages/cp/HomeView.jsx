import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { TICKET_STATUS, TICKET_STATUS_LIST } from '../../lib/constants'
import { getStatusColor } from '../RMATickets/_utils'
import { GROUPS, COLOR_MAP } from './_registry'

export default function HomeView({ onNavigate, currentUserEmail: _currentUserEmail }) {
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
          {/* Derived from the shared status list plus whatever the data actually
              contains, not a hardcoded five. The old list showed 'New' — not a
              status this app has — and omitted Open, Pending and Closed, so the
              row summed to 9 of 14 real tickets and always showed Cancelled as
              0. A summary that silently drops a third of the rows is worse than
              no summary. Same fix as the kanban board (BUG #25). */}
          {[
            ...TICKET_STATUS_LIST,
            ...Object.keys(stats.byStatus)
              .filter((s) => s && !TICKET_STATUS_LIST.includes(s))
              .sort(),
          ].map((label) => (
            <div
              key={label}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm ${getStatusColor(label)}`}
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
