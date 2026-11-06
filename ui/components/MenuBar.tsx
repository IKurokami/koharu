'use client'

import {
  CopyIcon,
  MinusIcon,
  SquareIcon,
  XIcon,
  BookOpenIcon,
  FileTextIcon,
  FolderOpenIcon,
  SaveIcon,
  DownloadIcon,
  XCircleIcon,
  SettingsIcon,
  CloudLightningIcon,
  UndoIcon,
  RedoIcon,
  CheckSquareIcon,
  Maximize2Icon,
  MinimizeIcon,
  PlayIcon,
  RefreshCwIcon,
  FlameIcon,
  ExternalLinkIcon,
  InfoIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { fitCanvasToViewport, resetCanvasScale } from '@/components/Canvas'
import { CloneHaruNekoDialog } from '@/components/CloneHaruNekoDialog'
import { SettingsDialog, type TabId } from '@/components/SettingsDialog'
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
  MenubarSub,
  MenubarSubTrigger,
  MenubarSubContent,
} from '@/components/ui/menubar'
import { useScene } from '@/hooks/useScene'
import { getConfig, startPipeline } from '@/lib/api/default/default'
import { isTauri, openExternalUrl } from '@/lib/backend'
import { exportCurrentProjectAs, importPages } from '@/lib/io/pagesIo'
import { closeProject, redoOp, selectAllTextNodesOnCurrentPage, undoOp } from '@/lib/io/scene'
import { formatShortcutForDisplay, getPlatform } from '@/lib/shortcutUtils'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useSelectionStore } from '@/lib/stores/selectionStore'

const windowControls = {
  async close() {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().close()
  },
  async minimize() {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().minimize()
  },
  async toggleMaximize() {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().toggleMaximize()
  },
  async isMaximized() {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    return getCurrentWindow().isMaximized()
  },
}

type MenuItem = {
  label: string
  onSelect?: () => void | Promise<void>
  disabled?: boolean
  testId?: string
  icon?: React.ReactNode
}

type MenuSection = {
  label: string
  items: MenuItem[]
  triggerTestId?: string
}

