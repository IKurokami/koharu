import { describe, expect, it } from 'vitest'

import {
  formatChapterTranslatedText,
  formatPageTranslatedText,
  hasTranslatedText,
  resolveTranslatedTextPages,
  translatedTextDefaultFilename,
} from '@/lib/io/translatedText'

function page(id: string, name: string, translations: Array<string | null>, chapterId?: string) {
  return {
    id,
    name,
    chapterId,
    width: 100,
    height: 100,
    nodes: Object.fromEntries(
      translations.map((translation, index) => [
        `t${index + 1}`,
        {
          id: `t${index + 1}`,
          transform: { x: 0, y: 0, width: 10, height: 10, rotationDeg: 0 },
          visible: true,
          kind: { text: { text: `ocr ${index + 1}`, translation } },
        },
      ]),
    ),
  } as any
}

describe('translated text export', () => {
  it('formats one page as one translated block per line', () => {
    const p = page('p1', '001.png', ['First line\ncontinued', '  ', null, 'Second'])

    expect(formatPageTranslatedText(p)).toBe('First line continued\nSecond')
  })

  it('formats chapter export with page number, file name, and text after a blank line', () => {
    const pages = [page('p1', '001.png', ['Hello', 'World']), page('p2', '002.png', ['Next'])]

    expect(formatChapterTranslatedText(pages)).toBe(
      'Page 1 - 001.png\n\nHello\nWorld\n\nPage 2 - 002.png\n\nNext',
    )
  })

  it('resolves selected chapter pages in chapter order', () => {
    const p1 = page('p1', '001.png', ['A'], 'c1')
    const p2 = page('p2', '002.png', ['B'], 'c1')
    const p3 = page('p3', '003.png', ['C'], 'c2')
    const scene = {
      project: { name: 'Project' },
      pages: { p1, p2, p3 },
      chapters: {
        c1: {
          id: 'c1',
          name: 'Chapter 1',
          order: 1,
          pageIds: ['p2', 'p1'],
          createdAt: '',
          updatedAt: '',
        },
      },
    } as any

    expect(resolveTranslatedTextPages(scene, p1, 'c1', 'chapter').map((p) => p.id)).toEqual([
      'p2',
      'p1',
    ])
    expect(hasTranslatedText(resolveTranslatedTextPages(scene, p1, 'c1', 'chapter'))).toBe(true)
    expect(translatedTextDefaultFilename(scene, p1, 'c1', 'chapter')).toBe(
      'Project-Chapter 1-translations.txt',
    )
  })
})
