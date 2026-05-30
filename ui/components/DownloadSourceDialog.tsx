'use client'

import { useState, useEffect } from 'react'
import { 
  GlobeIcon, 
  SearchIcon, 
  PlusIcon, 
  ArrowLeftIcon, 
  Loader2Icon, 
  BookOpenIcon, 
  AlertCircleIcon,
  FolderIcon
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { 
  Dialog, 
  DialogContent, 
  DialogHeader, 
  DialogTitle, 
  DialogDescription 
} from '@/components/ui/dialog'
import { 
  useListMangaSources, 
  useSearchManga, 
  useCreateMangaProject 
} from '@/lib/api/default/default'
import type { MangaSource, MangaSearchResult } from '@/lib/api/schemas'
import { invalidateScene, invalidateProjects } from '@/lib/io/scene'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'

interface DownloadSourceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function DownloadSourceDialog({ open, onOpenChange }: DownloadSourceDialogProps) {
  const { t } = useTranslation()
  const [step, setStep] = useState<'source' | 'search'>('source')
  const [selectedSource, setSelectedSource] = useState<MangaSource | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [sourceSearchQuery, setSourceSearchQuery] = useState('')
  const [creatingId, setCreatingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const customPath = usePreferencesStore((state) => state.preferredCustomSavePath)
  const setCustomPath = usePreferencesStore((state) => state.setPreferredCustomSavePath)

  // Reset state when dialog is closed
  useEffect(() => {
    if (!open) {
      setStep('source')
      setSelectedSource(null)
      setSearchQuery('')
      setDebouncedQuery('')
      setSourceSearchQuery('')
      setError(null)
    }
  }, [open])

  // Fetch supported sources
  const { data: sources, isLoading: loadingSources } = useListMangaSources({
    query: {
      enabled: open,
    }
  })

  // Filter sources based on sourceSearchQuery
  const filteredSources = sources?.filter(source => 
    source.name.toLowerCase().includes(sourceSearchQuery.toLowerCase()) ||
    source.url.toLowerCase().includes(sourceSearchQuery.toLowerCase())
  ) ?? []

  // Automatically detect pasted URL in the first step and transition to search
  useEffect(() => {
    const q = sourceSearchQuery.trim()
    if (q.startsWith('http://') || q.startsWith('https://')) {
      // Find matched source based on url
      let matchedSource = sources?.find(s => q.includes(s.url.replace(/^https?:\/\//, '').split('/')[0]))
      
      // Default to mangadex if not found but is mangadex
      if (!matchedSource && q.includes('mangadex.org')) {
        matchedSource = sources?.find(s => s.id === 'mangadex')
      }

      // If still not found, fallback to the first source or mangadex
      if (!matchedSource && sources && sources.length > 0) {
        matchedSource = sources.find(s => s.id === 'mangadex') || sources[0]
      }
      
      if (matchedSource) {
        setSelectedSource(matchedSource)
        setStep('search')
        setSearchQuery(q)
        setSourceSearchQuery('')
      }
    }
  }, [sourceSearchQuery, sources])

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery)
    }, 400)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Search manga query
  const { data: searchResults, isFetching: isSearching } = useSearchManga(
    {
      sourceId: selectedSource?.id ?? '',
      query: debouncedQuery,
    },
    {
      query: {
        enabled: step === 'search' && !!selectedSource && debouncedQuery.trim().length > 0,
        retry: false,
      }
    }
  )

  // Create Project mutation
  const createProjectMutation = useCreateMangaProject()

  const handleSelectSource = (source: MangaSource) => {
    setSelectedSource(source)
    setStep('search')
    setSearchQuery('')
    setDebouncedQuery('')
    setError(null)
  }

  const handleBack = () => {
    setStep('source')
    setSelectedSource(null)
    setSearchQuery('')
    setDebouncedQuery('')
    setSourceSearchQuery('')
    setError(null)
  }

  const handleSelectFolder = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const folder = await open({ directory: true, multiple: false })
      if (folder && typeof folder === 'string') {
        setCustomPath(folder)
      }
    } catch (e) {
      console.error(e)
    }
  }

  const handleCreateProject = async (manga: MangaSearchResult) => {
    if (!selectedSource) return
    setCreatingId(manga.id)
    setError(null)
    try {
      await createProjectMutation.mutateAsync({
        data: {
          sourceId: selectedSource.id,
          mangaId: manga.id,
          mangaTitle: manga.title,
          customSavePath: customPath,
        }
      })
      await invalidateScene()
      await invalidateProjects()
      onOpenChange(false)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : 'Không thể tạo project từ manga này.')
    } finally {
      setCreatingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col p-6 overflow-hidden bg-background/95 backdrop-blur-xl border border-border/50 shadow-2xl rounded-2xl transition-all duration-300">
        
        <DialogHeader className="border-b border-border/40 pb-4 mb-2 shrink-0">
          <div className="flex items-center gap-3">
            {step === 'search' && (
              <Button 
                variant="ghost" 
                size="icon" 
                onClick={handleBack} 
                className="h-8 w-8 rounded-full border border-border/30 hover:bg-muted/40 cursor-pointer shrink-0"
              >
                <ArrowLeftIcon className="h-4 w-4" />
              </Button>
            )}
            <div>
              <DialogTitle className="text-xl font-semibold tracking-tight text-foreground flex items-center gap-2">
                <GlobeIcon className="h-5 w-5 text-primary shrink-0" />
                {step === 'source' ? 'Chọn nguồn tải truyện' : `Tìm kiếm trên ${selectedSource?.name}`}
              </DialogTitle>
              <DialogDescription className="text-xs text-muted-foreground mt-0.5">
                {step === 'source' 
                  ? 'Chọn một trong các nguồn trực tuyến được hỗ trợ để tìm kiếm và tạo dự án.'
                  : `Nhập tên truyện cần tìm trên ${selectedSource?.name}.`
                }
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {error && (
          <div className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive mb-3 shrink-0">
            <AlertCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="flex-1 font-medium">{error}</div>
          </div>
        )}

        {step === 'source' ? (
          <div className="flex-1 overflow-hidden flex flex-col gap-4 mt-2">
            {loadingSources ? (
              <div className="flex-1 flex flex-col items-center justify-center gap-3">
                <Loader2Icon className="h-8 w-8 text-primary animate-spin" />
                <p className="text-xs text-muted-foreground">Đang tải danh sách nguồn truyện...</p>
              </div>
            ) : (
              <>
                {/* Search Input for Sources */}
                <div className="relative shrink-0 flex gap-2">
                  <div className="relative flex-1">
                    <SearchIcon className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      placeholder="Tìm kiếm nguồn hoặc dán link truyện vào đây..."
                      value={sourceSearchQuery}
                      onChange={(e) => setSourceSearchQuery(e.target.value)}
                      className="pl-10 pr-20 h-10 bg-card/40 border-none focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none rounded-xl text-xs outline-none w-full"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        try {
                          const text = await navigator.clipboard.readText()
                          if (text) setSourceSearchQuery(text)
                        } catch (err) {
                          console.error('Failed to read clipboard', err)
                        }
                      }}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 h-7 px-2 text-[10px] font-medium bg-primary/15 hover:bg-primary/25 text-primary rounded-lg border-none cursor-pointer"
                    >
                      Dán link
                    </Button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto pr-1">
                  {filteredSources.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pb-2">
                      {filteredSources.map((source) => (
                        <Card 
                          key={source.id}
                          onClick={() => handleSelectSource(source)}
                          className="group p-4 flex flex-col gap-3 rounded-xl border border-border/60 hover:border-primary/50 hover:bg-primary/5 transition-all duration-300 cursor-pointer shadow-sm hover:shadow-md"
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2.5 min-w-0">
                              {(source as any).iconUrl ? (
                                <img 
                                  src={(source as any).iconUrl} 
                                  alt={source.name} 
                                  className="w-5 h-5 object-contain rounded-md shrink-0 bg-muted/20"
                                  onError={(e) => {
                                    (e.target as HTMLElement).style.display = 'none';
                                  }}
                                />
                              ) : (
                                <GlobeIcon className="w-5 h-5 text-muted-foreground shrink-0" />
                              )}
                              <div className="font-semibold text-sm group-hover:text-primary transition-colors truncate">
                                {source.name}
                              </div>
                            </div>
                            <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[120px]">
                              {source.url.replace(/^https?:\/\//, '')}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                            {source.description}
                          </p>
                        </Card>
                      ))}
                    </div>
                  ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-center gap-2 py-12">
                      <SearchIcon className="h-8 w-8 text-muted-foreground/40 shrink-0" />
                      <p className="text-xs font-semibold text-foreground">Không tìm thấy nguồn truyện nào</p>
                      <p className="text-[11px] text-muted-foreground max-w-xs leading-relaxed">
                        Thử lại bằng từ khóa khác hoặc đảm bảo bạn đã đồng bộ các script tải từ HaruNeko.
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-hidden flex flex-col gap-4 mt-2">
            {/* Search Input */}
            <div className="relative shrink-0 flex gap-2">
              <div className="relative flex-1">
                <SearchIcon className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  placeholder="Nhập tên manga hoặc dán link truyện để tìm..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`pl-10 ${isSearching ? 'pr-24' : 'pr-16'} h-11 bg-card/40 border-none focus-visible:ring-0 focus-visible:ring-offset-0 shadow-none rounded-xl outline-none w-full`}
                />
                {isSearching && (
                  <Loader2Icon className={`absolute ${isSearching ? 'right-16' : 'right-3.5'} top-1/2 -translate-y-1/2 h-4 w-4 text-primary animate-spin`} />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText()
                      if (text) setSearchQuery(text)
                    } catch (err) {
                      console.error('Failed to read clipboard', err)
                    }
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 h-8 px-2.5 text-xs font-medium bg-primary/15 hover:bg-primary/25 text-primary rounded-lg border-none cursor-pointer"
                >
                  Dán
                </Button>
              </div>
            </div>

            {/* Custom save directory selector */}
            <div className="flex items-center justify-between gap-3 p-3 rounded-xl border border-border/40 bg-card/10 shrink-0">
              <div className="flex items-center gap-2.5 min-w-0">
                <FolderIcon className="h-4.5 w-4.5 text-primary shrink-0" />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-semibold text-foreground">Thư mục lưu dự án</span>
                  <span className="text-[10px] text-muted-foreground truncate font-mono">
                    {customPath || 'Mặc định (Thư mục dự án của Koharu)'}
                  </span>
                </div>
              </div>
              <Button 
                variant="outline" 
                size="sm" 
                onClick={handleSelectFolder}
                className="h-8 text-xs font-medium border-border/50 hover:bg-muted/40 cursor-pointer rounded-lg shrink-0"
              >
                Thay đổi...
              </Button>
            </div>

            {/* Results */}
            <div className="flex-1 overflow-hidden flex flex-col min-h-[250px]">
              {debouncedQuery.trim().length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center text-center gap-3">
                  <BookOpenIcon className="h-10 w-10 text-muted-foreground/60 shrink-0" />
                  <p className="text-xs text-muted-foreground max-w-xs leading-relaxed">
                    Nhập từ khóa tìm kiếm để bắt đầu tra cứu truyện tranh trực tuyến từ {selectedSource?.name}.
                  </p>
                </div>
              ) : isSearching && !searchResults ? (
                <div className="flex-1 flex flex-col items-center justify-center gap-3">
                  <Loader2Icon className="h-8 w-8 text-primary animate-spin" />
                  <p className="text-xs text-muted-foreground">Đang tìm kiếm...</p>
                </div>
              ) : searchResults && searchResults.length > 0 ? (
                <div className="flex-1 overflow-y-auto pr-1">
                  <div className="flex flex-col gap-3 pb-2">
                    {searchResults.map((manga) => (
                      <div 
                        key={manga.id}
                        className="group flex gap-4 p-3 rounded-xl border border-border/50 bg-card/20 hover:border-border/80 hover:bg-card/40 transition-all duration-300"
                      >
                        {manga.coverUrl ? (
                          <img 
                            src={manga.coverUrl} 
                            alt={manga.title} 
                            className="w-16 h-24 object-cover rounded-lg border border-border/40 shrink-0 shadow-sm"
                            onError={(e) => {
                              // Fallback if image fails to load
                              (e.target as HTMLElement).style.display = 'none';
                            }}
                          />
                        ) : (
                          <div className="w-16 h-24 rounded-lg bg-muted flex items-center justify-center shrink-0 border border-border/30">
                            <BookOpenIcon className="h-6 w-6 text-muted-foreground/40" />
                          </div>
                        )}
                        
                        <div className="flex-1 min-w-0 flex flex-col justify-between py-0.5">
                          <div className="flex flex-col gap-1">
                            <h3 className="font-semibold text-sm text-foreground truncate group-hover:text-primary transition-colors">
                              {manga.title}
                            </h3>
                            <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2">
                              {manga.description || 'Không có mô tả.'}
                            </p>
                          </div>
                          <div className="flex items-center justify-between mt-2 shrink-0">
                            <span className="text-[10px] text-muted-foreground font-mono">
                              ID: {manga.id.substring(0, 8)}...
                            </span>
                            <Button 
                              size="sm"
                              onClick={() => handleCreateProject(manga)}
                              disabled={!!creatingId}
                              className="h-7.5 px-3 text-xs gap-1.5 cursor-pointer rounded-lg font-medium"
                            >
                              {creatingId === manga.id ? (
                                <>
                                  <Loader2Icon className="h-3 w-3 animate-spin" />
                                  Đang tạo...
                                </>
                              ) : (
                                <>
                                  <PlusIcon className="h-3 w-3" />
                                  Tạo Project
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center gap-2">
                  <SearchIcon className="h-8 w-8 text-muted-foreground/40 shrink-0" />
                  <p className="text-xs font-medium text-foreground">Không tìm thấy kết quả nào</p>
                  <p className="text-[11px] text-muted-foreground max-w-xs leading-relaxed">
                    Vui lòng thử lại với từ khóa khác hoặc kiểm tra lại kết nối mạng.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

      </DialogContent>
    </Dialog>
  )
}