export function MenuBar() {
  const { t } = useTranslation()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<TabId>('appearance')
  const [cloneHaruNekoOpen, setCloneHaruNekoOpen] = useState(false)
  const hasPage = useSelectionStore((s) => s.pageId !== null)
  const { scene } = useScene()
  const hasScene = scene !== null
  const shortcuts = usePreferencesStore((state) => state.shortcuts)
  const isMac = useMemo(() => getPlatform() === 'mac', [])

  const requirePageId = () => {
    const id = useSelectionStore.getState().pageId
    if (!id) throw new Error(t('errors.noCurrentPageSelected'))
    return id
  }

  const runPipeline = async (opts: { pageId?: string }) => {
    const cfg = await getConfig()
    if (!cfg.pipeline) return
    const p = cfg.pipeline
    const steps = [
      p.detector,
      p.segmenter,
      p.bubble_segmenter,
      p.font_detector,
      p.ocr,
      p.translator,
      p.inpainter,
      p.renderer,
    ].filter((s): s is string => !!s)
    const editor = useEditorUiStore.getState()
    const prefs = usePreferencesStore.getState()

    let pages: string[] | undefined = undefined
    if (opts.pageId) {
      pages = [opts.pageId]
    } else {
      const chapterId = useSelectionStore.getState().chapterId
      if (chapterId && chapterId !== 'all-chapters' && scene?.chapters) {
        const chapter = scene.chapters[chapterId]
        if (chapter && chapter.pageIds) {
          pages = chapter.pageIds
        }
      }
    }

    await startPipeline({
      steps,
      pages,
      targetLanguage: editor.selectedLanguage,
      systemPrompt: prefs.customSystemPrompt,
      defaultFont: prefs.defaultFont,
      readingOrder: editor.readingOrder === 'custom' ? undefined : editor.readingOrder,
    })
  }

  const runInpaint = async (pageId: string) => {
    const cfg = await getConfig()
    if (!cfg.pipeline?.inpainter) return
    const steps = [cfg.pipeline.bubble_segmenter, cfg.pipeline.inpainter].filter(
      (step): step is string => !!step,
    )
    await startPipeline({ steps, pages: [pageId] })
  }

  const exportItems: MenuItem[] = [
    {
      label: t('menu.export'),
      onSelect: () => void exportCurrentProjectAs('rendered', [requirePageId()]),
      disabled: !hasPage,
      testId: 'menu-file-export',
      icon: <DownloadIcon className='mr-2 h-3.5 w-3.5 text-foreground opacity-70' />,
    },
    {
      label: t('menu.exportPsd'),
      onSelect: () => void exportCurrentProjectAs('psd', [requirePageId()]),
      disabled: !hasPage,
      testId: 'menu-file-export-psd',
      icon: <DownloadIcon className='mr-2 h-3.5 w-3.5 text-blue-500 opacity-70' />,
    },
    {
      label: t('menu.exportAllPsd'),
      onSelect: () => void exportCurrentProjectAs('psd'),
      disabled: !hasScene,
      testId: 'menu-file-export-all-psd',
      icon: <DownloadIcon className='mr-2 h-3.5 w-3.5 text-blue-400 opacity-70' />,
    },
    {
      label: t('menu.exportAllInpainted'),
      onSelect: () => void exportCurrentProjectAs('inpainted'),
      disabled: !hasScene,
      testId: 'menu-file-export-all-inpainted',
      icon: <DownloadIcon className='mr-2 h-3.5 w-3.5 text-green-500 opacity-70' />,
    },
    {
      label: t('menu.exportAllRendered'),
      onSelect: () => void exportCurrentProjectAs('rendered'),
      disabled: !hasScene,
      testId: 'menu-file-export-all-rendered',
      icon: <DownloadIcon className='mr-2 h-3.5 w-3.5 text-purple-500 opacity-70' />,
    },
  ]

  const menus: MenuSection[] = [
    {
      label: t('menu.view'),
      items: [
        {
          label: t('menu.fitWindow'),
          onSelect: fitCanvasToViewport,
          icon: <Maximize2Icon className='mr-2 h-3.5 w-3.5 opacity-70' />,
        },
        {
          label: t('menu.originalSize'),
          onSelect: resetCanvasScale,
          icon: <MinimizeIcon className='mr-2 h-3.5 w-3.5 opacity-70' />,
        },
      ],
    },
    {
      label: t('menu.process'),
      triggerTestId: 'menu-process-trigger',
      items: [
        {
          label: t('menu.processCurrent'),
          onSelect: () => void runPipeline({ pageId: requirePageId() }),
          disabled: !hasPage,
          testId: 'menu-process-current',
          icon: <PlayIcon className='mr-2 h-3.5 w-3.5 text-green-500 opacity-70' />,
        },
        {
          label: t('menu.redoInpaintRender'),
          onSelect: () => void runInpaint(requirePageId()),
          disabled: !hasPage,
          testId: 'menu-process-rerender',
          icon: <RefreshCwIcon className='mr-2 h-3.5 w-3.5 text-blue-500 opacity-70' />,
        },
        {
          label: t('menu.processAll'),
          onSelect: () => void runPipeline({}),
          disabled: !hasScene,
          testId: 'menu-process-all',
          icon: <FlameIcon className='mr-2 h-3.5 w-3.5 text-red-500 opacity-70' />,
        },
      ],
    },
  ]

  const helpMenuItems: MenuItem[] = [
    {
      label: t('menu.discord'),
      onSelect: () => openExternalUrl('https://discord.gg/mHvHkxGnUY'),
      icon: <ExternalLinkIcon className='mr-2 h-3.5 w-3.5 text-indigo-400 opacity-70' />,
    },
    {
      label: t('menu.github'),
      onSelect: () => openExternalUrl('https://github.com/mayocream/koharu'),
      icon: <ExternalLinkIcon className='mr-2 h-3.5 w-3.5 text-gray-400 opacity-70' />,
    },
  ]

  const isNativeMacOS = isTauri() && isMac
  const isWindowsTauri = isTauri() && !isMac

  return (
    <div className='flex h-8 items-center border-b border-border bg-background text-[13px] text-foreground'>
      {isNativeMacOS && <MacOSControls />}
      <div className='flex h-full items-center pl-2 select-none'>
        <img
          src='/icon.png'
          alt='Koharu'
          className='h-[18px] w-[18px] shrink-0 object-contain'
          draggable={false}
        />
      </div>
      <Menubar className='h-auto gap-1 border-none bg-transparent p-0 px-1.5 shadow-none'>
        <MenubarMenu>
          <MenubarTrigger
            data-testid='menu-file-trigger'
            className='rounded px-3 py-1.5 font-medium hover:bg-accent data-[state=open]:bg-accent'
          >
            {t('menu.file')}
          </MenubarTrigger>
          <MenubarContent className='min-w-48' align='start' sideOffset={5} alignOffset={-3}>
            <MenubarItem
              data-testid='menu-file-open-files'
              className='flex items-center text-[13px]'
              disabled={!hasScene}
              onSelect={() => void importPages('replace', 'files')}
            >
              <FileTextIcon className='mr-2 h-3.5 w-3.5 opacity-70' />
              <span>{t('menu.openFiles')}</span>
            </MenubarItem>
            <MenubarItem
              data-testid='menu-file-open-folder'
              className='flex items-center text-[13px]'
              disabled={!hasScene}
              onSelect={() => void importPages('replace', 'folder')}
            >
              <FolderOpenIcon className='mr-2 h-3.5 w-3.5 text-yellow-500 opacity-70' />
              <span>{t('menu.openFolder')}</span>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem
              data-testid='menu-file-save-as'
              className='flex items-center text-[13px]'
              disabled={!hasScene}
              onSelect={() => void exportCurrentProjectAs('khr')}
            >
              <SaveIcon className='mr-2 h-3.5 w-3.5 text-blue-500 opacity-70' />
              <span>{t('menu.saveAs')}</span>
            </MenubarItem>
            <MenubarSeparator />
            {/* Export Current Page (Rendered Image) */}
            <MenubarItem
              data-testid='menu-file-export'
              className='flex items-center text-[13px]'
              disabled={!hasPage}
              onSelect={() => void exportCurrentProjectAs('rendered', [requirePageId()])}
            >
              <DownloadIcon className='mr-2 h-3.5 w-3.5 text-foreground opacity-70' />
              <span>{t('menu.export')}</span>
            </MenubarItem>

            {/* Export PSD Sub-menu */}
            <MenubarSub>
              <MenubarSubTrigger
                className='flex items-center text-[13px]'
                disabled={!hasPage && !hasScene}
              >
                <DownloadIcon className='mr-2 h-3.5 w-3.5 text-blue-500 opacity-70' />
                <span>{t('menu.exportPsdSub')}</span>
              </MenubarSubTrigger>
              <MenubarSubContent className='min-w-48 rounded-xl border border-border/80 bg-popover p-1 shadow-md'>
                <MenubarItem
                  data-testid='menu-file-export-psd'
                  className='flex items-center text-[13px]'
                  disabled={!hasPage}
                  onSelect={() => void exportCurrentProjectAs('psd', [requirePageId()])}
                >
                  <DownloadIcon className='mr-2 h-3.5 w-3.5 text-blue-500 opacity-70' />
                  <span>{t('menu.exportPsd')}</span>
                </MenubarItem>
                <MenubarItem
                  data-testid='menu-file-export-all-psd'
                  className='flex items-center text-[13px]'
                  disabled={!hasScene}
                  onSelect={() => void exportCurrentProjectAs('psd')}
                >
                  <DownloadIcon className='mr-2 h-3.5 w-3.5 text-blue-400 opacity-70' />
                  <span>{t('menu.exportAllPsd')}</span>
                </MenubarItem>
              </MenubarSubContent>
            </MenubarSub>

            {/* Export All Images Sub-menu */}
            <MenubarSub>
              <MenubarSubTrigger className='flex items-center text-[13px]' disabled={!hasScene}>
                <DownloadIcon className='mr-2 h-3.5 w-3.5 text-green-500 opacity-70' />
                <span>{t('menu.exportAllImages')}</span>
              </MenubarSubTrigger>
              <MenubarSubContent className='min-w-48 rounded-xl border border-border/80 bg-popover p-1 shadow-md'>
                <MenubarItem
                  data-testid='menu-file-export-all-inpainted'
                  className='flex items-center text-[13px]'
                  disabled={!hasScene}
                  onSelect={() => void exportCurrentProjectAs('inpainted')}
                >
                  <DownloadIcon className='mr-2 h-3.5 w-3.5 text-green-500 opacity-70' />
                  <span>{t('menu.exportAllInpainted')}</span>
                </MenubarItem>
                <MenubarItem
                  data-testid='menu-file-export-all-rendered'
                  className='flex items-center text-[13px]'
                  disabled={!hasScene}
                  onSelect={() => void exportCurrentProjectAs('rendered')}
                >
                  <DownloadIcon className='mr-2 h-3.5 w-3.5 text-purple-500 opacity-70' />
                  <span>{t('menu.exportAllRendered')}</span>
                </MenubarItem>
              </MenubarSubContent>
            </MenubarSub>
            <MenubarSeparator />
            <MenubarItem
              data-testid='menu-file-close-project'
              className='flex items-center text-[13px]'
              disabled={!hasScene}
              onSelect={() => void closeProject()}
            >
              <XCircleIcon className='mr-2 h-3.5 w-3.5 text-red-500 opacity-70' />
              <span>{t('menu.closeProject')}</span>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem
              className='flex items-center text-[13px]'
              onSelect={() => {
                setSettingsTab('appearance')
                setSettingsOpen(true)
              }}
            >
              <SettingsIcon className='mr-2 h-3.5 w-3.5 opacity-70' />
              <span>{t('menu.settings')}</span>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem
              className='flex items-center text-[13px]'
              onSelect={() => setCloneHaruNekoOpen(true)}
            >
              <CloudLightningIcon className='mr-2 h-3.5 w-3.5 text-purple-400 opacity-70' />
              <span>{t('menu.syncHaruNeko')}</span>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger
            data-testid='menu-edit-trigger'
            className='rounded px-3 py-1.5 font-medium hover:bg-accent data-[state=open]:bg-accent'
          >
            {t('menu.edit')}
          </MenubarTrigger>
          <MenubarContent className='min-w-40' align='start' sideOffset={5} alignOffset={-3}>
            <MenubarItem
              data-testid='menu-edit-undo'
              className='flex items-center justify-between text-[13px]'
              disabled={!hasScene}
              onSelect={() => void undoOp()}
            >
              <div className='flex items-center'>
                <UndoIcon className='mr-2 h-3.5 w-3.5 opacity-70' />
                <span>{t('menu.undo')}</span>
              </div>
              <MenubarShortcut>{formatShortcutForDisplay(shortcuts.undo, isMac)}</MenubarShortcut>
            </MenubarItem>
            <MenubarItem
              data-testid='menu-edit-redo'
              className='flex items-center justify-between text-[13px]'
              disabled={!hasScene}
              onSelect={() => void redoOp()}
            >
              <div className='flex items-center'>
                <RedoIcon className='mr-2 h-3.5 w-3.5 opacity-70' />
                <span>{t('menu.redo')}</span>
              </div>
              <MenubarShortcut>{formatShortcutForDisplay(shortcuts.redo, isMac)}</MenubarShortcut>
            </MenubarItem>
            <MenubarSeparator />
            <MenubarItem
              data-testid='menu-edit-select-all'
              className='flex items-center justify-between text-[13px]'
              disabled={!hasPage}
              onSelect={() => selectAllTextNodesOnCurrentPage()}
            >
              <div className='flex items-center'>
                <CheckSquareIcon className='mr-2 h-3.5 w-3.5 opacity-70' />
                <span>{t('menu.selectAll')}</span>
              </div>
              <MenubarShortcut>{isMac ? '⌘A' : 'Ctrl+A'}</MenubarShortcut>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
        {menus.map(({ label, items, triggerTestId }) => (
          <MenubarMenu key={label}>
            <MenubarTrigger
              data-testid={triggerTestId}
              className='rounded px-3 py-1.5 font-medium hover:bg-accent data-[state=open]:bg-accent'
            >
              {label}
            </MenubarTrigger>
            <MenubarContent className='min-w-36' align='start' sideOffset={5} alignOffset={-3}>
              {items.map((item) => (
                <MenubarItem
                  key={item.label}
                  data-testid={item.testId}
                  className='flex items-center text-[13px]'
                  disabled={item.disabled}
                  onSelect={item.onSelect ? () => void item.onSelect?.() : undefined}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </MenubarItem>
              ))}
            </MenubarContent>
          </MenubarMenu>
        ))}
        <MenubarMenu>
          <MenubarTrigger className='rounded px-3 py-1.5 font-medium hover:bg-accent data-[state=open]:bg-accent'>
            {t('menu.help')}
          </MenubarTrigger>
          <MenubarContent className='min-w-36' align='start' sideOffset={5} alignOffset={-3}>
            {helpMenuItems.map((item) => (
              <MenubarItem
                key={item.label}
                className='flex items-center text-[13px]'
                disabled={item.disabled}
                onSelect={item.onSelect ? () => void item.onSelect?.() : undefined}
              >
                {item.icon}
                <span>{item.label}</span>
              </MenubarItem>
            ))}
            <MenubarSeparator />
            <MenubarItem
              className='flex items-center text-[13px]'
              onSelect={() => {
                setSettingsTab('about')
                setSettingsOpen(true)
              }}
            >
              <InfoIcon className='mr-2 h-3.5 w-3.5 text-blue-400 opacity-70' />
              <span>{t('settings.about')}</span>
            </MenubarItem>
          </MenubarContent>
        </MenubarMenu>
      </Menubar>
      <div
        data-tauri-drag-region
        className='flex h-full flex-1 items-center justify-center gap-1.5 text-[11px] font-semibold text-muted-foreground/60 select-none'
      >
        {scene?.project?.name ? (
          <BookOpenIcon className='h-3.5 w-3.5 text-blue-500 opacity-60' />
        ) : (
          <img src='/icon.png' alt='' className='h-3.5 w-3.5 opacity-60' draggable={false} />
        )}
        <span>{scene?.project?.name ? `${scene.project.name} - Koharu` : 'Koharu'}</span>
      </div>
      {isWindowsTauri && <WindowControls />}
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} defaultTab={settingsTab} />
      <CloneHaruNekoDialog open={cloneHaruNekoOpen} onOpenChange={setCloneHaruNekoOpen} />
    </div>
  )
}

