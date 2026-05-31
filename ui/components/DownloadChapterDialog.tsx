'use client'

import {
  CloudDownloadIcon,
  Loader2Icon,
  CheckCircle2Icon,
  AlertCircleIcon,
  BookOpenIcon,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  useListMangaChapters,
  useDownloadMangaChapter,
  getGetSceneJsonQueryKey,
} from '@/lib/api/default/default'
import type { Scene, SceneSnapshot } from '@/lib/api/schemas'
import { invalidateScene } from '@/lib/io/scene'
import { queryClient } from '@/lib/queryClient'
import { useSelectionStore } from '@/lib/stores/selectionStore'

interface DownloadChapterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scene: Scene
}

function extractChapterNameFromUrl(
  url: string,
  defaultName: string,
  chapterNumberName: (number: string) => string,
): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname
    // Match common chapter formats like /chap-123, /chapter-123, /chuong-123, /c123
    const match = path.match(/(?:chap|chapter|chuong|c|ch)[-|_]?(\d+(?:\.\d+)?)/i)
    if (match && match[1]) {
      return chapterNumberName(match[1])
    }
    // Fallback: get the last non-empty segment
    const segments = path.split('/').filter(Boolean)
    if (segments.length > 0) {
      const last = segments[segments.length - 1]
      return last.replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]+$/i, '')
    }
  } catch {}
  return defaultName
}

