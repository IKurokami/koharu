'use client'

import {
  AlertCircleIcon,
  ClockIcon,
  DownloadIcon,
  FileArchiveIcon,
  FolderIcon,
  FolderOpenIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
  SettingsIcon,
  PenIcon,
} from 'lucide-react'
import Image from 'next/image'
import { useCallback, useMemo, useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { DownloadSourceDialog } from '@/components/DownloadSourceDialog'
import { FlickeringGrid } from '@/components/FlickeringGrid'
import { SettingsDialog, type TabId } from '@/components/SettingsDialog'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
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
import { useListProjects } from '@/lib/api/default/default'
import type { ProjectSummary } from '@/lib/api/schemas'
import { isTauri } from '@/lib/backend'
import { importKhrFile } from '@/lib/io/pagesIo'
import {
  createAndOpenProject,
  switchProject,
  deleteProjectById,
  importFolderAsProject,
  renameProjectById,
} from '@/lib/io/scene'
import { cn } from '@/lib/utils'

type Busy = false | 'new' | 'open' | 'import'

/**
 * Project-management / welcome screen. Rendered when no project is open.
 * JetBrains Rider-inspired layout: sidebar with branding + actions,
 * main area with search and project list.
 */
export function WelcomeScreen() {
  const { t } = useTranslation()
  const { data: projectsData, refetch: refetchProjects } = useListProjects()
  const projects = useMemo(() => {
    const all = projectsData?.projects ?? []
    return [...all].sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0))
  }, [projectsData])

  const [busy, setBusy] = useState<Busy>(false)
  const [error, setError] = useState<string | null>(null)
  const [newDialogOpen, setNewDialogOpen] = useState(false)
  const [downloadSourceOpen, setDownloadSourceOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<string | null>(null)
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [projectToRename, setProjectToRename] = useState<{ id: string; name: string } | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<TabId>('appearance')
  const [activeFilter, setActiveFilter] = useState<'all' | 'manual' | 'imported' | 'downloaded'>(
    'all',
  )

  const filteredProjects = useMemo(() => {
    let list = projects
    if (activeFilter !== 'all') {
      list = projects.filter((p) => p.projectType === activeFilter)
    }
    if (!searchQuery.trim()) return list
    const q = searchQuery.toLowerCase()
    return list.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
  }, [projects, searchQuery, activeFilter])

  const onDeleteConfirm = useCallback(async () => {
    if (!projectToDelete) return
    setError(null)
    setBusy('open')
    try {
      await deleteProjectById(projectToDelete)
      await refetchProjects()
    } catch (e) {
      setError(`Delete failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
      setDeleteConfirmOpen(false)
      setProjectToDelete(null)
    }
  }, [projectToDelete, refetchProjects])

  const openById = useCallback(async (id: string) => {
    setError(null)
    setBusy('open')
    try {
      await switchProject({ id })
    } catch (e) {
      setError(`Open failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [])

  const onCreate = useCallback(async (name: string) => {
    setError(null)
    setBusy('new')
    try {
      await createAndOpenProject({ name })
    } catch (e) {
      setError(`New failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
      setNewDialogOpen(false)
    }
  }, [])

  const importKhr = useCallback(async () => {
    setError(null)
    setBusy('import')
    try {
      await importKhrFile()
      await refetchProjects()
    } catch (e) {
      setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [refetchProjects])

  const importFolder = useCallback(async () => {
    setError(null)
    setBusy('import')
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const folder = await open({ directory: true, multiple: false })
      if (!folder || typeof folder !== 'string') {
        setBusy(false)
        return
      }
      await importFolderAsProject({ path: folder })
      await refetchProjects()
    } catch (e) {
      setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [refetchProjects])

  const onRevealFolder = useCallback(async (path: string) => {
    try {
      if (isTauri()) {
        const { revealItemInDir } = await import('@tauri-apps/plugin-opener')
        await revealItemInDir(path)
      }
    } catch (e) {
      setError(`Failed to open folder: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  return (
    <div className='relative flex min-h-0 flex-1 overflow-hidden bg-background'>
      {/* Animated Flickering Grid Background */}
      <div className='pointer-events-none absolute inset-0 z-0 opacity-35 dark:opacity-[0.18]'>
        <FlickeringGrid
          squareSize={4}
          gridGap={6}
          flickerChance={0.25}
          color='rgb(99, 102, 241)'
          maxOpacity={0.25}
        />
      </div>

      {/* ── Left Sidebar ── */}
      <aside className='relative z-10 flex w-52 shrink-0 flex-col border-r border-border/50 bg-[#fbfbfb] dark:bg-[#252425]'>
        {/* Branding */}
        <div className='flex items-center gap-2.5 px-4 pt-5 pb-4'>
          <Image
            src='/icon.png'
            alt='Koharu'
            width={32}
            height={32}
            priority
            className='shrink-0'
          />
          <div className='flex min-w-0 flex-col'>
            <span className='text-sm leading-tight font-semibold tracking-tight text-foreground'>
              {t('welcome.title')}
            </span>
            <span className='text-[10px] leading-tight text-muted-foreground/70'>
              {t('welcome.subtitle')}
            </span>
          </div>
        </div>

        {/* Sidebar Navigation */}
        <nav className='flex flex-col gap-1 px-2'>
          <SidebarItem
            active={activeFilter === 'all'}
            label={t('welcome.allProjects')}
            icon={<ClockIcon className='h-4 w-4' />}
            onClick={() => setActiveFilter('all')}
          />
          <SidebarItem
            active={activeFilter === 'manual'}
            label={t('welcome.manualProjects')}
            icon={<PenIcon className='h-4 w-4' />}
            onClick={() => setActiveFilter('manual')}
          />
          <SidebarItem
            active={activeFilter === 'imported'}
            label={t('welcome.importedProjects')}
            icon={<FolderOpenIcon className='h-4 w-4' />}
            onClick={() => setActiveFilter('imported')}
          />
          <SidebarItem
            active={activeFilter === 'downloaded'}
            label={t('welcome.downloadedProjects')}
            icon={<DownloadIcon className='h-4 w-4' />}
            onClick={() => setActiveFilter('downloaded')}
          />
        </nav>

        {/* Spacer */}
        <div className='flex-1' />

        {/* Bottom Actions like Rider */}
        <div className='mt-auto flex flex-col gap-0.5 border-t border-border/40 p-2 select-none'>
          <button
            onClick={() => {
              setSettingsTab('appearance')
              setSettingsOpen(true)
            }}
            className='flex w-full cursor-pointer items-center gap-2 rounded px-2.5 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-all duration-200 hover:bg-muted/50 hover:text-foreground'
          >
            <SettingsIcon className='h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground' />
            <span className='flex-1'>{t('menu.settings')}</span>
          </button>
        </div>
      </aside>

      <main
        className={cn(
          'relative z-10 flex min-w-0 flex-1 flex-col justify-start',
          projects.length > 0 ? 'pt-0' : 'pt-[12vh]',
        )}
      >
        {/* Error Banner */}
        {error && (
          <div className='flex shrink-0 items-start gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive'>
            <AlertCircleIcon className='mt-0.5 h-3.5 w-3.5 shrink-0' />
            <div className='flex-1'>{error}</div>
            <button
              type='button'
              onClick={() => setError(null)}
              className='cursor-pointer text-destructive/70 hover:text-destructive'
              aria-label={t('errors.dismiss')}
            >
              <XIcon className='h-3.5 w-3.5' />
            </button>
          </div>
        )}

        {projects.length > 0 ? (
          <>
            {/* Top Bar: Search + Action Buttons */}
            <div className='flex shrink-0 items-center gap-2 border-b border-border/40 px-4 py-2.5'>
              {/* Search */}
              <div className='relative max-w-xs flex-1'>
                <SearchIcon className='absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60' />
                <input
                  type='text'
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('welcome.searchProjects')}
                  className={cn(
                    'h-8 w-full rounded-md border border-border/50 bg-background pr-3 pl-8 text-xs text-foreground outline-none',
                    'placeholder:text-muted-foreground/50',
                    'focus:border-primary/50 focus:ring-1 focus:ring-primary/20',
                    'transition-colors duration-150',
                  )}
                />
                {searchQuery && (
                  <button
                    type='button'
                    onClick={() => setSearchQuery('')}
                    className='absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer text-muted-foreground/50 hover:text-muted-foreground'
                  >
                    <XIcon className='h-3 w-3' />
                  </button>
                )}
              </div>

              {/* Action Buttons */}
              <ActionButton
                onClick={() => setNewDialogOpen(true)}
                disabled={!!busy}
                icon={<PlusIcon className='h-3.5 w-3.5' />}
                label={t('welcome.new')}
              />
              <ActionButton
                onClick={() => setDownloadSourceOpen(true)}
                disabled={!!busy}
                icon={<DownloadIcon className='h-3.5 w-3.5' />}
                label={t('welcome.downloadFromWeb')}
              />
              <ActionButton
                onClick={importKhr}
                disabled={!!busy}
                icon={<FileArchiveIcon className='h-3.5 w-3.5' />}
                label={t('welcome.importKhr')}
                variant='ghost'
              />
              {isTauri() && (
                <ActionButton
                  onClick={importFolder}
                  disabled={!!busy}
                  icon={<FolderIcon className='h-3.5 w-3.5' />}
                  label={t('welcome.importFolder')}
                  variant='ghost'
                />
              )}
            </div>

            {/* Project List */}
            <ScrollArea className='flex-1'>
              {filteredProjects.length > 0 ? (
                <ul className='flex flex-col'>
                  {filteredProjects.map((p) => (
                    <ProjectRow
                      key={p.id}
                      project={p}
                      onOpen={openById}
                      onDelete={(id) => {
                        setProjectToDelete(id)
                        setDeleteConfirmOpen(true)
                      }}
                      onRename={(id, name) => {
                        setProjectToRename({ id, name })
                        setRenameDialogOpen(true)
                      }}
                      onRevealFolder={onRevealFolder}
                      disabled={busy === 'open'}
                      highlight={searchQuery}
                    />
                  ))}
                </ul>
              ) : (
                <div className='flex flex-col items-center justify-center py-16 text-muted-foreground/60'>
                  <SearchIcon className='mb-2 h-8 w-8 opacity-40' />
                  <p className='text-xs'>{t('welcome.noMatchingProjects')}</p>
                </div>
              )}
            </ScrollArea>
          </>
        ) : (
          <div className='mx-auto flex max-w-2xl flex-col items-center justify-center px-8 py-12 text-center'>
            <h1 className='mb-4 text-4xl font-bold tracking-tight text-foreground select-none'>
              {t('welcome.emptyTitle')}
            </h1>
            <p className='mb-12 max-w-md text-sm leading-relaxed whitespace-pre-line text-muted-foreground/80 select-none'>
              {t('welcome.emptyDescription')}
            </p>

            <div className='flex items-center justify-center gap-12'>
              {/* New Project Card */}
              <button
                onClick={() => setNewDialogOpen(true)}
                className='group flex cursor-pointer flex-col items-center gap-3 focus:outline-none'
              >
                <div className='flex h-20 w-20 items-center justify-center rounded-2xl border border-primary/40 bg-primary/5 shadow-md transition-all duration-300'>
                  <PlusIcon className='h-8 w-8 text-primary transition-transform duration-300 group-hover:scale-110' />
                </div>
                <span className='text-xs font-semibold text-foreground/80 transition-colors group-hover:text-primary'>
                  {t('welcome.new')}
                </span>
              </button>

              {/* Open/Import Card */}
              <button
                onClick={isTauri() ? importFolder : importKhr}
                className='group flex cursor-pointer flex-col items-center gap-3 focus:outline-none'
              >
                <div className='flex h-20 w-20 items-center justify-center rounded-2xl border border-border bg-card shadow-sm transition-all duration-300'>
                  <FolderIcon className='h-8 w-8 text-muted-foreground/75 transition-colors transition-transform duration-300 group-hover:scale-110 group-hover:text-primary' />
                </div>
                <span className='text-xs font-semibold text-foreground/80 transition-colors group-hover:text-primary'>
                  {isTauri() ? t('menu.open') : t('welcome.importKhr')}
                </span>
              </button>

              {/* Get from VCS / Network Card */}
              <button
                onClick={() => setDownloadSourceOpen(true)}
                className='group flex cursor-pointer flex-col items-center gap-3 focus:outline-none'
              >
                <div className='flex h-20 w-20 items-center justify-center rounded-2xl border border-border bg-card shadow-sm transition-all duration-300'>
                  <DownloadIcon className='h-8 w-8 text-muted-foreground/75 transition-colors transition-transform duration-300 group-hover:scale-110 group-hover:text-primary' />
                </div>
                <span className='text-xs font-semibold text-foreground/80 transition-colors group-hover:text-primary'>
                  {t('welcome.downloadFromWeb')}
                </span>
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ── Dialogs ── */}
      <NewProjectDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        onSubmit={onCreate}
        busy={busy === 'new'}
      />

      <RenameProjectDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        onSubmit={async (newName) => {
          if (!projectToRename) return
          setError(null)
          setBusy('open')
          try {
            await renameProjectById(projectToRename.id, newName)
            await refetchProjects()
          } catch (e) {
            setError(
              t('welcome.renameFailed', { message: e instanceof Error ? e.message : String(e) }),
            )
          } finally {
            setBusy(false)
            setRenameDialogOpen(false)
            setProjectToRename(null)
          }
        }}
        initialName={projectToRename?.name ?? ''}
        busy={!!busy}
      />

      <DownloadSourceDialog open={downloadSourceOpen} onOpenChange={setDownloadSourceOpen} />

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} defaultTab={settingsTab} />

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>{t('welcome.deleteProjectTitle')}</DialogTitle>
            <DialogDescription>{t('welcome.deleteProjectConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => setDeleteConfirmOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant='destructive' onClick={onDeleteConfirm}>
              {t('welcome.deleteProjectForever')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sidebar Item
// ---------------------------------------------------------------------------

function SidebarItem({
  label,
  active,
  icon,
  onClick,
}: {
  label: string
  active?: boolean
  icon: React.ReactNode
  onClick?: () => void
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left text-xs font-medium transition-all duration-150 select-none',
        active
          ? 'bg-primary/10 font-semibold text-primary'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
    >
      <span className={cn('h-4 w-4', active ? 'text-primary' : 'text-muted-foreground/75')}>
        {icon}
      </span>
      <span className='flex-1 truncate'>{label}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Top Bar Action Button
// ---------------------------------------------------------------------------

function ActionButton({
  onClick,
  disabled,
  icon,
  label,
  variant = 'outline',
}: {
  onClick: () => void
  disabled?: boolean
  icon: React.ReactNode
  label: string
  variant?: 'outline' | 'ghost'
}) {
  return (
    <Button
      type='button'
      variant={variant}
      size='sm'
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'h-8 gap-1.5 text-xs font-medium',
        variant === 'ghost' && 'text-muted-foreground',
      )}
    >
      {icon}
      <span className='hidden sm:inline'>{label}</span>
    </Button>
  )
}

// ---------------------------------------------------------------------------
// Empty State (no projects)
// ---------------------------------------------------------------------------

function EmptyState() {
  const { t } = useTranslation()
  return (
    <div className='flex flex-col items-center justify-center py-20 text-muted-foreground/60'>
      <div className='mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-muted/50'>
        <FolderIcon className='h-6 w-6 opacity-40' />
      </div>
      <p className='mb-0.5 text-xs font-medium'>{t('welcome.emptyHint')}</p>
      <p className='text-[10px] text-muted-foreground/40'>{t('welcome.newProjectSubtitle')}</p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Project Row
// ---------------------------------------------------------------------------

function ProjectRow({
  project,
  onOpen,
  onDelete,
  onRename,
  onRevealFolder,
  disabled,
  highlight,
}: {
  project: ProjectSummary
  onOpen: (id: string) => void
  onDelete?: (id: string) => void
  onRename?: (id: string, name: string) => void
  onRevealFolder?: (path: string) => void
  disabled?: boolean
  highlight?: string
}) {
  const { t } = useTranslation()
  const when = project.updatedAtMs && project.updatedAtMs > 0 ? new Date(project.updatedAtMs) : null

  const content = (
    <li
      className={cn(
        'group/row relative flex w-full items-center border-b border-border/30',
        'transition-colors duration-100',
        'hover:bg-primary/5',
      )}
    >
      <button
        type='button'
        onClick={() => onOpen(project.id)}
        disabled={disabled}
        className='flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-2.5 text-left outline-none disabled:cursor-not-allowed disabled:opacity-60'
      >
        {/* Color badge */}
        <div
          className='flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-bold text-white select-none'
          style={{
            backgroundColor: stringToColor(project.name),
          }}
        >
          {getInitials(project.name)}
        </div>

        {/* Name + path */}
        <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
          <div className='flex min-w-0 items-center gap-2'>
            <div
              className='truncate text-sm leading-snug font-medium text-foreground'
              title={project.name}
            >
              {highlight ? highlightText(project.name, highlight) : project.name}
            </div>
            {project.projectType && (
              <span
                className={cn(
                  'shrink-0 rounded border px-1.5 py-0.5 text-[9px] font-semibold tracking-wide uppercase select-none',
                  project.projectType === 'manual' &&
                    'border-emerald-500/20 bg-emerald-500/10 text-emerald-500 dark:bg-emerald-500/15',
                  project.projectType === 'imported' &&
                    'border-blue-500/20 bg-blue-500/10 text-blue-500 dark:bg-blue-500/15',
                  project.projectType === 'downloaded' &&
                    'border-purple-500/20 bg-purple-500/10 text-purple-500 dark:bg-purple-500/15',
                )}
              >
                {project.projectType === 'manual' && t('welcome.manualProjects')}
                {project.projectType === 'imported' && t('welcome.importedProjects')}
                {project.projectType === 'downloaded' && t('welcome.downloadedProjects')}
              </span>
            )}
          </div>
          <div
            className='truncate font-mono text-[11px] leading-snug text-muted-foreground/60'
            title={
              project.projectType === 'imported' && project.syncDir ? project.syncDir : project.id
            }
          >
            {project.projectType === 'imported' && project.syncDir ? project.syncDir : project.id}
          </div>
        </div>

        {/* Timestamp */}
        {when && (
          <div className='flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/50'>
            <ClockIcon className='h-3 w-3' />
            {formatRelative(when, t)}
          </div>
        )}
      </button>

      {/* Delete button — visible on hover */}
      {onDelete && (
        <div className='flex shrink-0 items-center pr-2'>
          <Button
            variant='ghost'
            size='icon'
            className='h-7 w-7 cursor-pointer rounded-md text-muted-foreground/40 opacity-0 transition-all duration-150 group-hover/row:opacity-100 hover:bg-destructive/10 hover:text-destructive'
            onClick={(e) => {
              e.stopPropagation()
              onDelete(project.id)
            }}
            disabled={disabled}
            title={t('welcome.deleteProject')}
          >
            <Trash2Icon className='h-3.5 w-3.5' />
          </Button>
        </div>
      )}
    </li>
  )

  if (!onDelete) {
    return content
  }

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{content}</ContextMenuTrigger>
      <ContextMenuContent className='w-44 rounded-xl border border-border/80 bg-popover p-1 shadow-md'>
        <ContextMenuItem
          onClick={() => onOpen(project.id)}
          disabled={disabled}
          className='flex cursor-pointer items-center rounded-lg px-2.5 py-1.5 text-xs hover:text-black focus:text-black dark:hover:text-white dark:focus:text-white'
        >
          <FolderIcon className='mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground' />
          {t('welcome.openProject')}
        </ContextMenuItem>
        {onRevealFolder && (
          <ContextMenuItem
            onClick={() => onRevealFolder(project.path)}
            disabled={disabled}
            className='flex cursor-pointer items-center rounded-lg px-2.5 py-1.5 text-xs hover:text-black focus:text-black dark:hover:text-white dark:focus:text-white'
          >
            <FolderOpenIcon className='mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground' />
            {t('welcome.openFolder')}
          </ContextMenuItem>
        )}
        {onRename && (
          <ContextMenuItem
            onClick={() => onRename(project.id, project.name)}
            disabled={disabled}
            className='flex cursor-pointer items-center rounded-lg px-2.5 py-1.5 text-xs hover:text-black focus:text-black dark:hover:text-white dark:focus:text-white'
          >
            <PenIcon className='mr-2 h-3.5 w-3.5 shrink-0 text-muted-foreground' />
            {t('welcome.renameProject')}
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onClick={() => onDelete(project.id)}
          disabled={disabled}
          className='flex cursor-pointer items-center rounded-lg px-2.5 py-1.5 text-xs text-destructive hover:bg-destructive/15 hover:text-black focus:bg-destructive/15 focus:text-black dark:hover:text-white dark:focus:text-white'
        >
          <Trash2Icon className='mr-2 h-3.5 w-3.5 shrink-0' />
          {t('welcome.deleteProject')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a deterministic color from a string (for project badges). */
function stringToColor(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  const hue = Math.abs(hash) % 360
  return `hsl(${hue}, 55%, 50%)`
}

/** Get 1–2 character initials from a project name. */
function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/[\s_\-]+/)
    .filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }
  return name.slice(0, 2).toUpperCase()
}

/** Highlight matching text within a string. */
function highlightText(text: string, query: string): React.ReactNode {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <span className='rounded-sm bg-yellow-300/30 px-0.5 text-yellow-600 dark:bg-yellow-500/20 dark:text-yellow-400'>
        {text.slice(idx, idx + query.length)}
      </span>
      {text.slice(idx + query.length)}
    </>
  )
}

function formatRelative(d: Date, t: any): string {
  const diff = Date.now() - d.getTime()
  const m = 60_000
  const h = 3_600_000
  const day = 86_400_000
  if (diff < m) return t('welcome.time.justNow')
  if (diff < h) return t('welcome.time.minutes', { count: Math.floor(diff / m) })
  if (diff < day) return t('welcome.time.hours', { count: Math.floor(diff / h) })
  if (diff < day * 30) return t('welcome.time.days', { count: Math.floor(diff / day) })
  return d.toLocaleDateString()
}

// ---------------------------------------------------------------------------
// New Project Dialog
// ---------------------------------------------------------------------------

function NewProjectDialog({
  open,
  onOpenChange,
  onSubmit,
  busy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
  busy: boolean
}) {
  const { t } = useTranslation()
  const [name, setName] = useState('')

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !busy

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) setName('')
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('welcome.newDialogTitle')}</DialogTitle>
          <DialogDescription>{t('welcome.newDialogDescription')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) onSubmit(trimmed)
          }}
          className='flex flex-col gap-4'
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('welcome.newDialogPlaceholder')}
          />
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type='submit' disabled={!canSubmit}>
              <PlusIcon className='h-3.5 w-3.5' />
              {t('welcome.newDialogSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Rename Project Dialog
// ---------------------------------------------------------------------------

function RenameProjectDialog({
  open,
  onOpenChange,
  onSubmit,
  initialName,
  busy,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (name: string) => void
  initialName: string
  busy: boolean
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initialName)

  useEffect(() => {
    setName(initialName)
  }, [initialName])

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !busy

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) setName('')
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle>{t('welcome.renameProject')}</DialogTitle>
          <DialogDescription>{t('welcome.renameProjectDescription')}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) onSubmit(trimmed)
          }}
          className='flex flex-col gap-4'
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('welcome.newDialogPlaceholder')}
          />
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type='submit' disabled={!canSubmit}>
              <PenIcon className='mr-1.5 h-3.5 w-3.5' />
              {t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
