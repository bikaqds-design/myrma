import React, { useState } from 'react'
import { db, branding as brandingAPI } from '../api/supabaseClient'
import { safeStorage } from '../lib/safeStorage'
import toast from 'react-hot-toast'

const TOTAL = 5

function ProgressBar({ step }) {
  return (
    <div className="flex items-center gap-1.5 px-6 pt-5 pb-4">
      {Array.from({ length: TOTAL }).map((_, i) => (
        <div key={i} className={`h-1.5 flex-1 rounded-full transition-all duration-300 ${i < step ? 'bg-[#4338ca] dark:bg-[#a5b4fc]' : 'bg-[#e6e9ef] dark:bg-[#212a38]'}`} />
      ))}
      <span className="text-xs text-[#6c6760] dark:text-[#9aa4b2] ml-1 flex-shrink-0">{step}/{TOTAL}</span>
    </div>
  )
}

export default function OnboardingWizard({ userEmail, onClose, onNavigate }) {
  const [step, setStep] = useState(1)
  const [companyName, setCompanyName] = useState('')
  const [savingBranding, setSavingBranding] = useState(false)
  const [custName, setCustName] = useState('')
  const [custEmail, setCustEmail] = useState('')
  const [custPhone, setCustPhone] = useState('')
  const [savingCust, setSavingCust] = useState(false)
  const [savedCust, setSavedCust] = useState(null)

  const storageKey = `mrma_onboarding_v1_${userEmail}`

  const dismiss = () => {
    safeStorage.set(storageKey, { done: true })
    onClose()
  }

  const next = () => setStep((s) => Math.min(s + 1, TOTAL))

  const saveBranding = async () => {
    if (!companyName.trim()) { next(); return }
    setSavingBranding(true)
    try {
      await brandingAPI.update({ company_name: companyName.trim() })
      toast.success('Company name saved')
    } catch { /* non-critical — continue */ }
    finally { setSavingBranding(false) }
    next()
  }

  const saveCustomer = async () => {
    if (!custName.trim()) { toast.error('Customer name is required'); return }
    setSavingCust(true)
    try {
      const created = await db.customers.create({
        contact_person: custName.trim(),
        email: custEmail.trim() || null,
        mobile: custPhone.trim() || null,
      })
      setSavedCust(created)
      toast.success('Customer added!')
      next()
    } catch (err) {
      toast.error('Failed to add customer: ' + err.message)
    } finally {
      setSavingCust(false)
    }
  }

  const goToTickets = () => {
    safeStorage.set(storageKey, { done: true })
    onNavigate('/rma-tickets')
    onClose()
  }

  const finish = () => {
    safeStorage.set(storageKey, { done: true })
    onClose()
  }

  const lbl = 'block text-xs font-medium text-[#6c6760] dark:text-[#9aa4b2] mb-1'
  const inp = 'w-full px-3 py-2 border border-[#e6e9ef] dark:border-[#212a38] rounded-lg text-sm bg-white dark:bg-[#0f1520] text-[#211f1b] dark:text-[#e8ebf0] placeholder-[#a09d99] dark:placeholder-[#4a5568] focus:outline-none focus:border-[#4338ca] dark:focus:border-[#a5b4fc] transition-colors'

  return (
    <div className="fixed inset-0 z-[500] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" onClick={dismiss} />
      <div className="relative w-full max-w-md bg-white dark:bg-[#121823] rounded-2xl shadow-2xl border border-[#e6e9ef] dark:border-[#212a38] overflow-hidden">

        {/* Close */}
        <button onClick={dismiss} aria-label="Dismiss wizard"
          className="absolute top-4 right-4 w-7 h-7 flex items-center justify-center rounded-lg text-[#6c6760] dark:text-[#9aa4b2] hover:bg-[#f4f6f9] dark:hover:bg-[#1a2230] transition-colors z-10">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>

        <ProgressBar step={step} />

        <div className="px-6 pb-6">

          {/* ── Step 1: Welcome ── */}
          {step === 1 && (
            <div className="text-center py-4">
              <div className="w-16 h-16 rounded-2xl bg-[#eef2ff] dark:bg-[#1e1b4b] flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-[#4338ca] dark:text-[#a5b4fc]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-[#211f1b] dark:text-[#e8ebf0] mb-2">Welcome to myRMA!</h2>
              <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] max-w-xs mx-auto">
                Your RMA and repair management system is ready. This quick setup takes about 2 minutes.
              </p>
              <div className="mt-6 grid grid-cols-3 gap-3 text-left">
                {[
                  { icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z', label: 'Manage customers' },
                  { icon: 'M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z', label: 'Track RMA tickets' },
                  { icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z', label: 'Reports & analytics' },
                ].map(({ icon, label }) => (
                  <div key={label} className="bg-[#f8f9fb] dark:bg-[#0f1520] rounded-xl p-3 text-center">
                    <svg className="w-5 h-5 text-[#4338ca] dark:text-[#a5b4fc] mx-auto mb-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={icon} />
                    </svg>
                    <p className="text-[11px] font-medium text-[#211f1b] dark:text-[#e8ebf0]">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 2: Branding ── */}
          {step === 2 && (
            <div>
              <div className="w-12 h-12 rounded-xl bg-[#fdf4ff] dark:bg-[#1e1040] flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-purple-600 dark:text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0] mb-1">Set your company name</h2>
              <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] mb-4">This appears on emails and PDF reports sent to customers.</p>
              <label className={lbl}>Company Name</label>
              <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="e.g. Acme Repairs Ltd." className={inp} autoFocus />
              <p className="text-xs text-[#a09d99] dark:text-[#4a5568] mt-2">You can set a logo and full branding later in <strong>Control Panel → Branding</strong>.</p>
            </div>
          )}

          {/* ── Step 3: Add Customer ── */}
          {step === 3 && (
            <div>
              <div className="w-12 h-12 rounded-xl bg-[#ecfdf5] dark:bg-[#052e16] flex items-center justify-center mb-4">
                <svg className="w-6 h-6 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-[#211f1b] dark:text-[#e8ebf0] mb-1">Add your first customer</h2>
              <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] mb-4">Customers are linked to RMA tickets. Add one to get started.</p>
              <div className="space-y-3">
                <div><label className={lbl}>Name <span className="text-red-500">*</span></label><input value={custName} onChange={(e) => setCustName(e.target.value)} placeholder="Customer or company name" className={inp} autoFocus /></div>
                <div><label className={lbl}>Email</label><input type="email" value={custEmail} onChange={(e) => setCustEmail(e.target.value)} placeholder="customer@email.com" className={inp} /></div>
                <div><label className={lbl}>Phone</label><input value={custPhone} onChange={(e) => setCustPhone(e.target.value)} placeholder="+1 555 000 0000" className={inp} /></div>
              </div>
            </div>
          )}

          {/* ── Step 4: First Ticket ── */}
          {step === 4 && (
            <div className="text-center py-4">
              <div className="w-16 h-16 rounded-2xl bg-[#fff7ed] dark:bg-[#1c0e00] flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-orange-500 dark:text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-[#211f1b] dark:text-[#e8ebf0] mb-2">Create your first RMA ticket</h2>
              <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] max-w-xs mx-auto mb-6">
                Tickets track every repair job from intake to resolution.
                {savedCust && <span className="block mt-1 font-medium text-[#211f1b] dark:text-[#e8ebf0]">{savedCust.contact_person || custName} is ready to be linked.</span>}
              </p>
              <button onClick={goToTickets}
                className="w-full py-2.5 rounded-xl bg-[#4338ca] hover:bg-[#3730a3] text-white text-sm font-semibold transition-colors">
                Go to RMA Tickets
              </button>
            </div>
          )}

          {/* ── Step 5: Done ── */}
          {step === 5 && (
            <div className="text-center py-4">
              <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-xl font-bold text-[#211f1b] dark:text-[#e8ebf0] mb-2">You're all set!</h2>
              <p className="text-sm text-[#6c6760] dark:text-[#9aa4b2] max-w-xs mx-auto mb-5">myRMA is configured and ready to use. Explore the sidebar to discover everything it can do.</p>
              <div className="text-left space-y-2 mb-6">
                {[
                  companyName ? `Company name set: ${companyName}` : null,
                  savedCust ? `Customer added: ${savedCust.contact_person || custName}` : null,
                  'RMA Tickets ready to create',
                  'Reports & analytics available',
                ].filter(Boolean).map((item) => (
                  <div key={item} className="flex items-center gap-2 text-sm text-[#211f1b] dark:text-[#e8ebf0]">
                    <div className="w-4 h-4 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center flex-shrink-0">
                      <svg className="w-2.5 h-2.5 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    </div>
                    {item}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Navigation ── */}
          <div className={`flex items-center gap-3 mt-6 ${step === 1 ? 'justify-end' : 'justify-between'}`}>
            {step > 1 && step < TOTAL && (
              <button onClick={() => setStep((s) => s - 1)}
                className="text-sm text-[#6c6760] dark:text-[#9aa4b2] hover:text-[#211f1b] dark:hover:text-[#e8ebf0] transition-colors">
                ← Back
              </button>
            )}
            {step < TOTAL && step !== 4 && (
              <div className="flex items-center gap-2 ml-auto">
                <button onClick={next} className="text-xs text-[#a09d99] dark:text-[#4a5568] hover:underline">Skip</button>
                <button
                  onClick={step === 2 ? saveBranding : step === 3 ? saveCustomer : next}
                  disabled={savingBranding || savingCust}
                  className="px-5 py-2 rounded-xl bg-[#4338ca] hover:bg-[#3730a3] disabled:opacity-50 text-white text-sm font-semibold transition-colors"
                >
                  {savingBranding || savingCust ? 'Saving…' : step === TOTAL - 1 ? 'Continue →' : 'Next →'}
                </button>
              </div>
            )}
            {step === 4 && (
              <button onClick={next} className="text-xs text-[#a09d99] dark:text-[#4a5568] hover:underline ml-auto">Skip for now</button>
            )}
            {step === TOTAL && (
              <button onClick={finish}
                className="w-full py-2.5 rounded-xl bg-[#4338ca] hover:bg-[#3730a3] text-white text-sm font-semibold transition-colors">
                Start using myRMA
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
