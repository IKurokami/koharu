'use client'

import {
  BookOpenIcon,
  LanguagesIcon,
  LoaderCircleIcon,
  ScanIcon,
  ScanTextIcon,
  TypeIcon,
  Wand2Icon,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Button } from '@/components/ui/button'
import { LlmModelSelect, type LlmModelOption } from '@/components/ui/llm-model-select'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import {
  deleteCurrentLlm,
  getConfig,
  putCurrentLlm,
  startPipeline,
  useGetCatalog,
  useGetCurrentLlm,
} from '@/lib/api/default/default'
import type { LlmCatalog, LlmCatalogModel, LlmProviderCatalog, LlmTarget } from '@/lib/api/schemas'
import { useEditorUiStore } from '@/lib/stores/editorUiStore'
import { useJobsStore } from '@/lib/stores/jobsStore'
import { usePreferencesStore } from '@/lib/stores/preferencesStore'
import { useSelectionStore } from '@/lib/stores/selectionStore'
import { textNodesOf } from '@/hooks/useCurrentPage'
import { useScene } from '@/hooks/useScene'
import { applyOp, queueAutoRender } from '@/lib/io/scene'
import { ops } from '@/lib/ops'
import type { Op } from '@/lib/api/schemas'

// ---------------------------------------------------------------------------
// Helpers (inlined from former llmTargets util)
// ---------------------------------------------------------------------------

function llmTargetKey(t: LlmTarget): string {
  return `${t.kind}:${t.providerId ?? ''}:${t.modelId}`
}

function sameLlmTarget(a?: LlmTarget | null, b?: LlmTarget | null): boolean {
  if (!a || !b) return false
  return (
    a.kind === b.kind &&
    a.modelId === b.modelId &&
    (a.providerId ?? null) === (b.providerId ?? null)
  )
}

type SelectableLlmModel = { model: LlmCatalogModel; provider?: LlmProviderCatalog }

