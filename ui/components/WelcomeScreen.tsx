'use client'

import {
  AlertCircleIcon,
  ClockIcon,
  DownloadIcon,
  FileArchiveIcon,
  FolderIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import Image from 'next/image'
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

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
import { useListProjects } from '@/lib/api/default/default'
import type { ProjectSummary } from '@/lib/api/schemas'
import { importKhrFile } from '@/lib/io/pagesIo'
import { createAndOpenProject, switchProject, deleteProjectById, importFolderAsProject } from '@/lib/io/scene'
import { cn } from '@/lib/utils'
import { isTauri } from '@/lib/backend'
import { DownloadSourceDialog } from '@/components/DownloadSourceDialog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'

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
  const [searchQuery, setSearchQuery] = useState('')

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects
    const q = searchQuery.toLowerCase()
    return projects.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q)
    )
  }, [projects, searchQuery])

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

  return (
    <div className='flex min-h-0 flex-1 overflow-hidden bg-background'>
      {/* ── Left Sidebar ── */}
      <aside className='flex w-52 shrink-0 flex-col border-r border-border/50 bg-muted/30'>
        {/* Branding */}
        <div className='flex items-center gap-2.5 px-4 pt-5 pb-4'>
          <Image src='/icon.png' alt='Koharu' width={32} height={32} priority className='shrink-0' />
          <div className='flex flex-col min-w-0'>
            <span className='text-sm font-semibold tracking-tight text-foreground leading-tight'>
              {t('welcome.title')}
            </span>
            <span className='text-[10px] text-muted-foreground/70 leading-tight'>
              {t('welcome.subtitle')}
            </span>
          </div>
        </div>

        {/* Sidebar Navigation */}
        <nav className='flex flex-col px-2 gap-0.5'>
          <SidebarItem active label={t('welcome.projects')} />
        </nav>

        {/* Spacer */}
        <div className='flex-1' />

        {/* Sidebar Footer — version or settings could go here */}
        <div className='px-4 py-3'>
          <p className='text-[10px] text-muted-foreground/50 select-none'>
            Manga Translation Workspace
          </p>
        </div>
      </aside>

      {/* ── Main Content ── */}
      <main className='flex min-w-0 flex-1 flex-col'>
        {/* Top Bar: Search + Action Buttons */}
        <div className='flex items-center gap-2 border-b border-border/40 px-4 py-2.5'>
          {/* Search */}
          <div className='relative flex-1 max-w-xs'>
            <SearchIcon className='absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60' />
            <input
              type='text'
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder='Tìm kiếm dự án...'
              className={cn(
                'h-8 w-full rounded-md border border-border/50 bg-background pl-8 pr-3 text-xs text-foreground outline-none',
                'placeholder:text-muted-foreground/50',
                'focus:border-primary/50 focus:ring-1 focus:ring-primary/20',
                'transition-colors duration-150',
              )}
            />
            {searchQuery && (
              <button
                type='button'
                onClick={() => setSearchQuery('')}
                className='absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground cursor-pointer'
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
            label='Tải từ mạng'
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
              label={t('welcome.importFolder') || 'Import Folder'}
              variant='ghost'
            />
          )}
        </div>

        {/* Error Banner */}
        {error && (
          <div className='flex items-start gap-2 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive'>
            <AlertCircleIcon className='mt-0.5 h-3.5 w-3.5 shrink-0' />
            <div className='flex-1'>{error}</div>
            <button
              type='button'
              onClick={() => setError(null)}
              className='cursor-pointer text-destructive/70 hover:text-destructive'
              aria-label='dismiss'
            >
              <XIcon className='h-3.5 w-3.5' />
            </button>
          </div>
        )}

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
                  disabled={busy === 'open'}
                  highlight={searchQuery}
                />
              ))}
            </ul>
          ) : searchQuery ? (
            <div className='flex flex-col items-center justify-center py-16 text-muted-foreground/60'>
              <SearchIcon className='h-8 w-8 mb-2 opacity-40' />
              <p className='text-xs'>Không tìm thấy dự án phù hợp</p>
            </div>
          ) : (
            <EmptyState />
          )}
        </ScrollArea>
      </main>

      {/* ── Dialogs ── */}
      <NewProjectDialog
        open={newDialogOpen}
        onOpenChange={setNewDialogOpen}
        onSubmit={onCreate}
        busy={busy === 'new'}
      />

      <DownloadSourceDialog
        open={downloadSourceOpen}
        onOpenChange={setDownloadSourceOpen}
      />

      <Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
        <DialogContent className='sm:max-w-md'>
          <DialogHeader>
            <DialogTitle>Xóa dự án</DialogTitle>
            <DialogDescription>
              Bạn có chắc muốn xóa dự án này? Tất cả dữ liệu scene, layer, ảnh và bản dịch sẽ bị xóa vĩnh viễn. Thao tác này không thể hoàn tác.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={() => setDeleteConfirmOpen(false)}>
              Hủy
            </Button>
            <Button variant='destructive' onClick={onDeleteConfirm}>
              Xóa vĩnh viễn
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

