import { useVirtualizer } from '@tanstack/react-virtual'
import { LayoutGridIcon, PlusIcon, Trash2Icon, CloudDownloadIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DownloadChapterDialog } from '@/components/DownloadChapterDialog'
import { PageManagerDialog } from '@/components/PageManagerDialog'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useScene } from '@/hooks/useScene'
import { getGetPageThumbnailUrl } from '@/lib/api/default/default'
import { importPages } from '@/lib/io/pagesIo'
import { applyOp } from '@/lib/io/scene'
import { ops } from '@/lib/ops'
import { useSelectionStore } from '@/lib/stores/selectionStore'

const THUMBNAIL_DPR =
  typeof window !== 'undefined' ? Math.min(Math.ceil(window.devicePixelRatio || 1), 3) : 2

const ROW_HEIGHT = 230
const OVERSCAN = 5

function getNextChapterName(chapters: any[], defaultName: (number: number) => string): string {
  if (chapters.length === 0) {
    return defaultName(1)
  }
  // Sort by order ascending to get the highest order (latest) chapter
  const sorted = [...chapters].sort((a, b) => (a.order || 0) - (b.order || 0))
  const latest = sorted[sorted.length - 1]
  if (!latest || !latest.name) {
    return defaultName(chapters.length + 1)
  }

  const name = latest.name
  // Match all numbers in the chapter name
  const matches = name.match(/\d+/g)
  if (matches && matches.length > 0) {
    const lastNumStr = matches[matches.length - 1]
    const lastNum = parseInt(lastNumStr, 10)
    const nextNumStr = String(lastNum + 1)
    const lastIndex = name.lastIndexOf(lastNumStr)
    if (lastIndex !== -1) {
      return (
        name.substring(0, lastIndex) + nextNumStr + name.substring(lastIndex + lastNumStr.length)
      )
    }
  }

  // Fallback if no digits were found in the chapter name
  return `${name} 2`
}