const flattenCatalogModels = (catalog?: LlmCatalog): SelectableLlmModel[] => [
  ...(catalog?.localModels ?? []).map((model) => ({ model })),
  ...(catalog?.providers ?? [])
    .filter((p) => p.status === 'ready')
    .flatMap((p) => p.models.map((model) => ({ model, provider: p }))),
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CanvasToolbar() {
  const setWebtoonPreviewOpen = useEditorUiStore((s) => s.setWebtoonPreviewOpen)
  return (
    <div className='flex items-center gap-2 border-b border-border/60 bg-card px-3 py-2 text-xs text-foreground'>
      <WorkflowButtons />
      <div className='flex-1' />
      <Button
        variant='outline'
        size='xs'
        className='gap-1.5 font-medium hover:bg-accent/80 hover:text-accent-foreground border-border/60 transition-all duration-200'
        onClick={() => setWebtoonPreviewOpen(true)}
      >
        <BookOpenIcon className='size-3.5' />
        Webtoon Preview
      </Button>
      <TranslationToolPopover />
      <LlmStatusPopover />
    </div>
  )
}

/** Currently-busy step (derived from jobsStore). */
function useCurrentStep(): string | null {
  const jobs = useJobsStore((s) => s.jobs)
  for (const j of Object.values(jobs)) {
    if (j.status === 'running' && j.progress?.step) return String(j.progress.step)
  }
  return null
}

function useIsProcessing(): boolean {
  const jobs = useJobsStore((s) => s.jobs)
  return Object.values(jobs).some((j) => j.status === 'running')
}

function WorkflowButtons() {
  const { t } = useTranslation()
  const { data: llmState } = useGetCurrentLlm()
  const llmReady = llmState?.status === 'ready'
  const pageId = useSelectionStore((s) => s.pageId)
  const hasPage = pageId !== null
  const isProcessing = useIsProcessing()
  const currentStep = useCurrentStep()

  /**
   * Run a pipeline step (or a small chain). `GET /config` is the single
   * source of truth for engine ids — every field has a serde default in
   * the Rust `PipelineConfig`, so we trust what the server returns and
   * never hard-code fallbacks here.
   *
   * Detect is the only multi-engine button; it bundles detector +
   * segmenter + font-detector so the subsequent single-engine steps
   * (OCR / Inpaint / Render) find their inputs already on the page. The
   * backend driver skips any step whose artifact is already satisfied,
   * so re-running is idempotent.
   */
  const runStep = async (
    pick: (p: NonNullable<Awaited<ReturnType<typeof getConfig>>['pipeline']>) => string[],
  ) => {
    if (!pageId) return
    const cfg = await getConfig()
    if (!cfg.pipeline) return
    const steps = pick(cfg.pipeline).filter((s): s is string => !!s)
    if (steps.length === 0) return
    const editor = useEditorUiStore.getState()
    const prefs = usePreferencesStore.getState()
    await startPipeline({
      steps,
      pages: [pageId],
      targetLanguage: editor.selectedLanguage,
      systemPrompt: prefs.customSystemPrompt,
      defaultFont: prefs.defaultFont,
      readingOrder: editor.readingOrder === 'custom' ? undefined : editor.readingOrder,
    })
  }

  type PipelinePick = (
    p: NonNullable<Awaited<ReturnType<typeof getConfig>>['pipeline']>,
  ) => string[]
  const detectChain: PipelinePick = (p) => [
    p.detector!,
    p.segmenter!,
    p.bubble_segmenter!,
    p.font_detector!,
  ]
  const ocrChain: PipelinePick = (p) => [p.ocr!]
  const translateChain: PipelinePick = (p) => [p.translator!]
  const inpaintChain: PipelinePick = (p) => [p.inpainter!]
  const renderChain: PipelinePick = (p) => [p.renderer!]

  const isDetecting = currentStep === 'detect'
  const isOcr = currentStep === 'ocr'
  const isInpainting = currentStep === 'inpaint'
  const isTranslating = currentStep === 'llmGenerate'
  const isRendering = currentStep === 'render'

  return (
    <div className='flex items-center gap-0.5'>
      <Button
        variant='ghost'
        size='xs'
        onClick={() => void runStep(detectChain)}
        data-testid='toolbar-detect'
        disabled={!hasPage || isProcessing}
      >
        {isDetecting ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : (
          <ScanIcon className='size-4' />
        )}
        {t('processing.detect')}
      </Button>
      <Separator orientation='vertical' className='mx-0.5 h-4' />
      <Button
        variant='ghost'
        size='xs'
        onClick={() => void runStep(ocrChain)}
        data-testid='toolbar-ocr'
        disabled={!hasPage || isProcessing}
      >
        {isOcr ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : (
          <ScanTextIcon className='size-4' />
        )}
        {t('processing.ocr')}
      </Button>
      <Separator orientation='vertical' className='mx-0.5 h-4' />
      <Button
        variant='ghost'
        size='xs'
        onClick={() => void runStep(translateChain)}
        disabled={!hasPage || !llmReady || isProcessing}
        data-testid='toolbar-translate'
      >
        {isTranslating ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : (
          <LanguagesIcon className='size-4' />
        )}
        {t('llm.generate')}
      </Button>
      <Separator orientation='vertical' className='mx-0.5 h-4' />
      <Button
        variant='ghost'
        size='xs'
        onClick={() => void runStep(inpaintChain)}
        data-testid='toolbar-inpaint'
        disabled={!hasPage || isProcessing}
      >
        {isInpainting ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : (
          <Wand2Icon className='size-4' />
        )}
        {t('mask.inpaint')}
      </Button>
      <Separator orientation='vertical' className='mx-0.5 h-4' />
      <Button
        variant='ghost'
        size='xs'
        onClick={() => void runStep(renderChain)}
        data-testid='toolbar-render'
        disabled={!hasPage || isProcessing}
      >
        {isRendering ? (
          <LoaderCircleIcon className='size-4 animate-spin' />
        ) : (
          <TypeIcon className='size-4' />
        )}
        {t('llm.render')}
      </Button>
    </div>
  )
}

function LlmStatusPopover() {
  const { t } = useTranslation()
  const { data: llmCatalog } = useGetCatalog()
  const { data: llmState } = useGetCurrentLlm()
  const llmReady = llmState?.status === 'ready'
  const llmLoading = llmState?.status === 'loading'
  const [popoverOpen, setPopoverOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const llmModels: LlmModelOption[] = useMemo(() => flattenCatalogModels(llmCatalog), [llmCatalog])
  const selectedTarget = useEditorUiStore((s) => s.selectedTarget)
  const customSystemPrompt = usePreferencesStore((s) => s.customSystemPrompt)
  const setCustomSystemPrompt = usePreferencesStore((s) => s.setCustomSystemPrompt)
  const llmSelectedLanguage = useEditorUiStore((s) => s.selectedLanguage)

  const selectedModel = useMemo(
    () => llmModels.find(({ model }) => sameLlmTarget(model.target, selectedTarget)),
    [llmModels, selectedTarget],
  )
  const selectedTargetKey = selectedTarget ? llmTargetKey(selectedTarget) : undefined
  const selectedModelLanguages = selectedModel?.model.languages ?? []
  const selectedIsLoaded = llmReady && sameLlmTarget(llmState?.target, selectedTarget)

  const handleSetSelectedModel = (key: string) => {
    const next = llmModels.find(({ model }) => llmTargetKey(model.target) === key)
    if (!next) return
    const nextLanguages = next.model.languages
    const nextLanguage =
      llmSelectedLanguage && nextLanguages.includes(llmSelectedLanguage)
        ? llmSelectedLanguage
        : nextLanguages[0]
    useEditorUiStore.setState({ selectedTarget: next.model.target, selectedLanguage: nextLanguage })
  }

  const handleSetSelectedLanguage = (language: string) => {
    if (!selectedModelLanguages.includes(language)) return
    useEditorUiStore.setState({ selectedLanguage: language })
  }

  const handleToggleLoadUnload = async () => {
    const target = useEditorUiStore.getState().selectedTarget
    if (!target) return
    setBusy(true)
    try {
      if (selectedIsLoaded) {
        await deleteCurrentLlm()
      } else {
        await putCurrentLlm({ target })
      }
    } catch (e) {
      useEditorUiStore.getState().showError(String(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (llmModels.length === 0) return
    const hasCurrent = llmModels.some(({ model }) => sameLlmTarget(model.target, selectedTarget))
    const nextModel = hasCurrent ? selectedModel?.model : llmModels[0]?.model
    if (!nextModel) return
    const nextLanguages = nextModel.languages
    const nextLanguage =
      llmSelectedLanguage && nextLanguages.includes(llmSelectedLanguage)
        ? llmSelectedLanguage
        : nextLanguages[0]
    const cur = useEditorUiStore.getState()
    if (
      sameLlmTarget(cur.selectedTarget, nextModel.target) &&
      cur.selectedLanguage === nextLanguage
    ) {
      return
    }
    useEditorUiStore.setState({
      selectedTarget: nextModel.target,
      selectedLanguage: nextLanguage,
    })
  }, [llmModels, llmSelectedLanguage, selectedModel?.model, selectedTarget])
  const indicatorBusy = busy || llmLoading

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          data-testid='llm-trigger'
          data-llm-ready={llmReady ? 'true' : 'false'}
          data-llm-loading={indicatorBusy ? 'true' : 'false'}
          className={`flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium shadow-sm transition hover:opacity-80 ${
            llmReady
              ? 'bg-rose-400 text-white ring-1 ring-rose-400/30'
              : indicatorBusy
                ? 'bg-amber-400 text-white ring-1 ring-amber-400/30'
                : 'bg-muted text-muted-foreground ring-1 ring-border/50'
          }`}
        >
          <motion.span
            className={`size-1.5 rounded-full ${
              llmReady ? 'bg-white' : indicatorBusy ? 'bg-white' : 'bg-muted-foreground/40'
            }`}
            animate={
              llmReady
                ? { opacity: [1, 0.5, 1] }
                : indicatorBusy
                  ? { opacity: [1, 0.4, 1] }
                  : { opacity: 1 }
            }
            transition={
              llmReady || indicatorBusy
                ? { duration: indicatorBusy ? 1 : 2, repeat: Infinity, ease: 'easeInOut' }
                : {}
            }
          />
          LLM
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[280px] p-0' data-testid='llm-popover'>
        <div className='flex flex-col gap-1.5 px-3 pt-3 pb-2.5'>
          <span className='text-[10px] font-medium text-muted-foreground uppercase'>
            {t('llm.model')}
          </span>
          <div className='flex items-center gap-1.5'>
            <LlmModelSelect
              data-testid='llm-model-select'
              value={selectedTargetKey}
              options={llmModels}
              getKey={({ model }) => llmTargetKey(model.target)}
              placeholder={t('llm.selectPlaceholder')}
              onChange={handleSetSelectedModel}
              triggerClassName='min-w-0 flex-1'
            />
            <Button
              data-testid='llm-load-toggle'
              data-llm-ready={selectedIsLoaded ? 'true' : 'false'}
              data-llm-loading={indicatorBusy ? 'true' : 'false'}
              variant={selectedIsLoaded ? 'ghost' : 'default'}
              size='sm'
              onClick={() => void handleToggleLoadUnload()}
              disabled={!selectedTarget || indicatorBusy}
              className='h-6 shrink-0 gap-1 px-2 text-[11px]'
            >
              {indicatorBusy ? <LoaderCircleIcon className='size-3 animate-spin' /> : null}
              {selectedIsLoaded ? t('llm.unload') : t('llm.load')}
            </Button>
          </div>
        </div>
        <div className='px-3'>
          <Separator />
        </div>
        <div className='flex flex-col gap-1 px-3 pt-2.5 pb-2'>
          <span className='text-[10px] font-medium text-muted-foreground uppercase'>
            {t('llm.translationSettings')}
          </span>
          <div className='flex flex-col gap-1.5'>
            {selectedModelLanguages.length > 0 ? (
              <Select
                value={llmSelectedLanguage ?? selectedModelLanguages[0]}
                onValueChange={handleSetSelectedLanguage}
              >
                <SelectTrigger data-testid='llm-language-select' className='w-full'>
                  <SelectValue placeholder={t('llm.languagePlaceholder')} />
                </SelectTrigger>
                <SelectContent position='popper'>
                  {selectedModelLanguages.map((language, index) => (
                    <SelectItem
                      key={language}
                      value={language}
                      data-testid={`llm-language-option-${index}`}
                    >
                      {t(`llm.languages.${language}`, { defaultValue: language })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
            <Textarea
              data-testid='llm-system-prompt'
              value={customSystemPrompt ?? ''}
              onChange={(e) => setCustomSystemPrompt(e.target.value || undefined)}
              placeholder={t('llm.systemPromptPlaceholder')}
              rows={3}
              className='min-h-0 resize-y px-2 py-1.5 text-xs leading-snug md:text-xs'
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TranslationToolPopover() {
  const { t } = useTranslation()
  const pageId = useSelectionStore((s) => s.pageId)
  const { scene } = useScene()
  const isProcessing = useIsProcessing()
  const { data: llmState } = useGetCurrentLlm()
  const llmReady = llmState?.status === 'ready'
  const [popoverOpen, setPopoverOpen] = useState(false)

  const handleClearPage = async () => {
    if (!pageId || !scene) return
    const page = scene.pages[pageId]
    if (!page) return
    const textNodes = textNodesOf(page)
    const clearOps = textNodes.map((node) =>
      ops.updateNode(pageId, node.id, {
        data: {
          text: {
            translation: null,
            sprite: null,
            spriteTransform: null,
            renderedDirection: null,
          }
        } as never
      })
    )
    if (clearOps.length > 0) {
      await applyOp(ops.batch("Clear page translation", clearOps))
      queueAutoRender(pageId)
    }
  }

  const handleRetranslatePage = async () => {
    if (!pageId || !scene) return
    await handleClearPage()
    const cfg = await getConfig()
    if (!cfg.pipeline) return
    const translator = cfg.pipeline.translator
    const renderer = cfg.pipeline.renderer
    if (!translator || !renderer) return
    const editor = useEditorUiStore.getState()
    const prefs = usePreferencesStore.getState()
    await startPipeline({
      steps: [translator, renderer],
      pages: [pageId],
      targetLanguage: editor.selectedLanguage,
      systemPrompt: prefs.customSystemPrompt,
      defaultFont: prefs.defaultFont,
      readingOrder: editor.readingOrder === 'custom' ? undefined : editor.readingOrder,
    })
  }

  const handleClearChapter = async () => {
    if (!pageId || !scene) return
    const currentPage = scene.pages[pageId]
    if (!currentPage) return
    const currentChapterId = currentPage.chapterId

    const chapterPages = Object.values(scene.pages).filter(
      (p) => p.chapterId === currentChapterId
    )

    const clearOps = chapterPages.flatMap((p) =>
      textNodesOf(p).map((node) =>
        ops.updateNode(p.id, node.id, {
          data: {
            text: {
              translation: null,
              sprite: null,
              spriteTransform: null,
              renderedDirection: null,
            }
          } as never
        })
      )
    )

    if (clearOps.length > 0) {
      await applyOp(ops.batch("Clear chapter translation", clearOps))
      queueAutoRender(pageId)
    }
  }

  const handleRetranslateChapter = async () => {
    if (!pageId || !scene) return
    const currentPage = scene.pages[pageId]
    if (!currentPage) return
    const currentChapterId = currentPage.chapterId

    const chapterPages = Object.values(scene.pages).filter(
      (p) => p.chapterId === currentChapterId
    )
    const chapterPageIds = chapterPages.map((p) => p.id)

    await handleClearChapter()

    const cfg = await getConfig()
    if (!cfg.pipeline) return
    const translator = cfg.pipeline.translator
    const renderer = cfg.pipeline.renderer
    if (!translator || !renderer) return
    const editor = useEditorUiStore.getState()
    const prefs = usePreferencesStore.getState()
    await startPipeline({
      steps: [translator, renderer],
      pages: chapterPageIds,
      targetLanguage: editor.selectedLanguage,
      systemPrompt: prefs.customSystemPrompt,
      defaultFont: prefs.defaultFont,
      readingOrder: editor.readingOrder === 'custom' ? undefined : editor.readingOrder,
    })
  }

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          data-testid='translation-tool-trigger'
          className='flex h-6 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium shadow-sm bg-muted text-muted-foreground ring-1 ring-border/50 transition hover:opacity-80'
        >
          <LanguagesIcon className='size-3.5' />
          {t('canvas.toolbar.translationTool')}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-[280px] p-0' data-testid='translation-tool-popover'>
        <div className='flex flex-col gap-1.5 px-3 pt-2 pb-3 bg-muted/20'>
          <span className='text-[10px] font-medium text-muted-foreground uppercase'>
            {t('canvas.toolbar.translationTool')}
          </span>
          <div className='flex flex-col gap-2'>
            <div className='flex items-center gap-1.5'>
              <span className='text-[10px] font-medium text-muted-foreground min-w-[50px] shrink-0'>{t('canvas.toolbar.pageLabel')}:</span>
              <Button
                variant='outline'
                size='xs'
                className='flex-1 h-6 text-[10px] px-1'
                disabled={!pageId || isProcessing}
                onClick={handleClearPage}
              >
                {t('common.delete')}
              </Button>
              <Button
                variant='default'
                size='xs'
                className='flex-1 h-6 text-[10px] px-1'
                disabled={!pageId || !llmReady || isProcessing}
                onClick={handleRetranslatePage}
              >
                {t('canvas.toolbar.retranslate')}
              </Button>
            </div>
            <div className='flex items-center gap-1.5'>
              <span className='text-[10px] font-medium text-muted-foreground min-w-[50px] shrink-0'>{t('canvas.toolbar.chapterLabel')}:</span>
              <Button
                variant='outline'
                size='xs'
                className='flex-1 h-6 text-[10px] px-1'
                disabled={!pageId || isProcessing}
                onClick={handleClearChapter}
              >
                {t('common.delete')}
              </Button>
              <Button
                variant='default'
                size='xs'
                className='flex-1 h-6 text-[10px] px-1'
                disabled={!pageId || !llmReady || isProcessing}
                onClick={handleRetranslateChapter}
              >
                {t('canvas.toolbar.retranslate')}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
