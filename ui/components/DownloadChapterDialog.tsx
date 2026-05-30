'use client'

import { useState } from 'react'
import { 
  CloudDownloadIcon, 
  Loader2Icon, 
  CheckCircle2Icon, 
  AlertCircleIcon,
  BookOpenIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogDescription,
  DialogFooter
} from '@/components/ui/dialog'
import { 
  useListMangaChapters, 
  useDownloadMangaChapter,
  getGetSceneJsonQueryKey
} from '@/lib/api/default/default'
import type { Scene, SceneSnapshot } from '@/lib/api/schemas'
import { invalidateScene } from '@/lib/io/scene'
import { useSelectionStore } from '@/lib/stores/selectionStore'
import { queryClient } from '@/lib/queryClient'

interface DownloadChapterDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  scene: Scene
}

function extractChapterNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname
    // Match common chapter formats like /chap-123, /chapter-123, /chuong-123, /c123
    const match = path.match(/(?:chap|chapter|chuong|c|ch)[-|_]?(\d+(?:\.\d+)?)/i)
    if (match && match[1]) {
      return `Chapter ${match[1]}`
    }
    // Fallback: get the last non-empty segment
    const segments = path.split('/').filter(Boolean)
    if (segments.length > 0) {
      const last = segments[segments.length - 1]
      return last.replace(/[-_]+/g, ' ').replace(/\.[a-z0-9]+$/i, '')
    }
  } catch {}
  return 'Chapter mới'
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

  // Get local chapters to check which ones are already downloaded
  const localChapters = Object.values(scene.chapters || {})

  // Fetch online chapters
  const { data, isLoading } = useListMangaChapters(
    {
      sourceId: sourceId || '',
      mangaId: mangaId || '',
    },
    {
      query: {
        enabled: open && !!sourceId && !!mangaId,
        retry: false,
      }
    }
  )

  const onlineChapters = data?.chapters || []

  // Download chapter mutation
  const downloadMutation = useDownloadMangaChapter()

  const handleDownload = async (chapter: { id: string; name: string }) => {
    setDownloadingId(chapter.id)
    setError(null)
    try {
      await downloadMutation.mutateAsync({
        data: {
          sourceId: sourceId || 'mock',
          mangaId: mangaId || '',
          chapterId: chapter.id,
          chapterName: chapter.name,
        }
      })

      // Invalidate react-query cache so pages reload
      await invalidateScene()

      // Fetch the updated scene from queryClient cache
      const updatedSnapshot = queryClient.getQueryData<SceneSnapshot>(getGetSceneJsonQueryKey())
      const newCh = Object.values(updatedSnapshot?.scene?.chapters || {}).find(
        (c: any) => c.name.toLowerCase() === chapter.name.toLowerCase()
      ) as any
      
      if (newCh && newCh.id) {
        setChapter(newCh.id)
      }

      onOpenChange(false)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : 'Tải chapter thất bại. Vui lòng thử lại.')
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
      const derivedName = extractChapterNameFromUrl(url)
      await downloadMutation.mutateAsync({
        data: {
          sourceId: sourceId || 'url',
          mangaId: mangaId || '',
          chapterId: url,
          chapterName: derivedName,
        }
      })

      // Invalidate react-query cache so pages reload
      await invalidateScene()

      // Fetch the updated scene from queryClient cache
      const updatedSnapshot = queryClient.getQueryData<SceneSnapshot>(getGetSceneJsonQueryKey())
      const newCh = Object.values(updatedSnapshot?.scene?.chapters || {}).find(
        (c: any) => c.name.toLowerCase() === derivedName.toLowerCase()
      ) as any
      
      if (newCh && newCh.id) {
        setChapter(newCh.id)
      }

      setCustomChapterUrl('')
      onOpenChange(false)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : 'Tải chapter từ link thất bại. Vui lòng thử lại.')
    } finally {
      setDownloadingCustom(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-6 overflow-hidden bg-background/95 backdrop-blur-xl border border-border/50 shadow-2xl rounded-2xl">
        
        <DialogHeader className="border-b border-border/40 pb-4 mb-2 shrink-0">
          <DialogTitle className="text-lg font-semibold tracking-tight text-foreground flex items-center gap-2">
            <CloudDownloadIcon className="h-5 w-5 text-primary" />
            Tải Chapter từ Web
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground mt-0.5">
            Manga: <span className="font-semibold text-foreground">{mangaTitle}</span>
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive mb-3 shrink-0">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1 font-medium">{error}</div>
          </div>
        )}

        {/* Custom Chapter URL paste box */}
        <div className="flex flex-col gap-2 p-3.5 rounded-xl border border-border/40 bg-card/10 mb-3 shrink-0">
          <span className="text-xs font-semibold text-foreground">Dán link chương để tải nhanh</span>
          <div className="flex gap-2">
            <Input
              placeholder="Dán link chapter (ví dụ: https://nettruyen...)"
              value={customChapterUrl}
              onChange={(e) => setCustomChapterUrl(e.target.value)}
              className="h-9 text-xs bg-card/40 border-none focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none rounded-lg outline-none flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  const text = await navigator.clipboard.readText()
                  if (text) setCustomChapterUrl(text)
                } catch (err) {
                  console.error('Failed to read clipboard', err)
                }
              }}
              className="h-9 px-2.5 text-xs font-medium border-border/50 hover:bg-muted/40 cursor-pointer rounded-lg shrink-0"
            >
              Dán
            </Button>
            <Button
              size="sm"
              onClick={handleDownloadCustomChapter}
              disabled={!customChapterUrl.trim() || !!downloadingId || downloadingCustom}
              className="h-9 px-3 text-xs gap-1.5 cursor-pointer rounded-lg font-medium"
            >
              {downloadingCustom ? (
                <>
                  <Loader2Icon className="h-3 w-3 animate-spin" />
                  Đang tải...
                </>
              ) : (
                <>
                  <CloudDownloadIcon className="h-3.5 w-3.5" />
                  Tải
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col min-h-[200px]">
          {isLoading ? (
            <div className="flex-1 flex flex-col items-center justify-center gap-3">
              <Loader2Icon className="h-7 w-7 text-primary animate-spin" />
              <p className="text-xs text-muted-foreground">Đang tải danh sách chapter trực tuyến...</p>
            </div>
          ) : onlineChapters.length > 0 ? (
            <div className="flex-1 overflow-y-auto pr-1">
              <div className="flex flex-col gap-2 pb-2">
                {onlineChapters.map((ch) => {
                  const isDownloaded = localChapters.some(
                    (lc: any) => lc.name.toLowerCase() === ch.name.toLowerCase()
                  )
                  const isDownloading = downloadingId === ch.id

                  return (
                    <div 
                      key={ch.id}
                      className="flex items-center justify-between p-3 rounded-xl border border-border/40 bg-card/10 hover:bg-card/30 transition-all duration-200"
                    >
                      <div className="flex flex-col gap-0.5 pr-4 min-w-0">
                        <span className="font-medium text-sm text-foreground truncate">
                          {ch.name}
                        </span>
                      </div>
                      
                      <div className="shrink-0">
                        {isDownloaded ? (
                          <div className="flex items-center gap-1 text-[11px] font-medium text-emerald-500 bg-emerald-500/10 px-2.5 py-1 rounded-full border border-emerald-500/20">
                            <CheckCircle2Icon className="h-3 w-3 shrink-0" />
                            Đã tải
                          </div>
                        ) : (
                          <Button
                            size="sm"
                            onClick={() => handleDownload(ch)}
                            disabled={!!downloadingId || downloadingCustom}
                            className="h-8 px-3 text-xs gap-1.5 cursor-pointer rounded-lg font-medium"
                          >
                            {isDownloading ? (
                              <>
                                <Loader2Icon className="h-3 w-3 animate-spin" />
                                Đang tải...
                              </>
                            ) : (
                              <>
                                <CloudDownloadIcon className="h-3.5 w-3.5" />
                                Tải về
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
            <div className="flex-1 flex flex-col items-center justify-center text-center gap-2">
              <BookOpenIcon className="h-8 w-8 text-muted-foreground/40 shrink-0" />
              {!(sourceId && mangaId) ? (
                <>
                  <p className="text-xs font-medium text-foreground">Dự án chưa liên kết nguồn</p>
                  <p className="text-[11px] text-muted-foreground max-w-xs leading-relaxed">
                    Dự án này được tạo thủ công nên không thể lấy danh sách chapter tự động. Bạn hãy dán link chapter ở trên để tải trực tiếp nhé!
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xs font-medium text-foreground">Không tìm thấy chapter nào</p>
                  <p className="text-[11px] text-muted-foreground max-w-xs leading-relaxed">
                    Nguồn truyện này hiện chưa cập nhật chapter nào hoặc ngôn ngữ bạn chọn không khả dụng. Bạn vẫn có thể dán link chapter ở trên để tải trực tiếp!
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="border-t border-border/40 pt-4 mt-2 shrink-0">
          <Button 
            type="button" 
            variant="outline" 
            onClick={() => onOpenChange(false)}
            disabled={!!downloadingId || downloadingCustom}
            className="w-full sm:w-auto text-xs h-9 rounded-lg"
          >
            Đóng
          </Button>
        </DialogFooter>

      </DialogContent>
    </Dialog>
  )
}