export function Navigator() {
  const { scene } = useScene()
  const pagesMap = scene?.pages
  const chapterId = useSelectionStore((s) => s.chapterId)
  const setChapter = useSelectionStore((s) => s.setChapter)

  // Fetch chapters from scene (if any)
  const chapters = useMemo(() => {
    const chaptersMap = (scene as any)?.chapters
    return chaptersMap ? Object.values(chaptersMap) : []
  }, [scene])

  // Filter pages depending on selected chapterId
  const pages = useMemo(() => {
    if (!pagesMap) return []
    const all = Object.values(pagesMap)
    if (!chapterId || chapterId === 'all-chapters') return all
    return all.filter((p: any) => p.chapterId === chapterId)
  }, [pagesMap, chapterId])

  const totalPages = pages.length
  const pageId = useSelectionStore((s) => s.pageId)
  const setPage = useSelectionStore((s) => s.setPage)
  const currentIndex = pages.findIndex((p) => p.id === pageId)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const { t } = useTranslation()
  const [pageManagerOpen, setPageManagerOpen] = useState(false)
  const [hoveredInsertIndex, setHoveredInsertIndex] = useState<number | null>(null)

  // Chapter Creation Dialog State
  const [createOpen, setCreateOpen] = useState(false)
  const [chapterName, setChapterName] = useState('')
  const [downloadChapterOpen, setDownloadChapterOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)

  // Reset chapter selection on project switch
  const currentProjectName = scene?.project?.name
  const lastProjectRef = useRef<string | null>(null)

  useEffect(() => {
    if (currentProjectName && currentProjectName !== lastProjectRef.current) {
      lastProjectRef.current = currentProjectName
      setChapter(null)
    }
  }, [currentProjectName, setChapter])

  // Auto-select latest chapter on first entry
  useEffect(() => {
    if (scene) {
      if (chapters.length > 0) {
        if (chapterId === null) {
          const sorted = [...chapters].sort((a: any, b: any) => (a.order || 0) - (b.order || 0))
          const latest = sorted[sorted.length - 1] as any
          if (latest && latest.id) {
            setChapter(latest.id)
          }
        }
      } else if (chapterId === null) {
        setChapter('all-chapters')
      }
    }
  }, [scene, chapters, chapterId, setChapter])

  // Auto-select first page when pages list changes or when pageId is invalid for the current chapter
  useEffect(() => {
    if (pages.length > 0) {
      const hasValidPage = pages.some((p) => p.id === pageId)
      if (!hasValidPage) {
        setPage(pages[0].id)
      }
    } else {
      setPage(null)
    }
  }, [pages, pageId, setPage])

  const virtualizer = useVirtualizer({
    count: totalPages,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  })

  const handleCreateChapter = async () => {
    const trimmed = chapterName.trim()
    if (!trimmed) return
    const newId = crypto.randomUUID()
    const newChapter = {
      id: newId,
      name: trimmed,
      order: chapters.length + 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      pageIds: [],
    }

    try {
      await applyOp({
        addChapter: {
          chapter: newChapter,
        },
      } as any)
      setChapter(newId)
      setChapterName('')
      setCreateOpen(false)
    } catch (e) {
      console.error('Failed to create chapter:', e)
    }
  }

  const handleOpenCreateDialog = () => {
    const nextName = getNextChapterName(chapters, (number) =>
      t('navigator.defaultChapterName', { number }),
    )
    setChapterName(nextName)
    setCreateOpen(true)
  }

  const handleDeletePage = async (pageToDelete: any, index: number) => {
    try {
      await applyOp(ops.removePage(pageToDelete.id, pageToDelete, index))
      if (pageId === pageToDelete.id) {
        const remaining = pages.filter((p) => p.id !== pageToDelete.id)
        if (remaining.length > 0) {
          setPage(remaining[0].id)
        } else {
          setPage(null)
        }
      }
    } catch (e) {
      console.error('Failed to delete page:', e)
    }
  }

  const handleDeleteChapter = async () => {
    if (!chapterId || chapterId === 'all-chapters') {
      alert(t('navigator.invalidChapterId', { chapterId }))
      return
    }

    const chaptersMap = (scene as any)?.chapters || {}
    const targetChapter = chaptersMap[chapterId]
    if (!targetChapter) {
      alert(
        t('navigator.targetChapterNotFound', {
          chapterId,
          keys: Object.keys(chaptersMap).join(', '),
        }),
      )
      return
    }

    const chapterList = Object.values(chaptersMap)
    const prevIndex = chapterList.findIndex((ch: any) => ch.id === chapterId)
    if (prevIndex === -1) {
      alert(t('navigator.prevIndexNotFound', { chapterId }))
      return
    }

    const pagesList = Object.values(scene?.pages || {})
    const pagesToDelete = pagesList.filter((p: any) => p.chapterId === chapterId)

    const scenePagesKeys = Object.keys(scene?.pages || {})

    // Sort pages in descending order of their index to avoid index shifting when deleting them in sequence
    const pagesToDeleteSorted = pagesToDelete
      .map((page: any) => ({
        page,
        pageIndex: scenePagesKeys.indexOf(page.id),
      }))
      .filter((item) => item.pageIndex !== -1)
      .sort((a, b) => b.pageIndex - a.pageIndex)

    const innerOps: any[] = []

    pagesToDeleteSorted.forEach(({ page, pageIndex }) => {
      innerOps.push(ops.removePage(page.id, page, pageIndex))
    })

    innerOps.push(ops.removeChapter(chapterId, targetChapter, prevIndex))

    try {
      await applyOp(
        ops.batch(t('navigator.deleteChapterOp', { name: targetChapter.name }), innerOps),
      )

      const remainingChapters = chapterList.filter((ch: any) => ch.id !== chapterId)
      if (remainingChapters.length > 0) {
        const sorted = [...remainingChapters].sort(
          (a: any, b: any) => (a.order || 0) - (b.order || 0),
        )
        const latest = sorted[sorted.length - 1] as any
        setChapter(latest.id)
      } else {
        setChapter('all-chapters')
      }
      setDeleteConfirmOpen(false)
    } catch (e) {
      alert(
        t('navigator.deleteChapterRequestError', {
          message: e instanceof Error ? e.message : String(e),
        }),
      )
      console.error('Failed to delete chapter:', e)
    }
  }

  const handleInsertPage = async (index: number) => {
    try {
      await importPages('append', 'files', index)
    } catch (e) {
      console.error('Failed to insert page:', e)
    }
  }

  return (
    <div
      data-testid='navigator-panel'
      data-total-pages={totalPages}
      className='flex h-full min-h-0 w-full flex-col bg-transparent'
    >
      {/* Chapter Selection Header */}
      <div className='flex items-center gap-1.5 border-b border-border bg-card/40 px-2 py-2'>
        <div className='min-w-0 flex-1'>
          <Select
            value={chapterId === null ? 'all-chapters' : chapterId}
            onValueChange={(val) => setChapter(val)}
          >
            <SelectTrigger className='h-7 w-full min-w-0 overflow-hidden border-border/80 bg-background/50 hover:bg-background/80'>
              <SelectValue placeholder={t('navigator.selectChapter')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value='all-chapters'>{t('navigator.allChapters')}</SelectItem>
              {chapters.map((ch: any) => (
                <SelectItem key={ch.id} value={ch.id}>
                  {ch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          variant='outline'
          size='icon'
          className='h-7 w-7 border-border/80 bg-background/50 hover:bg-background/80'
          onClick={handleOpenCreateDialog}
          title={t('navigator.createChapter')}
        >
          <PlusIcon className='h-3.5 w-3.5' />
        </Button>
        <Button
          variant='outline'
          size='icon'
          className='h-7 w-7 border-border/80 bg-background/50 text-primary hover:bg-background/80 hover:text-primary'
          onClick={() => setDownloadChapterOpen(true)}
          title={t('navigator.downloadChapter')}
        >
          <CloudDownloadIcon className='h-3.5 w-3.5' />
        </Button>
        {chapterId && chapterId !== 'all-chapters' && (
          <Button
            variant='outline'
            size='icon'
            className='h-7 w-7 border-border/80 bg-background/50 text-destructive hover:bg-background/80 hover:bg-destructive/10 hover:text-destructive'
            onClick={() => setDeleteConfirmOpen(true)}
            title={t('navigator.deleteSelectedChapter')}
          >
            <Trash2Icon className='h-3.5 w-3.5' />
          </Button>
        )}
      </div>

      <div className='flex items-center justify-between border-b border-border px-2 py-1.5'>
        <div>
          <p className='text-xs tracking-wide text-muted-foreground uppercase'>
            {t('navigator.title')}
          </p>
          <p className='text-xs font-semibold text-foreground'>
            {totalPages ? t('navigator.pages', { count: totalPages }) : t('navigator.empty')}
          </p>
        </div>
        {totalPages > 1 && (
          <Button
            variant='ghost'
            size='icon'
            data-testid='navigator-manage-pages'
            className='h-6 w-6'
            onClick={() => setPageManagerOpen(true)}
            title={t('navigator.pageManager.title')}
          >
            <LayoutGridIcon className='h-3.5 w-3.5' />
          </Button>
        )}
      </div>

      <div className='flex items-center gap-1.5 px-2 py-1.5 text-xs text-muted-foreground'>
        {totalPages > 0 ? (
          <span className='bg-secondary px-2 py-0.5 font-mono text-[10px] text-secondary-foreground'>
            #{currentIndex + 1}
          </span>
        ) : (
          <span>{t('navigator.prompt')}</span>
        )}
      </div>

      <ScrollArea className='min-h-0 flex-1' viewportRef={viewportRef}>
        <div className='relative w-full' style={{ height: virtualizer.getTotalSize() + 24 }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const page = pages[virtualRow.index]
            return (
              <div
                key={page?.id ?? virtualRow.index}
                className='absolute left-0 w-full px-1.5 pb-1 transition-all duration-200 hover:z-50'
                style={{
                  height: ROW_HEIGHT,
                  top: 0,
                  transform: `translateY(${virtualRow.start + 12}px)`,
                }}
              >
                <PagePreview
                  index={virtualRow.index}
                  pageId={page?.id}
                  name={page?.name}
                  selected={page?.id === pageId}
                  onSelect={() => page && setPage(page.id)}
                  onDelete={page ? () => handleDeletePage(page, virtualRow.index) : undefined}
                  onInsert={page ? () => handleInsertPage(virtualRow.index + 1) : undefined}
                  onInsertBefore={
                    page && virtualRow.index === 0 ? () => handleInsertPage(0) : undefined
                  }
                  hoveredInsertIndex={hoveredInsertIndex}
                  setHoveredInsertIndex={setHoveredInsertIndex}
                />
              </div>
            )
          })}
        </div>
      </ScrollArea>

      <PageManagerDialog open={pageManagerOpen} onOpenChange={setPageManagerOpen} />

      {/* Chapter Creation Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('navigator.createChapter')}</DialogTitle>
            <DialogDescription>{t('navigator.createChapterDescription')}</DialogDescription>
          </DialogHeader>
          <div className='flex flex-col gap-4 py-2'>
            <Input
              autoFocus
              value={chapterName}
              onChange={(e) => setChapterName(e.target.value)}
              placeholder={t('navigator.createChapterPlaceholder')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateChapter()
              }}
            />
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => setCreateOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleCreateChapter} disabled={!chapterName.trim()}>
              {t('common.create')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chapter Deletion Dialog */}
      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('navigator.deleteChapterTitle')}</DialogTitle>
            <DialogDescription>{t('navigator.deleteChapterConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => setDeleteConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant='destructive' onClick={handleDeleteChapter}>
              {t('navigator.deleteForever')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {scene && (
        <DownloadChapterDialog
          open={downloadChapterOpen}
          onOpenChange={setDownloadChapterOpen}
          scene={scene}
        />
      )}
    </div>
  )
}

type PagePreviewProps = {
  index: number
  pageId?: string
  name?: string
  selected: boolean
  onSelect: () => void
  onDelete?: () => void
  onInsert?: () => void
  onInsertBefore?: () => void
  hoveredInsertIndex: number | null
  setHoveredInsertIndex: (index: number | null) => void
}

function PagePreview({
  index,
  pageId,
  name,
  selected,
  onSelect,
  onDelete,
  onInsert,
  onInsertBefore,
  hoveredInsertIndex,
  setHoveredInsertIndex,
}: PagePreviewProps) {
  const { t } = useTranslation()
  const src = pageId ? `${getGetPageThumbnailUrl(pageId)}?size=${200 * THUMBNAIL_DPR}` : undefined
  const fallbackPageName = t('navigator.pageLabel', { number: index + 1 })

  const isBelowHovered = hoveredInsertIndex === index
  const isAboveHovered = hoveredInsertIndex === index + 1

  const translateClass = isBelowHovered
    ? 'translate-y-3'
    : isAboveHovered
      ? '-translate-y-3'
      : 'translate-y-0'

  return (
    <div className='group/preview relative h-full w-full'>
      {index === 0 && onInsertBefore && (
        <InsertPageDivider
          onClick={onInsertBefore}
          onMouseEnter={() => setHoveredInsertIndex(0)}
          onMouseLeave={() => setHoveredInsertIndex(null)}
          position='top'
        />
      )}

      {onInsert && (
        <InsertPageDivider
          onClick={onInsert}
          onMouseEnter={() => setHoveredInsertIndex(index + 1)}
          onMouseLeave={() => setHoveredInsertIndex(null)}
        />
      )}

      <Button
        variant='ghost'
        onClick={onSelect}
        data-testid={`navigator-page-${index}`}
        data-page-index={index}
        data-selected={selected}
        className={`flex h-full w-full flex-col gap-0.5 rounded border border-transparent bg-card p-1.5 text-left shadow-sm transition-transform duration-300 ease-out data-[selected=true]:border-primary ${translateClass}`}
      >
        <div className='flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded'>
          {src ? (
            <img
              src={src}
              alt={fallbackPageName}
              loading='lazy'
              className='max-h-full max-w-full rounded object-contain'
            />
          ) : (
            <div className='h-full w-full rounded bg-muted' />
          )}
        </div>
        <div className='flex w-full shrink-0 flex-col items-center justify-center gap-0.5 px-1 text-xs text-muted-foreground'>
          <span
            className='max-w-full truncate font-semibold text-foreground'
            title={name || fallbackPageName}
          >
            {index + 1}. {name || fallbackPageName}
          </span>
        </div>
      </Button>
      {onDelete && (
        <Button
          variant='destructive'
          size='icon'
          className={`absolute top-1 right-1 h-6 w-6 scale-90 cursor-pointer border-none opacity-0 shadow-md transition-all transition-transform duration-200 duration-300 group-hover/preview:scale-100 group-hover/preview:opacity-100 ${translateClass}`}
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
          title={t('navigator.deletePage')}
        >
          <Trash2Icon className='h-3 w-3' />
        </Button>
      )}
    </div>
  )
}

type InsertPageDividerProps = {
  onClick: () => void
  onMouseEnter: () => void
  onMouseLeave: () => void
  position?: 'top' | 'bottom'
}

function InsertPageDivider({
  onClick,
  onMouseEnter,
  onMouseLeave,
  position = 'bottom',
}: InsertPageDividerProps) {
  const { t } = useTranslation()
  const positionClass = position === 'top' ? 'top-0 -translate-y-1/2' : 'bottom-0 translate-y-1/2'
  return (
    <div
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className={`peer/insert group/insert absolute right-0 left-0 z-30 flex h-6 items-center justify-center opacity-0 transition-opacity duration-300 hover:opacity-100 ${positionClass}`}
    >
      <div className='h-[2px] w-full origin-center scale-x-0 bg-primary transition-transform duration-300 ease-out group-hover/insert:scale-x-100' />
      <Button
        variant='secondary'
        size='icon'
        className='cubic-bezier(0.34, 1.56, 0.64, 1) absolute flex h-6 w-6 scale-0 cursor-pointer items-center justify-center rounded-full border-none bg-primary text-primary-foreground shadow-md transition-transform duration-300 group-hover/insert:scale-100 hover:bg-primary/95'
        onClick={(e) => {
          e.stopPropagation()
          onClick()
        }}
        title={
          position === 'top' ? t('navigator.insertPageBefore') : t('navigator.insertPageAfter')
        }
      >
        <PlusIcon className='h-3.5 w-3.5' />
      </Button>
    </div>
  )
}
