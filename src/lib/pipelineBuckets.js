/**
 * The Pipeline's numbers, from the database's buckets. (Audit finding BUG-066.)
 *
 * The graph, the pivot, the Kanban column totals and the Activity view's column
 * headers used to be computed from a list of every deal (and every open
 * activity) held in the browser — a list the Data API caps at 1 000 rows. They
 * are now sums over small grouped rows the database returns
 * (`db.deals.buckets`, `activityValues`, `activityTypeCounts`, 20260858). These
 * helpers are that arithmetic, kept pure so it is tested once.
 */

/** 'YYYY-MM' → "Sep 2026", the label the screen used for a month; null for no month. */
export function monthLabel(yearMonth) {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth ?? '')
  if (!match) return null
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString('en', {
    year: 'numeric',
    month: 'short',
  })
}

/** Deal count and value over buckets, and the won part of each. */
export function bucketTotals(buckets) {
  const out = { count: 0, value: 0, wonCount: 0, wonValue: 0 }
  for (const b of buckets ?? []) {
    out.count += Number(b.deal_count) || 0
    out.value += Number(b.value_sum) || 0
    if (b.status === 'won') {
      out.wonCount += Number(b.deal_count) || 0
      out.wonValue += Number(b.value_sum) || 0
    }
  }
  return out
}

/** { [stageId]: { count, value } } over buckets. */
export function stageTotals(buckets) {
  const out = {}
  for (const b of buckets ?? []) {
    const t = (out[b.stage] ??= { count: 0, value: 0 })
    t.count += Number(b.deal_count) || 0
    t.value += Number(b.value_sum) || 0
  }
  return out
}

/** { [stageId]: { overdue, today, planned } } — deal value by worst open-activity state. */
export function stageActivityValues(rows) {
  const out = {}
  for (const r of rows ?? []) {
    const t = (out[r.stage] ??= { overdue: 0, today: 0, planned: 0 })
    if (r.activity_state in t) t[r.activity_state] += Number(r.value_sum) || 0
  }
  return out
}

/** { [type]: { done, total } } for each of `types`, over activity-type count rows. */
export function activityTypeStats(rows, types) {
  const out = Object.fromEntries(types.map((type) => [type, { done: 0, total: 0 }]))
  for (const r of rows ?? []) {
    const t = out[r.activity_type]
    if (!t) continue
    t.total += Number(r.activity_count) || 0
    t.done += Number(r.done_count) || 0
  }
  return out
}

/**
 * Group buckets by a label: `[{ name, count, revenue }]`, in first-seen order.
 * `labelOf(bucket)` names the group a bucket belongs to.
 */
export function groupBuckets(buckets, labelOf) {
  const groups = new Map()
  for (const b of buckets ?? []) {
    const name = labelOf(b)
    const g = groups.get(name) ?? { name, count: 0, revenue: 0 }
    g.count += Number(b.deal_count) || 0
    g.revenue += Number(b.value_sum) || 0
    groups.set(name, g)
  }
  return [...groups.values()]
}
