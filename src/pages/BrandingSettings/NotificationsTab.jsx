import { Button } from '../../components/ui'

export default function NotificationsTab({ preferences, setPreferences, saving, onSave }) {
  const notifications = [
    {
      key: 'ticket_created',
      label: 'Ticket Created',
      description: 'Notify when a new RMA ticket is created',
    },
    {
      key: 'ticket_assigned',
      label: 'Ticket Assigned',
      description: 'Notify when a ticket is assigned to you',
    },
    {
      key: 'ticket_status_changed',
      label: 'Status Changed',
      description: 'Notify when ticket status is updated',
    },
    {
      key: 'ticket_priority_changed',
      label: 'Priority Changed',
      description: 'Notify when ticket priority is updated',
    },
    {
      key: 'comment_added',
      label: 'Comment Added',
      description: 'Notify when someone comments on your tickets',
    },
    {
      key: 'ticket_due_soon',
      label: 'Ticket Due Soon',
      description: 'Notify 24 hours before ticket due date',
    },
    {
      key: 'ticket_overdue',
      label: 'Ticket Overdue',
      description: 'Notify when a ticket becomes overdue',
    },
    {
      key: 'daily_summary',
      label: 'Daily Summary',
      description: 'Receive daily summary of your tickets',
    },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Email Notification Preferences</h3>
        <p className="text-sm text-gray-600">
          Choose which email notifications you want to receive
        </p>
      </div>

      <div className="space-y-4">
        {notifications.map((notif) => (
          <label
            key={notif.key}
            className="flex items-start gap-4 p-4 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer"
          >
            <input
              type="checkbox"
              checked={preferences[notif.key]}
              onChange={(e) => setPreferences({ ...preferences, [notif.key]: e.target.checked })}
              className="w-5 h-5 text-indigo-600 rounded focus:ring-2 focus:ring-indigo-600 mt-1"
            />
            <div className="flex-1">
              <p className="font-medium text-gray-900">{notif.label}</p>
              <p className="text-sm text-gray-600">{notif.description}</p>
            </div>
          </label>
        ))}
      </div>

      <div className="flex justify-end pt-6 border-t">
        <Button size="lg" loading={saving} onClick={onSave}>
          Save Preferences
        </Button>
      </div>
    </div>
  )
}
