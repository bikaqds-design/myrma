import React, { useEffect, useRef, useState } from 'react'

const FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix']

// Barcode icon using rect elements (path-based icons render as ⋮)
export const BarcodeIcon = ({ className = 'w-4 h-4' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <rect x="2"  y="3" width="2" height="18" rx="0.5" />
    <rect x="6"  y="3" width="1" height="18" rx="0.5" />
    <rect x="9"  y="3" width="2" height="18" rx="0.5" />
    <rect x="13" y="3" width="1" height="18" rx="0.5" />
    <rect x="16" y="3" width="3" height="18" rx="0.5" />
    <rect x="21" y="3" width="1" height="18" rx="0.5" />
  </svg>
)

const cameraSupported = 'BarcodeDetector' in window

export default function BarcodeScanner({ onScan, onClose }) {
  // ── Camera mode (Android / desktop with BarcodeDetector) ──────────────────
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const animRef = useRef(null)
  const [camError, setCamError] = useState(null)

  // ── USB / manual mode ─────────────────────────────────────────────────────
  const usbInputRef = useRef(null)
  const [manualValue, setManualValue] = useState('')

  useEffect(() => {
    if (!cameraSupported) {
      setTimeout(() => usbInputRef.current?.focus(), 80)
      return
    }
    let active = true
    const start = async () => {
      try {
        const detector = new window.BarcodeDetector({ formats: FORMATS })
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        })
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play() }
        const scan = async () => {
          if (!active) return
          if (videoRef.current?.readyState >= 2) {
            try {
              const found = await detector.detect(videoRef.current)
              if (found.length > 0) { onScan(found[0].rawValue); return }
            } catch { /* keep looping */ }
          }
          animRef.current = requestAnimationFrame(scan)
        }
        scan()
      } catch (e) {
        if (!active) return
        setCamError(e.name === 'NotAllowedError'
          ? 'Camera permission denied. Use USB mode instead.'
          : 'Could not start camera: ' + e.message)
      }
    }
    start()
    return () => {
      active = false
      cancelAnimationFrame(animRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [onScan])

  const submitManual = () => {
    const v = manualValue.trim()
    if (v) onScan(v)
  }

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-[#121823] rounded-2xl overflow-hidden shadow-2xl border border-[#212a38]">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#212a38]">
          <div className="flex items-center gap-2">
            <BarcodeIcon className="w-4 h-4 text-[#a5b4fc]" />
            <span className="text-sm font-semibold text-[#e8ebf0]">
              {cameraSupported ? 'Scan Barcode' : 'USB / Manual Scan'}
            </span>
          </div>
          <button onClick={onClose} aria-label="Close"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-[#9aa4b2] hover:text-[#e8ebf0] hover:bg-[#1a2230] transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Camera mode */}
        {cameraSupported && !camError && (
          <>
            <div className="relative bg-black" style={{ aspectRatio: '4/3' }}>
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-52 h-36 relative">
                  <div className="absolute inset-0 border border-[#a5b4fc]/30 rounded-lg" />
                  <div className="absolute top-0 start-0 w-6 h-6 border-t-2 border-l-2 border-[#a5b4fc] rounded-tl-lg" />
                  <div className="absolute top-0 end-0 w-6 h-6 border-t-2 border-r-2 border-[#a5b4fc] rounded-tr-lg" />
                  <div className="absolute bottom-0 start-0 w-6 h-6 border-b-2 border-l-2 border-[#a5b4fc] rounded-bl-lg" />
                  <div className="absolute bottom-0 end-0 w-6 h-6 border-b-2 border-r-2 border-[#a5b4fc] rounded-br-lg" />
                  <div className="absolute inset-x-2 top-1/2 -translate-y-1/2 h-px bg-[#a5b4fc]/50 animate-pulse" />
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-[#9aa4b2] py-3">Point camera at a barcode or QR code</p>
          </>
        )}

        {/* Camera error fallback → show USB mode */}
        {cameraSupported && camError && (
          <div className="px-5 pt-4 pb-2">
            <p className="text-xs text-amber-400 mb-3 text-center">{camError}</p>
          </div>
        )}

        {/* USB / manual input mode */}
        {(!cameraSupported || camError) && (
          <div className="px-5 py-5">
            <p className="text-xs text-[#9aa4b2] mb-3 text-center">
              Focus the field below, then scan with your USB barcode scanner — or type manually.
            </p>
            <input
              ref={usbInputRef}
              value={manualValue}
              onChange={(e) => setManualValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitManual() }}
              placeholder="Scan or type barcode value…"
              className="w-full px-3 py-2 rounded-lg bg-[#0f1520] border border-[#212a38] focus:border-[#a5b4fc] text-sm text-[#e8ebf0] placeholder-[#a4acb7] outline-none transition-colors font-mono tracking-wider"
            />
            <button
              onClick={submitManual}
              disabled={!manualValue.trim()}
              className="mt-3 w-full py-2 rounded-lg bg-[#4338ca] hover:bg-[#3730a3] disabled:opacity-40 text-white text-sm font-medium transition-colors"
            >
              Use this value
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
