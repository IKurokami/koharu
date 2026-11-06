'use client'

import { EyeIcon, EyeOffIcon, XIcon, Loader2Icon } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useBlobImage } from '@/hooks/useBlobData'
import { findImageBlob } from '@/hooks/useCurrentPage'
import { useScene } from '@/hooks/useScene'
import type { Page } from '@/lib/api/schemas'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useSelectionStore } from '@/lib/stores/selectionStore'

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
        className='flex h-[100vh] w-full max-w-[100vw] flex-col gap-0 rounded-none border-none bg-background/95 p-0 backdrop-blur-md transition-all duration-300'
      >
        {/* Sleek, Premium Sticky Header */}
        <div className='sticky top-0 z-50 flex h-14 items-center justify-between border-b border-border/40 bg-background/60 px-6 backdrop-blur-xl select-none'>
          <div className='flex min-w-0 flex-col'>
            <DialogTitle className='truncate text-sm font-semibold tracking-tight text-foreground'>
              {scene?.project?.name || t('webtoon.projectFallback')} — {activeChapterName}
            </DialogTitle>
            <p className='text-[10px] font-medium tracking-wider text-muted-foreground uppercase'>
              {t('webtoon.preview')} • {t('navigator.pages', { count: pages.length })}
            </p>
          </div>

          {/* Mode Switch Segmented Controls */}
          <div className='flex items-center gap-1.5 rounded-full border border-border/20 bg-secondary/80 p-0.5 shadow-inner'>
            <button
              onClick={() => setMode('translated')}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition-all duration-200 ${
                mode === 'translated'
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-black/5'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <EyeIcon className='h-3.5 w-3.5' />
              {t('canvas.showRenderedImage')}
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
              {t('canvas.showInpaintedImage')}
            </button>
          </div>

          {/* Close button with subtle hover micro-animations */}
          <button
            onClick={() => setOpen(false)}
            aria-label={t('common.close')}
            className='hover:text-destructive-foreground flex size-8 items-center justify-center rounded-full border border-border/40 bg-background/50 transition-all duration-200 hover:scale-105 hover:bg-destructive active:scale-95'
          >
            <XIcon className='h-4 w-4' />
          </button>
        </div>

        {/* Continuous single vertical long page container */}
        <div className='m-0 flex flex-1 flex-col items-center justify-start overflow-y-auto scroll-smooth bg-black/40 p-0'>
          <div className='m-0 flex w-full max-w-[800px] flex-col space-y-0 border-none bg-background p-0 shadow-none'>
            {pages.length === 0 ? (
              <div className='flex flex-col items-center justify-center gap-2 py-20 text-center text-muted-foreground'>
                <EyeOffIcon className='h-10 w-10 text-muted-foreground/40' />
                <p className='text-sm font-medium'>{t('webtoon.noPages')}</p>
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
  const { t } = useTranslation()
  // Try to find the rendered (translated) blob. Fall back to source if translated is unavailable
  const renderedHash = findImageBlob(page, 'rendered')
  const sourceHash = findImageBlob(page, 'source')
  const targetHash = mode === 'translated' ? renderedHash || sourceHash : sourceHash

  const { data: imageUrl, isLoading, isError } = useBlobImage(targetHash ?? undefined)

  return (
    <div
      className='relative m-0 w-full border-none bg-background p-0 shadow-none select-none'
      style={{
        aspectRatio: page.width && page.height ? `${page.width} / ${page.height}` : 'auto',
      }}
    >
      {isLoading && (
        <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 border-none bg-secondary/20 shadow-none'>
          <Loader2Icon className='h-6 w-6 animate-spin text-primary' />
          <p className='text-[10px] font-semibold tracking-wider text-muted-foreground uppercase'>
            {t('webtoon.loadingPage', { number: index + 1 })}
          </p>
        </div>
      )}

      {isError && (
        <div className='absolute inset-0 flex flex-col items-center justify-center gap-2 border-none bg-destructive/10 text-destructive shadow-none'>
          <p className='text-xs font-semibold'>
            {t('webtoon.failedLoadPage', { number: index + 1 })}
          </p>
        </div>
      )}

      {imageUrl && (
        <img
          src={imageUrl}
          alt={page.name || t('navigator.pageLabel', { number: index + 1 })}
          loading='lazy'
          draggable={false}
          className='m-0 block h-auto w-full border-none p-0 shadow-none'
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
