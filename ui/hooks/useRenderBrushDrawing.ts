'use client'

import type { RefObject } from 'react'

import { useCanvasDrawing, type CanvasDims } from '@/hooks/useCanvasDrawing'
import type { PointerToDocumentFn } from '@/hooks/usePointerToDocument'
import { putMask } from '@/lib/api/default/default'
import type { Page } from '@/lib/api/schemas'
import { invalidateScene } from '@/lib/io/scene'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import type { ToolMode } from '@/lib/types'

type RenderBrushOptions = {
  mode: ToolMode
  page: Page | null
  pointerToDocument: PointerToDocumentFn
  enabled: boolean
  action: 'paint' | 'erase'
  targetCanvasRef?: RefObject<HTMLCanvasElement | null>
}

function pngBytesToBlob(bytes: Uint8Array): Blob {
  return new Blob([bytes as unknown as BlobPart], { type: 'image/png' })
}

/**
 * Color-brush over the `Mask { role: brushInpaint }` node. Stroke finalize
 * PUTs the updated mask to `/api/v1/pages/{id}/masks/brushInpaint`.
 */
export function useRenderBrushDrawing({
  page,
  pointerToDocument,
  enabled,
  action,
  targetCanvasRef,
}: RenderBrushOptions) {
  const isErasing = action === 'erase'
  const brushSize = usePreferencesStore((state) => state.brushConfig.size)
  const brushColor = usePreferencesStore((state) => state.brushConfig.color)
  const dims: CanvasDims | null = page
    ? { width: page.width, height: page.height, key: page.id }
    : null

  return useCanvasDrawing(dims, pointerToDocument, {
    getColor: () => (isErasing ? '#000000' : brushColor),
    blendMode: isErasing ? 'destination-out' : 'source-over',
    getBrushSize: () => brushSize,
    enabled,
    targetCanvasRef,
    clearAfterStroke: true,
    onFinalize: async () => {},
    onFinalizeFullCanvas: async (fullPng) => {
      if (!page) return
      try {
        await putMask(page.id, 'brushInpaint', pngBytesToBlob(fullPng))
        await invalidateScene()
        useEditorUiStore.getState().setShowBrushLayer(true)
      } catch (e) {
        useEditorUiStore.getState().showError(e instanceof Error ? e.message : String(e))
      }
    },
  })
}