function MacOSControls() {
  return (
    <div className='flex h-full items-center gap-2 pr-2 pl-4'>
      <button
        onClick={() => void windowControls.close()}
        className='group flex size-3 items-center justify-center rounded-full bg-[#FF5F57] active:bg-[#bf4942]'
      >
        <XIcon
          className='size-2 text-[#4a0002] opacity-0 group-hover:opacity-100'
          strokeWidth={3}
        />
      </button>
      <button
        onClick={() => void windowControls.minimize()}
        className='group flex size-3 items-center justify-center rounded-full bg-[#FEBC2E] active:bg-[#bf8d22]'
      >
        <MinusIcon
          className='size-2 text-[#5f4a00] opacity-0 group-hover:opacity-100'
          strokeWidth={3}
        />
      </button>
      <button
        onClick={() => void windowControls.toggleMaximize()}
        className='group flex size-3 items-center justify-center rounded-full bg-[#28C840] active:bg-[#1e9630]'
      >
        <SquareIcon
          className='size-1.5 text-[#006500] opacity-0 group-hover:opacity-100'
          strokeWidth={3}
        />
      </button>
    </div>
  )
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false)

  const updateMaximized = useCallback(async () => {
    setMaximized(await windowControls.isMaximized())
  }, [])

  useEffect(() => {
    void updateMaximized()
    const onResize = () => void updateMaximized()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [updateMaximized])

  return (
    <div className='flex h-full'>
      <button
        onClick={() => void windowControls.minimize()}
        className='flex h-full w-11 items-center justify-center hover:bg-accent'
      >
        <MinusIcon className='size-4' />
      </button>
      <button
        onClick={() => {
          void windowControls.toggleMaximize().then(updateMaximized)
        }}
        className='flex h-full w-11 items-center justify-center hover:bg-accent'
      >
        {maximized ? <CopyIcon className='size-3.5' /> : <SquareIcon className='size-3.5' />}
      </button>
      <button
        onClick={() => void windowControls.close()}
        className='flex h-full w-11 items-center justify-center hover:bg-red-500 hover:text-white'
      >
        <XIcon className='size-4' />
      </button>
    </div>
  )
}
