import React, { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { db } from '../../api/supabaseClient'
import { supabase } from '../../api/client'
import toast from 'react-hot-toast'
import { Button, Spinner } from '../../components/ui'

const EVENT_OPTIONS = [
  { value: 'ticket.created',   label: 'Ticket Created' },
  { value: 'ticket.updated',   label: 'Ticket Updated' },
  { value: 'ticket.assigned',  label: 'Ticket Assigned' },
  { value: 'ticket.closed',    label: 'Ticket Closed' },
  { value: 'payment.received', label: 'Payment Received' },
]

export default function WATestCenter({ currentUserEmail }) {
  const qc = useQueryClient()

  // ── Send test message ────────────────────────────────────────────────────
  const [testPhone, setTestPhone]     = useState('')
  const [testTemplate, setTestTemplate] = useState('')
  const [testVars, setTestVars]       = useState({})
  const [testAttach, setTestAttach]   = useState('')
  const [sending, setSending]         = useState(false)
  const [lastResult, setLastResult]   = useState(null)

  // ── Simulate event ────────────────────────────────────────────────────────
  const [simEvent, setSimEvent]     = useState('ticket.created')
  const [simTicketId, setSimTicketId] = useState('')
  const [simPhone, setSimPhone]     = useState('')
  const [simulating, setSimulating] = useState(false)

  // ── Run worker ────────────────────────────────────────────────────────────
  const [running, setRunning]   = useState(false)
  const [workerResult, setWorkerResult] = useState(null)

  // ── Queue stats ───────────────────────────────────────────────────────────
  const { data: queueStats, refetch: refetchQueue } = useQuery({
    queryKey: ['queue-stats'],
    queryFn: () => db.notificationQueue.stats(),
    refetchInterval: 10_000,
  })

  const { data: templatesResult } = useQuery({
    queryKey: ['whatsapp-templates'],
    queryFn: () => db.whatsappTemplates.list(),
  })
  const templates = (templatesResult?.data ?? []).filter((t) => t.status === 'active')

  const selectedTemplate = templates.find((t) => t.id === testTemplate)

  // Update default vars when template changes
  const handleTemplateChange = (id) => {
    setTestTemplate(id)
    const tmpl = templates.find((t) => t.id === id)
    if (!tmpl) return
    const vars = {}
    for (const v of tmpl.variables ?? []) vars[v.key] = v.key === 'customer_name' ? 'Test Customer' : `[${v.label}]`
    setTestVars(vars)
  }

  const handleSendTest = async () => {
    if (!testPhone.trim()) { toast.error('Enter a phone number'); return }
    if (!testTemplate)     { toast.error('Select a template'); return }
    setSending(true)
    setLastResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('send-whatsapp', {
        body: {
          to: testPhone.trim(),
          recipientName: testVars.customer_name || 'Test Customer',
          templateName: selectedTemplate?.template_name,
          templateId: testTemplate,
          variables: testVars,
          attachmentUrl: testAttach.trim() || null,
          eventType: selectedTemplate?.event_type ?? 'manual',
          language: selectedTemplate?.language ?? 'en',
        },
      })
      if (error) throw error
      setLastResult({ success: data?.success, messageId: data?.message_id, error: data?.error, ts: new Date().toISOString() })
      if (data?.success) toast.success('Test message sent')
      else toast.error(`Send failed: ${data?.error ?? 'Unknown error'}`)
      qc.invalidateQueries({ queryKey: ['notification-logs'] })
      qc.invalidateQueries({ queryKey: ['notification-log-stats'] })
    } catch (err) {
      setLastResult({ success: false, error: err.message, ts: new Date().toISOString() })
      toast.error(`Error: ${err.message}`)
    } finally {
      setSending(false)
    }
  }

  const handleSimulate = async () => {
    if (!simPhone.trim()) { toast.error('Enter a customer phone number'); return }
    setSimulating(true)
    try {
      // Build a synthetic ticket payload and enqueue it
      const fakeTicket = {
        id: simTicketId || `sim-${Date.now()}`,
        rma_number: `RMA-SIM-${Date.now()}`,
        ticket_status: simEvent === 'ticket.closed' ? 'Closed' : 'In Progress',
        customer_name: 'Test Customer',
        customer_phone: simPhone.trim(),
        assigned_technician: currentUserEmail,
        general_description: 'Simulated ticket for testing notifications',
        created_date: new Date().toISOString(),
        due_date: new Date(Date.now() + 7 * 86400_000).toISOString(),
      }

      const { notificationEventBus } = await import('../../lib/events/NotificationEventBus.js')
      await notificationEventBus.emit({
        type: simEvent,
        timestamp: new Date().toISOString(),
        ticketId: fakeTicket.id,
        ticket: fakeTicket,
        triggeredBy: currentUserEmail,
        metadata: {},
      })

      toast.success(`Event "${simEvent}" simulated — check the queue and logs`)
      qc.invalidateQueries({ queryKey: ['queue-stats'] })
      qc.invalidateQueries({ queryKey: ['notification-logs'] })
    } catch (err) {
      toast.error(`Simulation failed: ${err.message}`)
    } finally {
      setSimulating(false)
    }
  }

  const handleRunWorker = async () => {
    setRunning(true)
    setWorkerResult(null)
    try {
      const { data, error } = await supabase.functions.invoke('notification-worker')
      if (error) throw error
      setWorkerResult(data)
      toast.success(`Worker ran: ${data?.processed ?? 0} processed, ${data?.failed ?? 0} failed`)
      qc.invalidateQueries({ queryKey: ['queue-stats'] })
      qc.invalidateQueries({ queryKey: ['notification-logs'] })
      qc.invalidateQueries({ queryKey: ['notification-log-stats'] })
    } catch (err) {
      toast.error(`Worker error: ${err.message}`)
    } finally {
      setRunning(false)
      refetchQueue()
    }
  }

  const inp = 'w-full px-3 py-2 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0] focus:ring-2 focus:ring-[#4338ca] focus:border-transparent'
  const lbl = 'block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5'
  const card = 'bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-[14px] p-5 space-y-4'

  return (
    <div className="max-w-3xl space-y-6">
      {/* Queue stats */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {[
          { label: 'Pending',    value: queueStats?.pending,    color: 'text-amber-600 dark:text-amber-400' },
          { label: 'Processing', value: queueStats?.processing, color: 'text-blue-600 dark:text-blue-400' },
          { label: 'Completed',  value: queueStats?.completed,  color: 'text-green-600 dark:text-green-400' },
          { label: 'Failed',     value: queueStats?.failed,     color: 'text-red-600 dark:text-red-400' },
          { label: 'Cancelled',  value: queueStats?.cancelled,  color: 'text-gray-500 dark:text-[#9aa4b2]' },
        ].map((s) => (
          <div key={s.label} className="bg-white dark:bg-[#121823] border border-[#e6e9ef] dark:border-[#212a38] rounded-xl p-3">
            <p className={`text-2xl font-bold ${s.color}`}>{s.value ?? 0}</p>
            <p className="text-xs text-gray-500 dark:text-[#9aa4b2] font-medium">{s.label}</p>
          </div>
        ))}
      </div>

      {/* Worker control */}
      <section className={card}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">⚙️</span>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-[#e8ebf0] uppercase tracking-wide">
            Queue Worker
          </h2>
        </div>
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">
          Manually trigger the notification worker to process all pending queue jobs immediately.
          In production, configure pg_cron to run this every 2 minutes automatically.
        </p>
        {workerResult && (
          <div className="bg-[#f8f9fb] dark:bg-[#0f1520] rounded-lg p-3 text-xs font-mono text-gray-700 dark:text-[#e8ebf0]">
            processed: {workerResult.processed} · failed: {workerResult.failed} · total: {workerResult.total}
            {workerResult.message && ` · ${workerResult.message}`}
          </div>
        )}
        <div className="flex items-center gap-3">
          <Button variant="primary" onClick={handleRunWorker} disabled={running} className="min-w-[160px]">
            {running ? <><Spinner size="sm" color="white" /><span className="ml-2">Running…</span></> : '▶ Run Worker Now'}
          </Button>
          <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">Processes up to 10 jobs per run</p>
        </div>
      </section>

      {/* Send test message */}
      <section className={card}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">💬</span>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-[#e8ebf0] uppercase tracking-wide">
            Send Test Message
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className={lbl}>Phone Number (E.164)</label>
            <input value={testPhone} onChange={(e) => setTestPhone(e.target.value)}
              placeholder="+966501234567" className={inp} />
          </div>
          <div>
            <label className={lbl}>Template</label>
            <select value={testTemplate} onChange={(e) => handleTemplateChange(e.target.value)} className={inp}>
              <option value="">— Select template —</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.display_name} ({t.provider})</option>
              ))}
            </select>
          </div>
        </div>

        {selectedTemplate && (selectedTemplate.variables ?? []).length > 0 && (
          <div>
            <label className={lbl}>Template Variables</label>
            <div className="space-y-2">
              {selectedTemplate.variables.map((v) => (
                <div key={v.key} className="flex items-center gap-2">
                  <code className="text-xs font-mono text-[#4338ca] dark:text-[#a5b4fc] w-32 flex-shrink-0">{`{{${v.key}}}`}</code>
                  <input value={testVars[v.key] ?? ''} onChange={(e) => setTestVars((p) => ({ ...p, [v.key]: e.target.value }))}
                    placeholder={v.label} className={`flex-1 px-2 py-1.5 text-sm border border-[#e6e9ef] dark:border-[#212a38] rounded-lg bg-white dark:bg-[#0f1520] text-gray-800 dark:text-[#e8ebf0]`} />
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <label className={lbl}>PDF Attachment URL (optional)</label>
          <input value={testAttach} onChange={(e) => setTestAttach(e.target.value)}
            placeholder="https://…/ticket.pdf" className={inp} />
        </div>

        {lastResult && (
          <div className={`rounded-lg p-3 text-xs ${lastResult.success ? 'bg-green-50 dark:bg-green-900/20 text-green-800 dark:text-green-400 border border-green-200 dark:border-green-800/50' : 'bg-red-50 dark:bg-red-900/20 text-red-800 dark:text-red-400 border border-red-200 dark:border-red-800/50'}`}>
            {lastResult.success
              ? `✓ Sent · Message ID: ${lastResult.messageId ?? '—'}`
              : `✗ Failed: ${lastResult.error ?? 'Unknown error'}`}
          </div>
        )}

        <Button variant="primary" onClick={handleSendTest} disabled={sending} className="min-w-[160px]">
          {sending ? <><Spinner size="sm" color="white" /><span className="ml-2">Sending…</span></> : '▶ Send Test Message'}
        </Button>
      </section>

      {/* Simulate event */}
      <section className={card}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">🔁</span>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-[#e8ebf0] uppercase tracking-wide">
            Simulate Event
          </h2>
        </div>
        <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">
          Fires a synthetic notification event to test the full pipeline: event → queue → worker → WhatsApp.
          Requires WhatsApp to be enabled in Settings.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className={lbl}>Event Type</label>
            <select value={simEvent} onChange={(e) => setSimEvent(e.target.value)} className={inp}>
              {EVENT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className={lbl}>Customer Phone</label>
            <input value={simPhone} onChange={(e) => setSimPhone(e.target.value)}
              placeholder="+966501234567" className={inp} />
          </div>
          <div>
            <label className={lbl}>Ticket ID (optional)</label>
            <input value={simTicketId} onChange={(e) => setSimTicketId(e.target.value)}
              placeholder="existing ticket UUID" className={inp} />
          </div>
        </div>
        <Button variant="secondary" onClick={handleSimulate} disabled={simulating}>
          {simulating ? <><Spinner size="sm" /><span className="ml-2">Simulating…</span></> : '⚡ Simulate Event'}
        </Button>
      </section>

      {/* Setup guide */}
      <section className={card}>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-lg">📖</span>
          <h2 className="text-sm font-semibold text-gray-700 dark:text-[#e8ebf0] uppercase tracking-wide">
            Production Setup Checklist
          </h2>
        </div>
        <ol className="space-y-2 text-sm text-gray-700 dark:text-[#e8ebf0]">
          {[
            'Create a Meta App at developers.facebook.com with WhatsApp Business product',
            'Register a phone number and get the Phone Number ID',
            'Generate a permanent System User access token',
            'Set WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID in Supabase → Edge Functions → Secrets',
            'Set WHATSAPP_WEBHOOK_VERIFY_TOKEN (any secret string) in Supabase secrets',
            'Add webhook URL in Meta Dashboard: https://<project>.supabase.co/functions/v1/whatsapp-webhook',
            'Subscribe to "messages" webhook field in Meta Dashboard',
            'Run the SQL migration: supabase/migrations/20260602_whatsapp_notifications.sql',
            'Enable WhatsApp in Control Panel → Notification Settings',
            '(Optional) Set up pg_cron to auto-run notification-worker every 2 minutes',
          ].map((step, i) => (
            <li key={i} className="flex items-start gap-2.5">
              <span className="flex-shrink-0 w-5 h-5 rounded-full bg-[#4338ca] dark:bg-[#a5b4fc] text-white dark:text-[#0b0f17] text-xs font-bold flex items-center justify-center">
                {i + 1}
              </span>
              {step}
            </li>
          ))}
        </ol>
        <div className="mt-2 bg-[#f8f9fb] dark:bg-[#0f1520] rounded-lg p-3 font-mono text-xs text-gray-600 dark:text-[#9aa4b2]">
          {`-- pg_cron setup (Supabase Pro plan)\nSELECT cron.schedule('notification-worker','*/2 * * * *',\n  $$SELECT net.http_post(\n    url:='https://<project>.supabase.co/functions/v1/notification-worker',\n    headers:='{"x-worker-secret":"<YOUR_WORKER_SECRET>"}'::jsonb\n  )$$\n);`}
        </div>
      </section>
    </div>
  )
}
