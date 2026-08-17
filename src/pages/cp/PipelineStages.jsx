import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { db } from '../../api/supabaseClient'
import { captureException } from '../../lib/sentry'
import { Spinner } from '../../components/ui'
import { useConfirm } from '../../hooks/useConfirm'
import { EMPTY_ARRAY } from '../../lib/stableEmpty'

/**
 * Pipelines & Stages.
 *
 * `db.pipelines.update()` has existed since the CRM sprints — it validates its
 * input and is admin-gated at the RLS layer — and until now nothing called it.
 * Six pages read pipelines; none wrote one. Renaming a stage or reordering a
 * board meant running SQL against production.
 *
 * The editor deliberately refuses two things the API would also refuse, so the
 * UI never offers an action that fails on submit:
 *
 *   - A stage id is immutable. Deals store the id, so editing it orphans every
 *     deal on that stage — which is exactly the damage this page exists to
 *     repair. The display name is free to change.
 *   - Won and lost stages cannot be removed or unmarked, because
 *     validateStages() requires exactly one of each.
 *
 * A stage holding deals cannot be deleted either. That is our own rule rather
 * than the API's: the write would succeed and quietly orphan the deals.
 */

const slugify = (name) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

const isTerminal = (s) => s.is_won || s.is_lost

export default function PipelineStages({ currentUserEmail }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { confirm, confirmDialog } = useConfirm()

  const { data: pipelines = EMPTY_ARRAY, isLoading } = useQuery({
    queryKey: ['pipelines'],
    queryFn: () => db.pipelines.list(),
  })
  // Every deal, not just open ones: a won deal still occupies a stage, and
  // deleting a stage out from under it breaks the historical record too.
  const { data: deals = EMPTY_ARRAY } = useQuery({
    queryKey: ['cp-pipeline-deals'],
    queryFn: () => db.deals.list(),
  })

  // pipeline_id -> stage id -> deals on it. Built from what the deals actually
  // say, not from the pipeline definition, which is the whole point: the two
  // disagree today and the page has to be able to show that.
  const dealsByStage = useMemo(() => {
    const map = {}
    for (const d of deals) {
      if (!d.pipeline_id) continue
      const byStage = (map[d.pipeline_id] ||= {})
      ;(byStage[d.stage] ||= []).push(d)
    }
    return map
  }, [deals])

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600 dark:text-[#9aa4b2] max-w-3xl">
        {t('cp.pipelineStages.intro')}
      </p>
      {pipelines.map((p) => (
        <PipelineCard
          key={p.id}
          pipeline={p}
          stageCounts={dealsByStage[p.id] || {}}
          currentUserEmail={currentUserEmail}
          onSaved={() => {
            queryClient.invalidateQueries({ queryKey: ['pipelines'] })
            queryClient.invalidateQueries({ queryKey: ['cp-pipeline-deals'] })
          }}
          confirm={confirm}
        />
      ))}
      {confirmDialog}
    </div>
  )
}

