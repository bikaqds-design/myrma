import { Button, Input } from '../../components/ui'

export default function TemplateModal({ template, onTemplateChange, saving, onSave, onClose }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-4xl p-6 m-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-bold text-gray-900">Edit Email Template</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Template Name</label>
            <Input type="text" value={template.template_name} disabled />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Email Subject</label>
            <Input
              type="text"
              value={template.template_subject}
              onChange={(e) => onTemplateChange({ ...template, template_subject: e.target.value })}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">Email Body</label>
            <textarea
              value={template.template_body}
              onChange={(e) => onTemplateChange({ ...template, template_body: e.target.value })}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-600 focus:border-transparent font-mono text-sm"
              rows="15"
            />
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h4 className="font-medium text-blue-900 mb-2">Available Variables:</h4>
            <div className="flex flex-wrap gap-2">
              {template.variables &&
                template.variables.map((variable) => (
                  <code
                    key={variable}
                    className="px-2 py-1 bg-white text-blue-700 text-xs rounded border border-blue-200"
                  >
                    {`{{${variable}}}`}
                  </code>
                ))}
            </div>
            <p className="text-xs text-blue-700 mt-2">
              Use these variables in your subject and body. They will be replaced with actual values
              when sending emails.
            </p>
          </div>

          <div className="flex gap-3 pt-6 border-t">
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={saving} className="flex-1" onClick={onSave}>
              Save Template
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
