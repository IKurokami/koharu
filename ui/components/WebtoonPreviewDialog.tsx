'use client'

import { useMemo, useState } from 'react'
import { EyeIcon, EyeOffIcon, XIcon, Loader2Icon } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useScene } from '@/hooks/useScene'
import { useSelectionStore } from '@/lib/stores/selectionStore'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useBlobImage } from '@/hooks/useBlobData'
import { findImageBlob } from '@/hooks/useCurrentPage'
import type { Page } from '@/lib/api/schemas'

export function WebtoonPreviewDialog() {
  const { t } = useTranslation()
  const { scene } = useScene()
  const chapterId = useSelectionStore((s) => s.chapterId)
  const open = useEditorUiStore((s) => s.webtoonPreviewOpen)
  const setOpen = useEditorUiStore((s) => s.setWebtoonPreviewOpen)

  const [mode, setMode] = useState<'translated' | 'original'>('translated')

  // Find the active chapter name
  const activeChapterName = useMemo(() => {
    if (!scene) return ''
    const chaptersMap = (scene as any)?.chapters
    if (!chaptersMap || !chapterId) return t('navigator.allChapters')
    const chapter = chaptersMap[chapterId]
    return chapter ? chapter.name : t('navigator.allChapters')
  }, [scene, chapterId, t])

  // Get pages belonging to the current chapter/selection
  const pages = useMemo(() => {
    if (!scene?.pages) return []
    const all = Object.values(scene.pages)
    if (!chapterId || chapterId === 'all-chapters') return all
    return all.filter((p: any) => p.chapterId === chapterId)
  }, [scene, chapterId])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        data-testid='webtoon-preview-dialog'
        className='flex max-w-[100vw] h-[100vh] w-full p-0 flex-col gap-0 border-none rounded-none bg-background/95 backdrop-blur-md transition-all duration-300'
      >
        {/* Sleek, Premium Sticky Header */}
        <div className='flex h-14 items-center justify-between px-6 border-b border-border/40 bg-background/60 backdrop-blur-xl sticky top-0 z-50 select-none'>
          <div className='flex flex-col min-w-0'>
            <DialogTitle className='text-sm font-semibold tracking-tight text-foreground truncate'>
              {scene?.project?.name || 'Project'} — {activeChapterName}
            </DialogTitle>
            <p className='text-[10px] text-muted-foreground font-medium uppercase tracking-wider'>
              Webtoon Preview • {pages.length} {t('navigator.totalPages', { count: pages.length })}
            </p>
          </div>

          {/* Mode Switch Segmented Controls */}
          <div className='flex items-center gap-1.5 rounded-full bg-secondary/80 p-0.5 border border-border/20 shadow-inner'>
            <button
              onClick={() => setMode('translated')}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-all duration-200 ${
                mode === 'translated'
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <EyeIcon className='h-3.5 w-3.5' />
              {t('canvas.showRenderedImage') || 'Bản dịch'}
            </button>
            <button
              onClick={() => setMode('original')}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-all duration-200 ${
                mode === 'original'
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <EyeOffIcon className='h-3.5 w-3.5' />
              {t('canvas.showInpaintedImage') || 'Ảnh gốc'}
            </button>
          </div>

          {/* Close button with subtle hover micro-animations */}
          <button
            onClick={() => setOpen(false)}
            className='flex size-8 items-center justify-center rounded-full border border-border/40 bg-background/50 hover:bg-destructive hover:text-destructive-foreground transition-all duration-200 hover:scale-105 active:scale-95'
          >
            <XIcon className='h-4 w-4' />
          </button>
        </div>

        {/* Continuous single vertical long page container */}
        <div className='flex-1 overflow-y-auto bg-black/40 flex flex-col items-center justify-start scroll-smooth p-0 m-0'>
          <div className='w-full max-w-[800px] flex flex-col p-0 m-0 bg-background border-none shadow-none space-y-0'>
            {pages.length === 0 ? (
              <div className='flex flex-col items-center justify-center py-20 text-center text-muted-foreground gap-2'>
                <EyeOffIcon className='h-10 w-10 text-muted-foreground/40' />
                <p className='text-sm font-medium'>No pages found in this chapter</p>
              </div>
            ) : (
              pages.map((page, idx) => (
                <WebtoonPage key={page.id} page={page} mode={mode} index={idx} />
              ))
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function WebtoonPage({
  page,
  mode,
  index,
}: {
  page: Page
  mode: 'translated' | 'original'
  index: number
}) {
  // Try to find the rendered (translated) blob. Fall back to source if translated is unavailable
  const renderedHash = findImageBlob(page, 'rendered')
  const sourceHash = findImageBlob(page, 'source')
  const targetHash = mode === 'translated' ? (renderedHash || sourceHash) : sourceHash

  const { data: imageUrl, isLoading, isError } = useBlobImage(targetHash ?? undefined)

  return (
    <div
      className='w-full relative select-none p-0 m-0 border-none shadow-none bg-background'
      style={{
        aspectRatio: page.width && page.height ? `${page.width} / ${page.height}` : 'auto',
      }}
    >
      {isLoading && (
        <div className='absolute inset-0 flex flex-col items-center justify-center bg-secondary/20 gap-3 border-none shadow-none'>
          <Loader2Icon className='h-6 w-6 animate-spin text-primary' />
          <p className='text-[10px] text-muted-foreground font-semibold uppercase tracking-wider'>
            Loading Page {index + 1}...
          </p>
        </div>
      )}

      {isError && (
        <div className='absolute inset-0 flex flex-col items-center justify-center bg-destructive/10 text-destructive gap-2 border-none shadow-none'>
          <p className='text-xs font-semibold'>Failed to load page {index + 1}</p>
        </div>
      )}

      {imageUrl && (
        <img
          src={imageUrl}
          alt={page.name || `Page ${index + 1}`}
          loading='lazy'
          draggable={false}
          className='w-full h-auto block border-none p-0 m-0 shadow-none'
          style={{
            display: 'block',
            margin: 0,
            padding: 0,
            border: 'none',
          }}
        />
      )}
    </div>
  )
}
