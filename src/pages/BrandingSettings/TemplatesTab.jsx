export default function TemplatesTab({ templates, onEdit, onSendTest }) {
  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-2">Email Templates</h3>
        <p className="text-sm text-gray-600">Customize email notification templates</p>
      </div>

      <div className="space-y-4">
        {templates.map((template) => (
          <div key={template.id} className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-start justify-between">
              <div className="flex-1">
                <h4 className="font-medium text-gray-900">
                  {template.template_name.replace(/_/g, ' ').toUpperCase()}
                </h4>
                <p className="text-sm text-gray-600 mt-1">Subject: {template.template_subject}</p>
                <div className="flex flex-wrap gap-2 mt-2">
                  {template.variables &&
                    template.variables.map((variable) => (
                      <span
                        key={variable}
                        className="px-2 py-1 bg-gray-100 dark:bg-[#1a2230] text-gray-700 dark:text-[#9aa4b2] text-xs rounded"
                      >
                        {`{{${variable}}}`}
                      </span>
                    ))}
                </div>
              </div>
              <div className="flex gap-2 ml-4">
                <button
                  onClick={() => onEdit(template)}
                  className="px-3 py-1 text-sm bg-indigo-100 dark:bg-indigo-900/20 text-indigo-700 dark:text-indigo-400 rounded hover:bg-indigo-200 dark:hover:bg-indigo-900/30"
                >
                  Edit
                </button>
                <button
                  onClick={() => onSendTest(template.template_name)}
                  className="px-3 py-1 text-sm bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400 rounded hover:bg-green-200 dark:hover:bg-green-900/30"
                >
                  Test
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
