import React, { useEffect, useRef } from 'react'
import QRCode from 'qrcode'

export default function PrintLabel({ ticket, onClose }) {
  const qrRef = useRef(null)

  useEffect(() => {
    if (qrRef.current && ticket) {
      QRCode.toCanvas(qrRef.current, ticket.rma_number, {
        width: 150,
        margin: 1
      })
    }
  }, [ticket])

  const handlePrint = () => {
    window.print()
  }

  if (!ticket) return null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-xl max-w-4xl w-full p-6">
        <div className="flex items-center justify-between mb-6 no-print">
          <h2 className="text-2xl font-bold text-gray-900">Print RMA Label</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-600">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="print-content border-4 border-gray-800 p-8 rounded-lg">
          <div className="text-center mb-6">
            <h1 className="text-4xl font-bold text-gray-900 mb-2">RMA LABEL</h1>
            <div className="text-6xl font-bold text-indigo-600 mb-4">{ticket.rma_number}</div>
          </div>

          <div className="grid grid-cols-2 gap-8 mb-6">
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-3 border-b-2 border-gray-300 pb-2">CUSTOMER INFO</h3>
              <div className="space-y-2">
                <div>
                  <p className="text-sm text-gray-600">Customer Name:</p>
                  <p className="text-lg font-semibold text-gray-900">{ticket.customer_name}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Created Date:</p>
                  <p className="text-lg font-semibold text-gray-900">{new Date(ticket.created_date).toLocaleDateString()}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Priority:</p>
                  <p className="text-lg font-semibold text-gray-900">{ticket.priority}</p>
                </div>
              </div>
            </div>

            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-3 border-b-2 border-gray-300 pb-2">TICKET INFO</h3>
              <div className="space-y-2">
                <div>
                  <p className="text-sm text-gray-600">Status:</p>
                  <p className="text-lg font-semibold text-gray-900">{ticket.ticket_status}</p>
                </div>
                <div>
                  <p className="text-sm text-gray-600">Technician:</p>
                  <p className="text-lg font-semibold text-gray-900">{ticket.assigned_technician || 'Unassigned'}</p>
                </div>
                {ticket.due_date && (
                  <div>
                    <p className="text-sm text-gray-600">Due Date:</p>
                    <p className="text-lg font-semibold text-gray-900">{new Date(ticket.due_date).toLocaleDateString()}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="mb-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-3 border-b-2 border-gray-300 pb-2">PRODUCTS</h3>
            <div className="space-y-2">
              {Array.isArray(ticket.products) && ticket.products.length > 0 ? (
                ticket.products.map((product, idx) => (
                  <div key={idx} className="bg-gray-50 p-3 rounded">
                    <p className="font-semibold text-gray-900">{product.product_name}</p>
                    {product.serial_number && (
                      <p className="text-sm text-gray-600">Serial: {product.serial_number}</p>
                    )}
                    <p className="text-sm text-gray-600">Status: {product.product_status}</p>
                  </div>
                ))
              ) : (
                <p className="text-gray-500">No products</p>
              )}
            </div>
          </div>

          <div className="flex justify-center border-t-2 border-gray-300 pt-6">
            <div className="text-center">
              <canvas ref={qrRef} className="mx-auto mb-2"></canvas>
              <p className="text-sm text-gray-600">Scan for details</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3 justify-end mt-6 no-print">
          <button onClick={onClose} className="px-4 py-2 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50">
            Cancel
          </button>
          <button onClick={handlePrint} className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Print Label
          </button>
        </div>
      </div>

      <style jsx>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .print-content, .print-content * {
            visibility: visible;
          }
          .print-content {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
          }
          .no-print {
            display: none !important;
          }
        }
      `}</style>
    </div>
  )
}