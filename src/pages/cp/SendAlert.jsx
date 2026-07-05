import React, { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db } from '../../api/supabaseClient'
import toast from 'react-hot-toast'
import { captureException } from '../../lib/sentry'
import { Spinner } from '../../components/ui'

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

export default function SendAlert({ currentUserEmail }) {
  const { t } = useTranslation()
  const [type, setType] = useState('system_announcement')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [target, setTarget] = useState('all')
  const [specificEmail, setSpecificEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)

  const handleSend = async () => {
    if (!title.trim() || !message.trim()) {
      toast.error(t('cp.sendAlert.titleRequired'))
      return
    }
    if (target === 'email' && !specificEmail.trim()) {
      toast.error(t('cp.sendAlert.recipientRequired'))
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
      toast.success(t('cp.sendAlert.successSent'))
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
      toast.error(t('cp.sendAlert.failedSend', { error: err.message }))
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
            {t('cp.sendAlert.alertType')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {ALERT_TYPES.map((at) => (
              <button
                key={at.value}
                onClick={() => setType(at.value)}
                className={`flex items-center gap-3 p-3.5 rounded-xl border-2 text-left transition-colors ${type === at.value ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 dark:border-[#212a38] hover:border-gray-300 dark:border-[#212a38] bg-white dark:bg-[#121823]'}`}
              >
                <span className="text-2xl">{at.icon}</span>
                <div>
                  <p className="text-sm font-semibold text-gray-800">{at.value === 'system_announcement' ? t('cp.sendAlert.typeAnnouncement') : t('cp.sendAlert.typeWarning')}</p>
                  <p className="text-xs text-gray-500 dark:text-[#9aa4b2]">{at.desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Title */}
        <div>
          <label className="block text-xs font-semibold text-gray-500 dark:text-[#9aa4b2] uppercase tracking-wider mb-1.5">
            {t('cp.sendAlert.titleLabel')}
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
            {t('cp.sendAlert.messageLabel')}
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
            {t('cp.sendAlert.sendTo')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {ALERT_TARGETS.map((tgt) => (
              <button
                key={tgt.value}
                onClick={() => setTarget(tgt.value)}
                className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border-2 text-sm font-medium transition-colors ${target === tgt.value ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 dark:border-[#212a38] text-gray-600 dark:text-[#9aa4b2] hover:border-gray-300 dark:border-[#212a38] bg-white dark:bg-[#121823]'}`}
              >
                <span>{tgt.icon}</span>
                {tgt.value === 'all' ? t('cp.sendAlert.targetEveryone') : tgt.value === 'admins' ? t('cp.sendAlert.targetAdmins') : tgt.value === 'technicians' ? t('cp.sendAlert.targetTechnicians') : t('cp.sendAlert.targetEmail')}
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
                {t('cp.sendAlert.sending')}
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
                {t('cp.sendAlert.sent')}
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
                {t('cp.sendAlert.sendBtn')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