export function DownloadChapterDialog({ open, onOpenChange, scene }: DownloadChapterDialogProps) {
  const { t } = useTranslation()
  const sourceId = scene.project.sourceId
  const mangaId = scene.project.mangaId
  const mangaTitle = scene.project.mangaTitle || scene.project.name
  const setChapter = useSelectionStore((s) => s.setChapter)

  const [downloadingId, setDownloadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [customChapterUrl, setCustomChapterUrl] = useState('')
  const [downloadingCustom, setDownloadingCustom] = useState(false)

  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [batchDownloading, setBatchDownloading] = useState(false)
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 })

  // Get local chapters to check which ones are already downloaded
  const localChapters = Object.values(scene.chapters || {})

  // Fetch online chapters
  const { data, isLoading } = useListMangaChapters(
    {
      sourceId: sourceId || 'url',
      mangaId: mangaId || '',
    },
    {
      query: {
        enabled: open && (!!sourceId || mangaId?.startsWith('http') || false) && !!mangaId,
        retry: false,
      },
    },
  )

  const onlineChapters = data?.chapters || []

  // Download chapter mutation
  const downloadMutation = useDownloadMangaChapter()

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const handleSelectAll = () => {
    const uncompleted = onlineChapters.filter(
      (ch) => !localChapters.some((lc: any) => lc.name.toLowerCase() === ch.name.toLowerCase()),
    )
    if (selectedIds.length === uncompleted.length) {
      setSelectedIds([])
    } else {
      setSelectedIds(uncompleted.map((ch) => ch.id))
    }
  }

  const handleBatchDownload = async () => {
    if (selectedIds.length === 0) return
    setBatchDownloading(true)
    setBatchProgress({ current: 0, total: selectedIds.length })
    setError(null)

    let successCount = 0
    let failCount = 0

    try {
      for (let i = 0; i < selectedIds.length; i++) {
        const id = selectedIds[i]
        const ch = onlineChapters.find((c) => c.id === id)
        if (!ch) continue

        setBatchProgress((prev) => ({ ...prev, current: i + 1 }))
        setDownloadingId(id)

        try {
          await downloadMutation.mutateAsync({
            data: {
              sourceId: sourceId || 'url',
              mangaId: mangaId || '',
              chapterId: ch.id,
              chapterName: ch.name,
            },
          })
          successCount++
        } catch (err) {
          console.error(`Failed to download chapter ${ch.name}`, err)
          failCount++
        }
      }

      // Invalidate scene once at the end
      await invalidateScene()

      if (failCount > 0) {
        setError(
          t('downloadChapter.batchPartialError', { success: successCount, failed: failCount }),
        )
      }

      setSelectedIds([])
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : t('downloadChapter.batchFailed'))
    } finally {
      setBatchDownloading(false)
      setDownloadingId(null)
    }
  }

  const handleDownload = async (chapter: { id: string; name: string }) => {
    setDownloadingId(chapter.id)
    setError(null)
    try {
      await downloadMutation.mutateAsync({
        data: {
          sourceId: sourceId || 'url',
          mangaId: mangaId || '',
          chapterId: chapter.id,
          chapterName: chapter.name,
        },
      })

      // Invalidate react-query cache so pages reload
      await invalidateScene()

      // Fetch the updated scene from queryClient cache
      const updatedSnapshot = queryClient.getQueryData<SceneSnapshot>(getGetSceneJsonQueryKey())
      const newCh = Object.values(updatedSnapshot?.scene?.chapters || {}).find(
        (c: any) => c.name.toLowerCase() === chapter.name.toLowerCase(),
      ) as any

      if (newCh && newCh.id) {
        setChapter(newCh.id)
      }

      onOpenChange(false)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : t('downloadChapter.downloadFailed'))
    } finally {
      setDownloadingId(null)
    }
  }

  const handleDownloadCustomChapter = async () => {
    const url = customChapterUrl.trim()
    if (!url) return
    setDownloadingCustom(true)
    setError(null)
    try {
      const derivedName = extractChapterNameFromUrl(
        url,
        t('downloadChapter.newChapter'),
        (number) => t('navigator.defaultChapterName', { number }),
      )
      await downloadMutation.mutateAsync({
        data: {
          sourceId: sourceId || 'url',
          mangaId: mangaId || '',
          chapterId: url,
          chapterName: derivedName,
        },
      })

      // Invalidate react-query cache so pages reload
      await invalidateScene()

      // Fetch the updated scene from queryClient cache
      const updatedSnapshot = queryClient.getQueryData<SceneSnapshot>(getGetSceneJsonQueryKey())
      const newCh = Object.values(updatedSnapshot?.scene?.chapters || {}).find(
        (c: any) => c.name.toLowerCase() === derivedName.toLowerCase(),
      ) as any

      if (newCh && newCh.id) {
        setChapter(newCh.id)
      }

      setCustomChapterUrl('')
      onOpenChange(false)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : t('downloadChapter.downloadFromLinkFailed'))
    } finally {
      setDownloadingCustom(false)
    }
  }

  const uncompletedChapters = onlineChapters.filter(
    (ch) => !localChapters.some((lc: any) => lc.name.toLowerCase() === ch.name.toLowerCase()),
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-border/50 bg-background/95 p-6 backdrop-blur-xl sm:max-w-2xl'>
        <DialogHeader className='mb-2 shrink-0 border-b border-border/40 pb-4'>
          <div className='flex items-center justify-between'>
            <div>
              <DialogTitle className='flex items-center gap-2 text-lg font-semibold tracking-tight text-foreground'>
                <CloudDownloadIcon className='h-5 w-5 text-primary' />
                {t('downloadChapter.title')}
              </DialogTitle>
              <DialogDescription className='mt-0.5 text-xs text-muted-foreground'>
                {t('downloadChapter.mangaLabel')}:{' '}
                <span className='font-semibold text-foreground'>{mangaTitle}</span>
              </DialogDescription>
            </div>

            {onlineChapters.length > 0 && uncompletedChapters.length > 0 && !isLoading && (
              <Button
                variant='outline'
                size='sm'
                onClick={handleSelectAll}
                disabled={batchDownloading}
                className='h-8 cursor-pointer rounded-lg border-border/40 px-3 text-xs font-semibold hover:bg-muted/40'
              >
                {selectedIds.length === uncompletedChapters.length
                  ? t('downloadChapter.unselectAll')
                  : t('downloadChapter.selectAllUndownloaded', {
                      count: uncompletedChapters.length,
                    })}
              </Button>
            )}
          </div>
        </DialogHeader>

        {error && (
          <div className='mb-3 flex shrink-0 items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive'>
            <AlertCircleIcon className='mt-0.5 h-4 w-4 shrink-0' />
            <div className='flex-1 font-medium'>{error}</div>
          </div>
        )}

        {batchDownloading && (
          <div className='mb-3 flex shrink-0 animate-pulse flex-col gap-1.5 rounded-xl border border-primary/20 bg-primary/5 p-3'>
            <div className='flex items-center justify-between text-xs font-semibold text-primary'>
              <span className='flex items-center gap-2'>
                <Loader2Icon className='h-3.5 w-3.5 animate-spin' />
                {t('downloadChapter.batchDownloading')}
              </span>
              <span>
                {batchProgress.current} / {batchProgress.total}
              </span>
            </div>
            <div className='h-1.5 w-full overflow-hidden rounded-full bg-primary/10'>
              <div
                className='h-full rounded-full bg-primary transition-all duration-300'
                style={{ width: `${(batchProgress.current / batchProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Custom Chapter URL paste box */}
        {!batchDownloading && (
          <div className='mb-3 flex shrink-0 flex-col gap-2 rounded-xl border border-border/40 bg-card/10 p-3.5'>
            <span className='text-xs font-semibold text-foreground'>
              {t('downloadChapter.pasteLinkLabel')}
            </span>
            <div className='flex gap-2'>
              <Input
                placeholder={t('downloadChapter.pasteLinkPlaceholder')}
                value={customChapterUrl}
                onChange={(e) => setCustomChapterUrl(e.target.value)}
                className='h-9 flex-1 rounded-lg border-none bg-card/40 text-xs shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0'
              />
              <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText()
                    if (text) setCustomChapterUrl(text)
                  } catch (err) {
                    console.error('Failed to read clipboard', err)
                  }
                }}
                className='h-9 shrink-0 cursor-pointer rounded-lg border-border/50 px-2.5 text-xs font-medium hover:bg-muted/40'
              >
                {t('downloadChapter.paste')}
              </Button>
              <Button
                size='sm'
                onClick={handleDownloadCustomChapter}
                disabled={!customChapterUrl.trim() || !!downloadingId || downloadingCustom}
                className='h-9 cursor-pointer gap-1.5 rounded-lg px-3 text-xs font-medium'
              >
                {downloadingCustom ? (
                  <>
                    <Loader2Icon className='h-3 w-3 animate-spin' />
                    {t('downloadChapter.loading')}
                  </>
                ) : (
                  <>
                    <CloudDownloadIcon className='h-3.5 w-3.5' />
                    {t('downloadChapter.download')}
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        <div className='flex min-h-[200px] flex-1 flex-col overflow-hidden'>
          {isLoading ? (
            <div className='flex flex-1 flex-col items-center justify-center gap-3'>
              <Loader2Icon className='h-7 w-7 animate-spin text-primary' />
              <p className='text-xs text-muted-foreground'>
                {t('downloadChapter.fetchingOnlineChapters')}
              </p>
            </div>
          ) : onlineChapters.length > 0 ? (
            <div className='flex-1 overflow-y-auto pr-1'>
              <div className='flex flex-col gap-2 pb-2'>
                {onlineChapters.map((ch) => {
                  const isDownloaded = localChapters.some(
                    (lc: any) => lc.name.toLowerCase() === ch.name.toLowerCase(),
                  )
                  const isDownloading = downloadingId === ch.id
                  const isSelected = selectedIds.includes(ch.id)

                  return (
                    <div
                      key={ch.id}
                      onClick={() =>
                        !isDownloaded && !batchDownloading && handleToggleSelect(ch.id)
                      }
                      className={`flex items-center justify-between rounded-xl border p-3 transition-all duration-200 ${
                        !isDownloaded ? 'cursor-pointer' : ''
                      } ${
                        isSelected
                          ? 'border-primary/50 bg-primary/5'
                          : 'border-border/40 bg-card/10 hover:bg-card/20'
                      }`}
                    >
                      <div className='flex min-w-0 flex-1 items-center gap-3 pr-4'>
                        {!isDownloaded && (
                          <div
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-all ${
                              isSelected
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'border-border/80 hover:border-primary/50'
                            }`}
                          >
                            {isSelected && (
                              <svg
                                xmlns='http://www.w3.org/2000/svg'
                                viewBox='0 0 24 24'
                                fill='none'
                                stroke='currentColor'
                                strokeWidth='3'
                                className='h-2.5 w-2.5'
                              >
                                <polyline points='20 6 9 17 4 12' />
                              </svg>
                            )}
                          </div>
                        )}
                        <span className='truncate text-sm font-medium text-foreground'>
                          {ch.name}
                        </span>
                      </div>

                      <div className='shrink-0' onClick={(e) => e.stopPropagation()}>
                        {isDownloaded ? (
                          <div className='flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-500'>
                            <CheckCircle2Icon className='h-3 w-3 shrink-0' />
                            {t('downloadChapter.downloaded')}
                          </div>
                        ) : (
                          <Button
                            size='sm'
                            onClick={() => handleDownload(ch)}
                            disabled={!!downloadingId || downloadingCustom || batchDownloading}
                            className='h-8 cursor-pointer gap-1.5 rounded-lg px-3 text-xs font-medium'
                          >
                            {isDownloading ? (
                              <>
                                <Loader2Icon className='h-3 w-3 animate-spin' />
                                {t('downloadChapter.downloading')}
                              </>
                            ) : (
                              <>
                                <CloudDownloadIcon className='h-3.5 w-3.5' />
                                {t('downloadChapter.downloadBtn')}
                              </>
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : (
            <div className='flex flex-1 flex-col items-center justify-center gap-2 text-center'>
              <BookOpenIcon className='h-8 w-8 shrink-0 text-muted-foreground/40' />
              {!(sourceId && mangaId) ? (
                <>
                  <p className='text-xs font-medium text-foreground'>
                    {t('downloadChapter.noSourceLinkedTitle')}
                  </p>
                  <p className='max-w-xs text-[11px] leading-relaxed text-muted-foreground'>
                    {t('downloadChapter.noSourceLinkedDesc')}
                  </p>
                </>
              ) : (
                <>
                  <p className='text-xs font-medium text-foreground'>
                    {t('downloadChapter.noChaptersFoundTitle')}
                  </p>
                  <p className='max-w-xs text-[11px] leading-relaxed text-muted-foreground'>
                    {t('downloadChapter.noChaptersFoundDesc')}
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter className='mt-2 flex shrink-0 items-center justify-between border-t border-border/40 pt-4 sm:justify-between'>
          <div className='text-xs font-medium text-muted-foreground'>
            {selectedIds.length > 0 &&
              t('downloadChapter.selectedChapters', { count: selectedIds.length })}
          </div>
          <div className='flex gap-2'>
            <Button
              type='button'
              variant='outline'
              onClick={() => onOpenChange(false)}
              disabled={!!downloadingId || downloadingCustom || batchDownloading}
              className='h-9 rounded-lg text-xs'
            >
              {t('common.close')}
            </Button>
            {selectedIds.length > 0 && (
              <Button
                type='button'
                onClick={handleBatchDownload}
                disabled={batchDownloading}
                className='h-9 cursor-pointer gap-1.5 rounded-lg px-4 text-xs font-semibold'
              >
                <CloudDownloadIcon className='h-4 w-4' />
                {t('downloadChapter.downloadSelected', { count: selectedIds.length })}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
