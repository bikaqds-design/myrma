import React, { useEffect, useRef, useState } from 'react'

const FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'data_matrix']

export default function BarcodeScanner({ onScan, onClose }) {
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const animRef = useRef(null)
  const [error, setError] = useState(null)
  const supported = 'BarcodeDetector' in window

  useEffect(() => {
    if (!supported) return

    let active = true
    let detector

    const start = async () => {
      try {
        detector = new window.BarcodeDetector({ formats: FORMATS })
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
        })
        if (!active) { stream.getTracks().forEach((t) => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) { videoRef.current.srcObject = stream; videoRef.current.play() }
        scan()
      } catch (e) {
        if (!active) return
        setError(e.name === 'NotAllowedError'
          ? 'Camera permission denied. Allow camera access and try again.'
          : 'Could not start camera: ' + e.message)
      }
    }

    const scan = async () => {
      if (!active) return
      if (videoRef.current?.readyState >= 2) {
        try {
          const found = await detector.detect(videoRef.current)
          if (found.length > 0) { onScan(found[0].rawValue); return }
        } catch { /* detection error — keep looping */ }
      }
      animRef.current = requestAnimationFrame(scan)
    }

    start()
    return () => {
      active = false
      cancelAnimationFrame(animRef.current)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [supported, onScan])

  return (
    <div className="fixed inset-0 z-[400] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/80" onClick={onClose} />
      <div className="relative w-full max-w-sm bg-[#121823] rounded-2xl overflow-hidden shadow-2xl border border-[#212a38]">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#212a38]">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-[#a5b4fc]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h2v2H4zm0 5h2v2H4zm0 5h2v2H4zm5-10h2v2H9zm0 5h2v2H9zm0 5h2v2H9zm5-10h6v2h-6zm0 5h6v2h-6zm0 5h6v2h-6z" />
            </svg>
            <span className="text-sm font-semibold text-[#e8ebf0]">Scan Barcode</span>
          </div>
          <button onClick={onClose} aria-label="Close scanner"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-[#9aa4b2] hover:text-[#e8ebf0] hover:bg-[#1a2230] transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        {!supported ? (
          <div className="p-6 text-center">
            <div className="w-12 h-12 rounded-2xl bg-amber-900/30 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
              </svg>
            </div>
            <p className="text-sm font-semibold text-[#e8ebf0] mb-1">Browser not supported</p>
            <p className="text-xs text-[#9aa4b2] max-w-xs mx-auto">
              Barcode scanning requires Chrome or Edge. Use a supported browser or type the value manually.
            </p>
          </div>
        ) : error ? (
          <div className="p-6 text-center">
            <p className="text-sm text-red-400">{error}</p>
            <button onClick={onClose} className="mt-4 text-xs text-[#a5b4fc] hover:underline">Close</button>
          </div>
        ) : (
          <>
            <div className="relative bg-black" style={{ aspectRatio: '4/3' }}>
              <video ref={videoRef} className="w-full h-full object-cover" muted playsInline />
              {/* Viewfinder overlay */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="w-52 h-36 relative">
                  <div className="absolute inset-0 border border-[#a5b4fc]/30 rounded-lg" />
                  <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-[#a5b4fc] rounded-tl-lg" />
                  <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-[#a5b4fc] rounded-tr-lg" />
                  <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-[#a5b4fc] rounded-bl-lg" />
                  <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-[#a5b4fc] rounded-br-lg" />
                  <div className="absolute inset-x-2 top-1/2 -translate-y-1/2 h-px bg-[#a5b4fc]/50 animate-pulse" />
                </div>
              </div>
            </div>
            <p className="text-center text-xs text-[#9aa4b2] py-3">Point camera at a barcode or QR code</p>
          </>
        )}
      </div>
    </div>
  )
}