function SidebarItem({ label, active }: { label: string; active?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium select-none',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
      )}
    >
      {label}
    </div>
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
      <div className='flex items-center justify-center w-12 h-12 rounded-xl bg-muted/50 mb-3'>
        <FolderIcon className='h-6 w-6 opacity-40' />
      </div>
      <p className='text-xs mb-0.5 font-medium'>{t('welcome.emptyHint')}</p>
      <p className='text-[10px] text-muted-foreground/40'>Tạo dự án mới hoặc nhập tệp để bắt đầu</p>
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
  disabled,
  highlight,
}: {
  project: ProjectSummary
  onOpen: (id: string) => void
  onDelete?: (id: string) => void
  disabled?: boolean
  highlight?: string
}) {
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
        <div className='flex min-w-0 flex-1 flex-col gap-0'>
          <div className='truncate text-sm font-medium text-foreground leading-snug' title={project.name}>
            {highlight ? highlightText(project.name, highlight) : project.name}
          </div>
          <div className='truncate text-[11px] text-muted-foreground/60 font-mono leading-snug' title={project.id}>
            {project.id}
          </div>
        </div>

        {/* Timestamp */}
        {when && (
          <div className='flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/50'>
            <ClockIcon className='h-3 w-3' />
            {formatRelative(when)}
          </div>
        )}
      </button>

      {/* Delete button — visible on hover */}
      {onDelete && (
        <div className='flex shrink-0 items-center pr-2'>
          <Button
            variant='ghost'
            size='icon'
            className='h-7 w-7 text-muted-foreground/40 opacity-0 group-hover/row:opacity-100 hover:text-destructive hover:bg-destructive/10 transition-all duration-150 cursor-pointer rounded-md'
            onClick={(e) => {
              e.stopPropagation()
              onDelete(project.id)
            }}
            disabled={disabled}
            title='Xóa dự án'
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
      <ContextMenuTrigger asChild>
        {content}
      </ContextMenuTrigger>
      <ContextMenuContent className='w-44 bg-popover border border-border/80 shadow-md rounded-xl p-1'>
        <ContextMenuItem
          onClick={() => onOpen(project.id)}
          disabled={disabled}
          className='text-xs py-1.5 px-2.5 rounded-lg cursor-pointer'
        >
          Mở dự án
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() => onDelete(project.id)}
          disabled={disabled}
          className='text-xs py-1.5 px-2.5 rounded-lg text-destructive focus:text-destructive-foreground focus:bg-destructive cursor-pointer flex items-center'
        >
          <Trash2Icon className='mr-2 h-3.5 w-3.5 shrink-0' />
          Xóa dự án
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
  const parts = name.trim().split(/[\s_\-]+/).filter(Boolean)
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
      <span className='bg-yellow-300/30 text-yellow-600 dark:bg-yellow-500/20 dark:text-yellow-400 rounded-sm px-0.5'>
        {text.slice(idx, idx + query.length)}
      </span>
      {text.slice(idx + query.length)}
    </>
  )
}

function formatRelative(d: Date): string {
  const diff = Date.now() - d.getTime()
  const m = 60_000
  const h = 3_600_000
  const day = 86_400_000
  if (diff < m) return 'vừa xong'
  if (diff < h) return `${Math.floor(diff / m)} phút`
  if (diff < day) return `${Math.floor(diff / h)} giờ`
  if (diff < day * 30) return `${Math.floor(diff / day)} ngày`
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
