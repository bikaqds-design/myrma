import { useState } from 'react'
import { Button, Input } from '../../components/ui'

export default function EmailSettingsTab({ settings, setSettings, saving, onSave }) {
  const [showApiKey, setShowApiKey] = useState(false)

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Email Service Configuration</h3>
        <p className="text-sm text-gray-600">
          Configure your email service provider to send notifications
        </p>
      </div>

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <div className="flex gap-3">
          <svg
            className="w-5 h-5 text-blue-600 flex-shrink-0 mt-0.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <div>
            <p className="text-sm font-medium text-blue-900">Get your Resend API Key</p>
            <p className="text-xs text-blue-700 mt-1">
              1. Sign up at{' '}
              <a
                href="https://resend.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                resend.com
              </a>
              <br />
              2. Go to API Keys
              <br />
              3. Create a new API key
              <br />
              4. Copy and paste it below
            </p>
          </div>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Email Provider</label>
        <select
          value={settings.provider}
          onChange={(e) => setSettings({ ...settings, provider: e.target.value })}
          className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent"
        >
          <option value="resend">Resend</option>
        </select>
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">Resend API Key *</label>
        <div className="relative">
          <Input
            type={showApiKey ? 'text' : 'password'}
            value={settings.api_key}
            onChange={(e) => setSettings({ ...settings, api_key: e.target.value })}
            className="pr-12 font-mono"
            placeholder="re_xxxxxxxxxxxxxxxxxxxx"
          />
          <button
            type="button"
            onClick={() => setShowApiKey(!showApiKey)}
            aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700"
          >
            {showApiKey ? '🙈' : '👁️'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          Your API key is stored securely and never exposed to the frontend
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">From Email *</label>
          <Input
            type="email"
            value={settings.from_email}
            onChange={(e) => setSettings({ ...settings, from_email: e.target.value })}
            placeholder="noreply@yourdomain.com"
          />
          <p className="text-xs text-gray-500 mt-1">Use a verified domain in Resend</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">From Name</label>
          <Input
            type="text"
            value={settings.from_name}
            onChange={(e) => setSettings({ ...settings, from_name: e.target.value })}
            placeholder="myRMA System"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 p-4 border border-gray-200 rounded-lg">
        <input
          type="checkbox"
          id="is_active"
          checked={settings.is_active}
          onChange={(e) => setSettings({ ...settings, is_active: e.target.checked })}
          className="w-5 h-5 text-indigo-600 rounded focus:ring-2 focus:ring-indigo-600"
        />
        <label htmlFor="is_active" className="flex-1 cursor-pointer">
          <p className="font-medium text-gray-900">Enable Email Notifications</p>
          <p className="text-sm text-gray-600">Start sending automated email notifications</p>
        </label>
      </div>

      <div className="flex justify-end pt-6 border-t">
        <Button size="lg" loading={saving} onClick={onSave}>
          Save Settings
        </Button>
      </div>
    </div>
  )
}
