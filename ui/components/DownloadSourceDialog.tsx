'use client'

import {
  GlobeIcon,
  SearchIcon,
  PlusIcon,
  ArrowLeftIcon,
  Loader2Icon,
  BookOpenIcon,
  AlertCircleIcon,
  FolderIcon,
  SparklesIcon,
} from 'lucide-react'
import { useState, useEffect, memo } from 'react'
import { useTranslation } from 'react-i18next'

import { CloneHaruNekoDialog } from '@/components/CloneHaruNekoDialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  useListMangaSources,
  useSearchManga,
  useCreateMangaProject,
} from '@/lib/api/default/default'
import type { MangaSource, MangaSearchResult } from '@/lib/api/schemas'
import { invalidateScene, invalidateProjects } from '@/lib/io/scene'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'

// Memoized Card component for individual Manga Sources to avoid re-renders during input/scrolling
const MangaSourceCard = memo(function MangaSourceCard({
  source,
  onClick,
}: {
  source: MangaSource
  onClick: () => void
}) {
  return (
    <Card
      onClick={onClick}
      className='group flex cursor-pointer flex-col gap-3 rounded-xl border border-border/60 p-4 transition-all duration-300 hover:border-primary/50 hover:bg-primary/5'
    >
      <div className='flex items-center justify-between'>
        <div className='flex min-w-0 items-center gap-2.5'>
          {(source as any).iconUrl ? (
            <img
              src={(source as any).iconUrl}
              alt={source.name}
              className='h-5 w-5 shrink-0 rounded-md bg-muted/20 object-contain'
              onError={(e) => {
                ;(e.target as HTMLElement).style.display = 'none'
              }}
            />
          ) : (
            <GlobeIcon className='h-5 w-5 shrink-0 text-muted-foreground' />
          )}
          <div className='truncate text-sm font-semibold transition-colors group-hover:text-primary'>
            {source.name}
          </div>
        </div>
        <span className='max-w-[120px] truncate font-mono text-[10px] text-muted-foreground'>
          {source.url.replace(/^https?:\/\//, '')}
        </span>
      </div>
      <p className='line-clamp-2 text-xs leading-relaxed text-muted-foreground'>
        {source.description}
      </p>
    </Card>
  )
})

// Memoized Card component for individual Manga Search Results to prevent unnecessary re-renders
const MangaSearchResultCard = memo(function MangaSearchResultCard({
  manga,
  onCreateProject,
  creatingId,
  t,
}: {
  manga: MangaSearchResult
  onCreateProject: () => void
  creatingId: string | null
  t: any
}) {
  return (
    <div className='group flex gap-4 rounded-xl border border-border/50 bg-card/20 p-3 transition-all duration-300 hover:border-border/80 hover:bg-card/40'>
      {manga.coverUrl ? (
        <img
          src={manga.coverUrl}
          alt={manga.title}
          className='h-24 w-16 shrink-0 rounded-lg border border-border/40 object-cover'
          onError={(e) => {
            ;(e.target as HTMLElement).style.display = 'none'
          }}
        />
      ) : (
        <div className='flex h-24 w-16 shrink-0 items-center justify-center rounded-lg border border-border/30 bg-muted'>
          <BookOpenIcon className='h-6 w-6 text-muted-foreground/40' />
        </div>
      )}

      <div className='flex min-w-0 flex-1 flex-col justify-between py-0.5'>
        <div className='flex flex-col gap-1'>
          <h3 className='truncate text-sm font-semibold text-foreground transition-colors group-hover:text-primary'>
            {manga.title}
          </h3>
          <p className='line-clamp-2 text-xs leading-relaxed text-muted-foreground'>
            {manga.description || t('downloadSource.noDescription')}
          </p>
        </div>
        <div className='mt-2 flex shrink-0 items-center justify-between'>
          <span className='font-mono text-[10px] text-muted-foreground'>
            {t('downloadSource.idLabel')}: {manga.id.substring(0, 8)}...
          </span>
          <Button
            size='sm'
            onClick={onCreateProject}
            disabled={!!creatingId}
            className='h-7.5 cursor-pointer gap-1.5 rounded-lg px-3 text-xs font-medium'
          >
            {creatingId === manga.id ? (
              <>
                <Loader2Icon className='h-3 w-3 animate-spin' />
                {t('downloadSource.creating')}
              </>
            ) : (
              <>
                <PlusIcon className='h-3 w-3' />
                {t('downloadSource.createProject')}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  )
})

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
  const [cloneHaruNekoOpen, setCloneHaruNekoOpen] = useState(false)
  const customPath = usePreferencesStore((state) => state.preferredCustomSavePath)
  const setCustomPath = usePreferencesStore((state) => state.setPreferredCustomSavePath)

  // Performance Optimization: Render list chunks dynamically to eliminate scroll lag
  const [visibleSourceCount, setVisibleSourceCount] = useState(30)
  const [visibleResultCount, setVisibleResultCount] = useState(30)

  // Reset page sizes on query changes or closure
  useEffect(() => {
    setVisibleSourceCount(30)
  }, [sourceSearchQuery])

  useEffect(() => {
    setVisibleResultCount(30)
  }, [debouncedQuery])

  // Reset state when dialog is closed
  useEffect(() => {
    if (!open) {
      setStep('source')
      setSelectedSource(null)
      setSearchQuery('')
      setDebouncedQuery('')
      setSourceSearchQuery('')
      setError(null)
      setVisibleSourceCount(30)
      setVisibleResultCount(30)
    }
  }, [open])

  // Fetch supported sources
  const { data: sources, isLoading: loadingSources } = useListMangaSources({
    query: {
      enabled: open,
    },
  })

  // Filter sources based on sourceSearchQuery
  const filteredSources =
    sources?.filter(
      (source) =>
        source.name.toLowerCase().includes(sourceSearchQuery.toLowerCase()) ||
        source.url.toLowerCase().includes(sourceSearchQuery.toLowerCase()),
    ) ?? []

  const visibleSources = filteredSources.slice(0, visibleSourceCount)

  // Automatically detect pasted URL in the first step and transition to search
  useEffect(() => {
    const q = sourceSearchQuery.trim()
    if (q.startsWith('http://') || q.startsWith('https://')) {
      // Find matched source based on url
      let matchedSource = sources?.find((s) =>
        q.includes(s.url.replace(/^https?:\/\//, '').split('/')[0]),
      )

      // Default to mangadex if not found but is mangadex
      if (!matchedSource && q.includes('mangadex.org')) {
        matchedSource = sources?.find((s) => s.id === 'mangadex')
      }

      // If still not found, fallback to the first source or mangadex
      if (!matchedSource && sources && sources.length > 0) {
        matchedSource = sources.find((s) => s.id === 'mangadex') || sources[0]
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
      },
    },
  )

  const visibleSearchResults = searchResults?.slice(0, visibleResultCount) ?? []

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
        },
      })
      await invalidateScene()
      await invalidateProjects()
      onOpenChange(false)
    } catch (e) {
      console.error(e)
      setError(e instanceof Error ? e.message : t('downloadSource.createProjectFailed'))
    } finally {
      setCreatingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='flex max-h-[85vh] flex-col overflow-hidden rounded-2xl border border-border/50 bg-background/95 p-6 backdrop-blur-xl transition-all duration-300 sm:max-w-2xl'>
        <DialogHeader className='mb-2 shrink-0 border-b border-border/40 pb-4'>
          <div className='flex items-center gap-3'>
            {step === 'search' && (
              <Button
                variant='ghost'
                size='icon'
                onClick={handleBack}
                className='h-8 w-8 shrink-0 cursor-pointer rounded-full border border-border/30 hover:bg-muted/40'
              >
                <ArrowLeftIcon className='h-4 w-4' />
              </Button>
            )}
            <div>
              <DialogTitle className='flex items-center gap-2 text-xl font-semibold tracking-tight text-foreground'>
                <GlobeIcon className='h-5 w-5 shrink-0 text-primary' />
                {step === 'source'
                  ? t('downloadSource.selectSource')
                  : t('downloadSource.searchOn', { source: selectedSource?.name })}
              </DialogTitle>
              <DialogDescription className='mt-0.5 text-xs text-muted-foreground'>
                {step === 'source'
                  ? t('downloadSource.selectSourceDesc')
                  : t('downloadSource.searchOnDesc', { source: selectedSource?.name })}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        {error && (
          <div className='mb-3 flex shrink-0 items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-xs text-destructive'>
            <AlertCircleIcon className='mt-0.5 h-4 w-4 shrink-0' />
            <div className='flex-1 font-medium'>{error}</div>
          </div>
        )}

        {step === 'source' ? (
          <div className='mt-2 flex flex-1 flex-col gap-4 overflow-hidden'>
            {loadingSources ? (
              <div className='flex flex-1 flex-col items-center justify-center gap-3'>
                <Loader2Icon className='h-8 w-8 animate-spin text-primary' />
                <p className='text-xs text-muted-foreground'>
                  {t('downloadSource.loadingSources')}
                </p>
              </div>
            ) : (
              <>
                {/* Auto Sync Banner if only MangaDex is available */}
                {filteredSources.length <= 1 && (
                  <div className='flex shrink-0 flex-col justify-between gap-3 rounded-xl border border-primary/20 bg-primary/5 p-3.5 sm:flex-row sm:items-center'>
                    <div className='flex min-w-0 flex-col gap-0.5'>
                      <h4 className='flex items-center gap-1.5 text-xs leading-none font-semibold text-foreground'>
                        <SparklesIcon className='h-3.5 w-3.5 text-primary' />{' '}
                        {t('haruneko.autoSyncTitle')}
                      </h4>
                      <p className='text-[10px] leading-relaxed text-muted-foreground'>
                        {t('haruneko.autoSyncDescription')}
                      </p>
                    </div>
                    <Button
                      onClick={() => setCloneHaruNekoOpen(true)}
                      size='sm'
                      className='h-8 shrink-0 cursor-pointer rounded-lg border-none bg-primary px-4 text-xs font-semibold text-primary-foreground hover:bg-primary/95'
                    >
                      {t('haruneko.syncTitle')}
                    </Button>
                  </div>
                )}

                {/* Search Input for Sources */}
                <div className='relative flex shrink-0 gap-2'>
                  <div className='relative flex-1'>
                    <SearchIcon className='absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
                    <Input
                      placeholder={t('downloadSource.searchPlaceholder')}
                      value={sourceSearchQuery}
                      onChange={(e) => setSourceSearchQuery(e.target.value)}
                      className='h-10 w-full rounded-xl border-none bg-card/40 pr-20 pl-10 text-xs shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0'
                    />
                    <Button
                      type='button'
                      variant='ghost'
                      size='sm'
                      onClick={async () => {
                        try {
                          const text = await navigator.clipboard.readText()
                          if (text) setSourceSearchQuery(text)
                        } catch (err) {
                          console.error('Failed to read clipboard', err)
                        }
                      }}
                      className='absolute top-1/2 right-1.5 h-7 -translate-y-1/2 cursor-pointer rounded-lg border-none bg-primary/15 px-2 text-[10px] font-medium text-primary hover:bg-primary/25'
                    >
                      {t('downloadSource.pasteLink')}
                    </Button>
                  </div>
                </div>

                <div
                  className='flex-1 overflow-y-auto pr-1'
                  onScroll={(e) => {
                    const target = e.currentTarget
                    if (target.scrollHeight - target.scrollTop <= target.clientHeight + 100) {
                      setVisibleSourceCount((prev) => Math.min(prev + 30, filteredSources.length))
                    }
                  }}
                >
                  {visibleSources.length > 0 ? (
                    <div className='grid grid-cols-1 gap-4 pb-2 sm:grid-cols-2'>
                      {visibleSources.map((source) => (
                        <MangaSourceCard
                          key={source.id}
                          source={source}
                          onClick={() => handleSelectSource(source)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className='flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center'>
                      <SearchIcon className='h-8 w-8 shrink-0 text-muted-foreground/40' />
                      <p className='text-xs font-semibold text-foreground'>
                        {t('downloadSource.noSourcesFoundTitle')}
                      </p>
                      <p className='max-w-xs text-[11px] leading-relaxed text-muted-foreground'>
                        {t('downloadSource.noSourcesFoundDesc')}
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        ) : (
          <div className='mt-2 flex flex-1 flex-col gap-4 overflow-hidden'>
            {/* Search Input */}
            <div className='relative flex shrink-0 gap-2'>
              <div className='relative flex-1'>
                <SearchIcon className='absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-muted-foreground' />
                <Input
                  autoFocus
                  placeholder={t('downloadSource.searchMangaPlaceholder')}
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`pl-10 ${isSearching ? 'pr-24' : 'pr-16'} h-11 w-full rounded-xl border-none bg-card/40 shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0`}
                />
                {isSearching && (
                  <Loader2Icon
                    className={`absolute ${isSearching ? 'right-16' : 'right-3.5'} top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-primary`}
                  />
                )}
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  onClick={async () => {
                    try {
                      const text = await navigator.clipboard.readText()
                      if (text) setSearchQuery(text)
                    } catch (err) {
                      console.error('Failed to read clipboard', err)
                    }
                  }}
                  className='absolute top-1/2 right-1.5 h-8 -translate-y-1/2 cursor-pointer rounded-lg border-none bg-primary/15 px-2.5 text-xs font-medium text-primary hover:bg-primary/25'
                >
                  {t('downloadSource.paste')}
                </Button>
              </div>
            </div>

            {/* Custom save directory selector */}
            <div className='flex shrink-0 items-center justify-between gap-3 rounded-xl border border-border/40 bg-card/10 p-3'>
              <div className='flex min-w-0 items-center gap-2.5'>
                <FolderIcon className='h-4.5 w-4.5 shrink-0 text-primary' />
                <div className='flex min-w-0 flex-col'>
                  <span className='text-xs font-semibold text-foreground'>
                    {t('downloadSource.projectPath')}
                  </span>
                  <span className='truncate font-mono text-[10px] text-muted-foreground'>
                    {customPath || t('downloadSource.defaultPath')}
                  </span>
                </div>
              </div>
              <Button
                variant='outline'
                size='sm'
                onClick={handleSelectFolder}
                className='h-8 shrink-0 cursor-pointer rounded-lg border-border/50 text-xs font-medium hover:bg-muted/40'
              >
                {t('downloadSource.change')}
              </Button>
            </div>

            {/* Results */}
            <div className='flex min-h-[250px] flex-1 flex-col overflow-hidden'>
              {debouncedQuery.trim().length === 0 ? (
                <div className='flex flex-1 flex-col items-center justify-center gap-3 text-center'>
                  <BookOpenIcon className='h-10 w-10 shrink-0 text-muted-foreground/60' />
                  <p className='max-w-xs text-xs leading-relaxed text-muted-foreground'>
                    {t('downloadSource.mangaSearchHint', { source: selectedSource?.name })}
                  </p>
                </div>
              ) : isSearching && !searchResults ? (
                <div className='flex flex-1 flex-col items-center justify-center gap-3'>
                  <Loader2Icon className='h-8 w-8 animate-spin text-primary' />
                  <p className='text-xs text-muted-foreground'>{t('downloadSource.searching')}</p>
                </div>
              ) : searchResults && searchResults.length > 0 ? (
                <div
                  className='flex-1 overflow-y-auto pr-1'
                  onScroll={(e) => {
                    const target = e.currentTarget
                    if (target.scrollHeight - target.scrollTop <= target.clientHeight + 100) {
                      setVisibleResultCount((prev) =>
                        Math.min(prev + 30, searchResults?.length ?? 0),
                      )
                    }
                  }}
                >
                  <div className='flex flex-col gap-3 pb-2'>
                    {visibleSearchResults.map((manga) => (
                      <MangaSearchResultCard
                        key={manga.id}
                        manga={manga}
                        onCreateProject={() => handleCreateProject(manga)}
                        creatingId={creatingId}
                        t={t}
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className='flex flex-1 flex-col items-center justify-center gap-2 text-center'>
                  <SearchIcon className='h-8 w-8 shrink-0 text-muted-foreground/40' />
                  <p className='text-xs font-medium text-foreground'>
                    {t('downloadSource.noResultsTitle')}
                  </p>
                  <p className='max-w-xs text-[11px] leading-relaxed text-muted-foreground'>
                    {t('downloadSource.noResultsDesc')}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
      <CloneHaruNekoDialog
        open={cloneHaruNekoOpen}
        onOpenChange={(val) => {
          setCloneHaruNekoOpen(val)
          if (!val) {
            // Trigger refetch so newly synced sources load immediately!
            window.location.reload()
          }
        }}
      />
    </Dialog>
  )
}
