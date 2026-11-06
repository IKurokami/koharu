import type { Page, Scene } from '@/lib/api/schemas'

export type TranslatedTextExportScope = 'page' | 'chapter'

const ALL_CHAPTERS_ID = 'all-chapters'

function translatedLine(value: string | null | undefined): string | null {
  const line = (value ?? '')
    .split(/\r\n|\r|\n/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .trim()
  return line.length > 0 ? line : null
}

export function pageTranslatedTextLines(page: Page): string[] {
  const lines: string[] = []
  for (const node of Object.values(page.nodes)) {
    if (!('text' in node.kind)) continue
    const line = translatedLine(node.kind.text.translation)
    if (line) lines.push(line)
  }
  return lines
}

export function formatPageTranslatedText(page: Page): string {
  return pageTranslatedTextLines(page).join('\n')
}

export function formatChapterTranslatedText(pages: Page[]): string {
  return pages
    .map((page, index) => {
      const header = `Page ${index + 1} - ${page.name || page.id}`
      const body = formatPageTranslatedText(page)
      return body ? `${header}\n\n${body}` : header
    })
    .join('\n\n')
}

export function hasTranslatedText(pages: Page[]): boolean {
  return pages.some((page) => pageTranslatedTextLines(page).length > 0)
}

export function resolveTranslatedTextPages(
  scene: Scene,
  currentPage: Page,
  selectedChapterId: string | null | undefined,
  scope: TranslatedTextExportScope,
): Page[] {
  if (scope === 'page') return [currentPage]

  const chapterId =
    selectedChapterId && selectedChapterId !== ALL_CHAPTERS_ID
      ? selectedChapterId
      : (currentPage.chapterId ?? null)

  if (chapterId) {
    const chapter = scene.chapters?.[chapterId]
    const pageIds =
      chapter?.pageIds && chapter.pageIds.length > 0
        ? chapter.pageIds
        : Object.values(scene.pages)
            .filter((page) => page.chapterId === chapterId)
            .map((page) => page.id)

    const chapterPages = pageIds
      .map((pageId) => scene.pages[pageId])
      .filter((page): page is Page => Boolean(page))
    if (chapterPages.length > 0) return chapterPages
  }

  return Object.values(scene.pages)
}

export function formatTranslatedTextExport(
  pages: Page[],
  scope: TranslatedTextExportScope,
): string {
  return scope === 'page'
    ? pages[0]
      ? formatPageTranslatedText(pages[0])
      : ''
    : formatChapterTranslatedText(pages)
}

function sanitiseBaseName(name: string | undefined | null): string {
  const cleaned = (name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
  return cleaned.length > 0 ? cleaned : 'koharu-translations'
}

export function translatedTextDefaultFilename(
  scene: Scene,
  currentPage: Page,
  selectedChapterId: string | null | undefined,
  scope: TranslatedTextExportScope,
): string {
  const project = sanitiseBaseName(scene.project?.name)
  if (scope === 'page') {
    return `${project}-${sanitiseBaseName(currentPage.name || currentPage.id)}-translations.txt`
  }

  const chapterId =
    selectedChapterId && selectedChapterId !== ALL_CHAPTERS_ID
      ? selectedChapterId
      : (currentPage.chapterId ?? null)
  const chapterName = chapterId ? scene.chapters?.[chapterId]?.name : null
  return `${project}-${sanitiseBaseName(chapterName ?? 'chapter')}-translations.txt`
}
