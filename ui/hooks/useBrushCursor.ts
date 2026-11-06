'use client'

import { useEffect, useMemo, useRef } from 'react'
import type React from 'react'

import { usePreferencesStore } from '@/lib/stores/preferencesStore'

export function useBrushCursor(
  canvasRef: React.RefObject<HTMLDivElement | null>,
  mode: string,
  pageKey?: string,
) {
  const brushCursorRef = useRef<HTMLDivElement>(null)
  const cachedRectRef = useRef<DOMRect | null>(null)
  const mousePosRef = useRef<{ x: number; y: number } | null>(null)
  const isInsideRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  const brushSize = usePreferencesStore((state) => state.brushConfig.size)

  const isBrushMode = useMemo(
    () => mode === 'brush' || mode === 'repairBrush' || mode === 'eraser',
    [mode],
  )

  const isBrushModeRef = useRef(isBrushMode)
  useEffect(() => {
    isBrushModeRef.current = isBrushMode
  }, [isBrushMode])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const updateCursorPosition = (clientX: number, clientY: number) => {
      if (!brushCursorRef.current) return
      const rect = cachedRectRef.current || canvas.getBoundingClientRect()
      if (!cachedRectRef.current) cachedRectRef.current = rect
      const x = clientX - rect.left
      const y = clientY - rect.top
      brushCursorRef.current.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
    }

    const cancelScheduledUpdate = () => {
      if (rafRef.current === null) return
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }

    const scheduleCursorPosition = () => {
      if (rafRef.current !== null) return
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null
        const point = mousePosRef.current
        if (!point || !isBrushModeRef.current || !isInsideRef.current) return
        updateCursorPosition(point.x, point.y)
      })
    }

    const refresh = () => {
      cachedRectRef.current = canvas.getBoundingClientRect()
      if (mousePosRef.current && isBrushModeRef.current && isInsideRef.current) {
        scheduleCursorPosition()
      }
    }

    const handleMove = (e: PointerEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY }
      if (!isBrushModeRef.current || !isInsideRef.current) return
      scheduleCursorPosition()
    }

    const handleEnter = (e: PointerEvent) => {
      isInsideRef.current = true
      mousePosRef.current = { x: e.clientX, y: e.clientY }
      refresh()
      if (isBrushModeRef.current && brushCursorRef.current) {
        brushCursorRef.current.style.opacity = '1'
      }
    }

    const handleLeave = () => {
      isInsideRef.current = false
      cancelScheduledUpdate()
      if (brushCursorRef.current) {
        brushCursorRef.current.style.opacity = '0'
      }
    }

    const resizeObserver = new ResizeObserver(() => refresh())
    resizeObserver.observe(canvas)

    canvas.addEventListener('pointermove', handleMove)
    canvas.addEventListener('pointerenter', handleEnter)
    canvas.addEventListener('pointerleave', handleLeave)
    window.addEventListener('scroll', refresh, true)
    window.addEventListener('resize', refresh)

    // Initial positioning if we already have a mouse position
    if (mousePosRef.current && isBrushModeRef.current && isInsideRef.current) {
      scheduleCursorPosition()
    }

    return () => {
      cancelScheduledUpdate()
      resizeObserver.disconnect()
      canvas.removeEventListener('pointermove', handleMove)
      canvas.removeEventListener('pointerenter', handleEnter)
      canvas.removeEventListener('pointerleave', handleLeave)
      window.removeEventListener('scroll', refresh, true)
      window.removeEventListener('resize', refresh)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef, pageKey])

  // Separate effect for visibility to avoid re-attaching listeners
  useEffect(() => {
    const cursor = brushCursorRef.current
    if (!cursor) return

    if (isBrushMode && isInsideRef.current) {
      cursor.style.opacity = '1'
      const canvas = canvasRef.current
      const point = mousePosRef.current
      if (canvas && point) {
        const rect = cachedRectRef.current || canvas.getBoundingClientRect()
        if (!cachedRectRef.current) cachedRectRef.current = rect
        const x = point.x - rect.left
        const y = point.y - rect.top
        cursor.style.transform = `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%)`
      }
    } else {
      cursor.style.opacity = '0'
    }
    // canvasRef is a stable ref object owned by Workspace; keeping this array
    // length fixed avoids React dev warnings during Fast Refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBrushMode])

  return { brushCursorRef, isBrushMode, brushSize }
}