function PipelineCard({ pipeline, stageCounts, currentUserEmail, onSaved, confirm }) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(() => ({
    name: pipeline.name,
    is_active: pipeline.is_active,
    stages: pipeline.stages.map((s) => ({ ...s })),
  }))
  const [saving, setSaving] = useState(false)
  const [newStageName, setNewStageName] = useState('')

  const dirty = useMemo(
    () =>
      draft.name !== pipeline.name ||
      draft.is_active !== pipeline.is_active ||
      JSON.stringify(draft.stages) !== JSON.stringify(pipeline.stages),
    [draft, pipeline]
  )

  const open = draft.stages.filter((s) => !isTerminal(s))
  const terminal = draft.stages.filter(isTerminal)

  // Stage values the deals hold that this pipeline does not define. Reading the
  // saved pipeline rather than the draft, because an unsaved edit should not
  // make a real data problem appear or vanish.
  const orphans = useMemo(() => {
    const defined = new Set(pipeline.stages.map((s) => s.id))
    return Object.entries(stageCounts)
      .filter(([id]) => !defined.has(id))
      .map(([id, list]) => ({ id, deals: list }))
      .sort((a, b) => b.deals.length - a.deals.length)
  }, [stageCounts, pipeline.stages])

  const patch = (id, fields) =>
    setDraft((d) => ({
      ...d,
      stages: d.stages.map((s) => (s.id === id ? { ...s, ...fields } : s)),
    }))

  const move = (id, delta) =>
    setDraft((d) => {
      const list = [...d.stages]
      const from = list.findIndex((s) => s.id === id)
      const to = from + delta
      // Terminal stages are pinned at the end; nothing swaps across them.
      if (to < 0 || to >= list.length || isTerminal(list[to])) return d
      ;[list[from], list[to]] = [list[to], list[from]]
      return { ...d, stages: list }
    })

  const addStage = () => {
    const name = newStageName.trim()
    if (!name) return
    const id = slugify(name)
    if (!id) {
      toast.error(t('cp.pipelineStages.badName'))
      return
    }
    if (draft.stages.some((s) => s.id === id)) {
      toast.error(t('cp.pipelineStages.duplicateStage', { id }))
      return
    }
    setDraft((d) => {
      const list = [...d.stages]
      // Insert ahead of won/lost, which always sit last.
      const at = list.findIndex(isTerminal)
      const stage = { id, name, order: 0, probability_default: 50, is_won: false, is_lost: false }
      list.splice(at === -1 ? list.length : at, 0, stage)
      return { ...d, stages: list }
    })
    setNewStageName('')
  }

  const removeStage = (id) =>
    setDraft((d) => ({ ...d, stages: d.stages.filter((s) => s.id !== id) }))

  const save = async () => {
    setSaving(true)
    try {
      // order is positional, so it is derived on save rather than tracked in the
      // draft — two stages can never disagree about who is third.
      const stages = [...open, ...terminal].map((s, i) => ({
        ...s,
        // 1-based, matching what the seeded pipelines already store. Only the
        // relative order is ever read, but there is no reason to renumber
        // every stage in the database as a side effect of an unrelated edit.
        order: i + 1,
        probability_default: Number(s.probability_default) || 0,
      }))
      await db.pipelines.update(pipeline.id, {
        name: draft.name.trim() || pipeline.name,
        is_active: draft.is_active,
        stages,
      })
      toast.success(t('cp.pipelineStages.saved'))
      db.auditLog
        .log(currentUserEmail, 'pipeline_updated', `Updated pipeline "${draft.name}"`)
        .catch(() => {})
      onSaved()
    } catch (e) {
      captureException(e, { page: 'ControlPanel', context: 'savePipeline' })
      toast.error(e?.message || t('cp.pipelineStages.saveFailed'))
    } finally {
      setSaving(false)
    }
  }

  const repair = (orphan, targetId) => {
    const target = pipeline.stages.find((s) => s.id === targetId)
    if (!target) return
    confirm({
      title: t('cp.pipelineStages.repairTitle'),
      // ConfirmDialog defaults its action button to "Delete" — right for the ten
      // call sites it was built for, wrong for a move.
      confirmLabel: t('cp.pipelineStages.moveDeals'),
      message: t('cp.pipelineStages.repairConfirm', {
        count: orphan.deals.length,
        from: orphan.id,
        to: target.name,
      }),
      onConfirm: async () => {
        try {
          await db.deals.bulkMoveStage(
            orphan.deals.map((d) => d.id),
            targetId
          )
          toast.success(t('cp.pipelineStages.repaired', { count: orphan.deals.length }))
          db.auditLog
            .log(
              currentUserEmail,
              'deals_restaged',
              `Moved ${orphan.deals.length} deal(s) from undefined stage "${orphan.id}" to "${targetId}"`
            )
            .catch(() => {})
          onSaved()
        } catch (e) {
          captureException(e, { page: 'ControlPanel', context: 'repairOrphanStage' })
          toast.error(e?.message || t('cp.pipelineStages.repairFailed'))
        }
      },
    })
  }

  const totalDeals = Object.values(stageCounts).reduce((a, l) => a + l.length, 0)

  return (
    <div className="bg-white dark:bg-[#121823] rounded-xl border border-gray-200 dark:border-[#212a38] p-5 space-y-4">
      {/* Pipeline header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex-1 min-w-[16rem]">
          <label
            htmlFor={`pl-name-${pipeline.id}`}
            className="block text-xs font-medium text-gray-500 dark:text-[#9aa4b2] mb-1"
          >
            {t('cp.pipelineStages.pipelineName')}
          </label>
          <input
            id={`pl-name-${pipeline.id}`}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            className="w-full px-3 py-1.5 text-sm font-semibold rounded-lg border border-gray-200 dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0]"
          />
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2] mt-1">
            {t('cp.pipelineStages.dealCount', { count: totalDeals })}
          </p>
        </div>
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <span className="text-sm font-medium text-gray-600 dark:text-[#9aa4b2]">
            {t('cp.pipelineStages.active')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={draft.is_active}
            aria-label={t('cp.pipelineStages.active')}
            onClick={() => setDraft((d) => ({ ...d, is_active: !d.is_active }))}
            className={`relative inline-flex h-5 w-9 rounded-full transition-colors ${
              draft.is_active ? 'bg-indigo-600' : 'bg-gray-300 dark:bg-[#2a3444]'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
                draft.is_active ? 'translate-x-4' : 'translate-x-0'
              }`}
            />
          </button>
        </label>
      </div>

      {/* Stages */}
      <div className="border border-gray-200 dark:border-[#212a38] rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-[#0f1520] text-xs text-gray-600 dark:text-[#9aa4b2]">
            <tr>
              <th className="px-2 py-2 text-left w-16">{t('cp.pipelineStages.colOrder')}</th>
              <th className="px-2 py-2 text-left">{t('cp.pipelineStages.colName')}</th>
              <th className="px-2 py-2 text-left">{t('cp.pipelineStages.colId')}</th>
              <th className="px-2 py-2 text-left w-24">{t('cp.pipelineStages.colProb')}</th>
              <th className="px-2 py-2 text-left w-20">{t('cp.pipelineStages.colDeals')}</th>
              <th className="px-2 py-2 text-left w-20">{t('cp.pipelineStages.colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-[#212a38]">
            {[...open, ...terminal].map((s, i) => {
              const count = (stageCounts[s.id] || []).length
              const terminalRow = isTerminal(s)
              return (
                <tr key={s.id}>
                  <td className="px-2 py-1.5">
                    {!terminalRow && (
                      <div className="flex gap-0.5">
                        <button
                          type="button"
                          aria-label={t('cp.pipelineStages.moveUp', { name: s.name })}
                          disabled={i === 0}
                          onClick={() => move(s.id, -1)}
                          className="px-1.5 py-0.5 rounded border border-gray-200 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          aria-label={t('cp.pipelineStages.moveDown', { name: s.name })}
                          disabled={i === open.length - 1}
                          onClick={() => move(s.id, 1)}
                          className="px-1.5 py-0.5 rounded border border-gray-200 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] disabled:opacity-30"
                        >
                          ↓
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      value={s.name}
                      aria-label={t('cp.pipelineStages.colName')}
                      onChange={(e) => patch(s.id, { name: e.target.value })}
                      className="w-full px-2 py-1 rounded border border-gray-200 dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0]"
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    {/* Immutable, and shown rather than hidden: an admin
                        debugging a report needs the value the rows store. */}
                    <code className="text-xs text-gray-500 dark:text-[#9aa4b2]">{s.id}</code>
                    {s.is_won && (
                      <span className="ml-2 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                        {t('cp.pipelineStages.wonTag')}
                      </span>
                    )}
                    {s.is_lost && (
                      <span className="ml-2 text-[10px] font-semibold text-red-700 dark:text-red-300">
                        {t('cp.pipelineStages.lostTag')}
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={s.probability_default}
                      aria-label={t('cp.pipelineStages.colProb')}
                      onChange={(e) => patch(s.id, { probability_default: e.target.value })}
                      className="w-16 px-2 py-1 rounded border border-gray-200 dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0]"
                    />
                  </td>
                  <td className="px-2 py-1.5 text-gray-700 dark:text-[#e8ebf0]">{count}</td>
                  <td className="px-2 py-1.5">
                    <button
                      type="button"
                      disabled={terminalRow || count > 0}
                      title={
                        terminalRow
                          ? t('cp.pipelineStages.cantDeleteTerminal')
                          : count > 0
                            ? t('cp.pipelineStages.cantDeleteInUse', { count })
                            : undefined
                      }
                      onClick={() => removeStage(s.id)}
                      className="text-xs font-medium text-red-600 dark:text-red-300 disabled:text-gray-500 dark:disabled:text-[#8b93a1] disabled:cursor-not-allowed"
                    >
                      {t('common.delete')}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Add a stage */}
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label
            htmlFor={`pl-add-${pipeline.id}`}
            className="block text-xs font-medium text-gray-500 dark:text-[#9aa4b2] mb-1"
          >
            {t('cp.pipelineStages.addStage')}
          </label>
          <input
            id={`pl-add-${pipeline.id}`}
            value={newStageName}
            onChange={(e) => setNewStageName(e.target.value)}
            placeholder={t('cp.pipelineStages.addPlaceholder')}
            className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-[#212a38] bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0]"
          />
        </div>
        <button
          type="button"
          onClick={addStage}
          className="px-3 py-1.5 text-sm font-medium rounded-lg border border-gray-200 dark:border-[#212a38] text-gray-700 dark:text-[#e8ebf0]"
        >
          {t('cp.pipelineStages.add')}
        </button>
      </div>

      {/* Deals on stages this pipeline does not define */}
      {orphans.length > 0 && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 p-4 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              {t('cp.pipelineStages.orphanTitle')}
            </h2>
            <p className="text-xs text-amber-800 dark:text-amber-200/90 mt-0.5">
              {t('cp.pipelineStages.orphanDesc')}
            </p>
          </div>
          {orphans.map((o) => (
            <OrphanRow key={o.id} orphan={o} pipeline={pipeline} onRepair={repair} />
          ))}
        </div>
      )}

      {/* Save */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving}
          className="px-4 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white disabled:opacity-40"
        >
          {saving ? t('common.saving') : t('common.save')}
        </button>
        {dirty && !saving && (
          <button
            type="button"
            onClick={() =>
              setDraft({
                name: pipeline.name,
                is_active: pipeline.is_active,
                stages: pipeline.stages.map((s) => ({ ...s })),
              })
            }
            className="text-sm font-medium text-gray-600 dark:text-[#9aa4b2]"
          >
            {t('common.cancel')}
          </button>
        )}
      </div>
    </div>
  )
}

function OrphanRow({ orphan, pipeline, onRepair }) {
  const { t } = useTranslation()
  const targets = pipeline.stages.filter((s) => !isTerminal(s))
  const [target, setTarget] = useState(targets[0]?.id || '')
  const selectId = `orphan-${pipeline.id}-${orphan.id}`
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-amber-900 dark:text-amber-100">
        <code className="font-semibold">{orphan.id}</code>
        {' — '}
        {t('cp.pipelineStages.orphanCount', { count: orphan.deals.length })}
      </span>
      <label htmlFor={selectId} className="text-xs text-amber-800 dark:text-amber-200/90">
        {t('cp.pipelineStages.moveTo')}
      </label>
      <select
        id={selectId}
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="px-2 py-1 text-sm rounded border border-amber-300 dark:border-amber-500/40 bg-white dark:bg-[#0f1520] text-gray-900 dark:text-[#e8ebf0]"
      >
        {targets.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => onRepair(orphan, target)}
        disabled={!target}
        className="px-2.5 py-1 text-xs font-medium rounded border border-amber-400 dark:border-amber-500/50 text-amber-900 dark:text-amber-100 disabled:opacity-40"
      >
        {t('cp.pipelineStages.moveDeals')}
      </button>
    </div>
  )
}
