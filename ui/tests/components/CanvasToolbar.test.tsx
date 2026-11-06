import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CanvasToolbar } from '@/components/canvas/CanvasToolbar'
import { saveBlob } from '@/lib/io/saveBlob'
import { useJobsStore } from '@/lib/stores/jobsStore'
import { useSelectionStore } from '@/lib/stores/selectionStore'

import { renderWithQuery } from '../helpers'
import { server } from '../msw/server'

vi.mock('@/lib/io/saveBlob', () => ({
  saveBlob: vi.fn(async () => true),
  filenameFromContentDisposition: vi.fn(() => undefined),
}))

function sceneWithTranslatedTextNodes() {
  return {
    epoch: 1,
    scene: {
      pages: {
        p1: {
          id: 'p1',
          name: 'P1',
          chapterId: 'c1',
          width: 100,
          height: 100,
          nodes: {
            t1: {
              id: 't1',
              transform: { x: 0, y: 0, width: 10, height: 10, rotationDeg: 0 },
              visible: true,
              kind: { text: { text: 'first ocr', translation: 'first translation\ncontinued' } },
            },
            t2: {
              id: 't2',
              transform: { x: 10, y: 10, width: 10, height: 10, rotationDeg: 0 },
              visible: true,
              kind: { text: { text: 'second ocr', translation: 'second translation' } },
            },
            t3: {
              id: 't3',
              transform: { x: 20, y: 20, width: 10, height: 10, rotationDeg: 0 },
              visible: true,
              kind: { text: { text: 'third ocr', translation: ' ' } },
            },
          },
        },
        p2: {
          id: 'p2',
          name: 'P2',
          chapterId: 'c1',
          width: 100,
          height: 100,
          nodes: {
            t4: {
              id: 't4',
              transform: { x: 0, y: 0, width: 10, height: 10, rotationDeg: 0 },
              visible: true,
              kind: { text: { text: 'fourth ocr', translation: 'chapter second page' } },
            },
          },
        },
      },
      chapters: {
        c1: {
          id: 'c1',
          name: 'Chapter 1',
          order: 1,
          pageIds: ['p1', 'p2'],
          createdAt: '',
          updatedAt: '',
        },
      },
      project: { name: 'Proj' },
    },
  }
}

function registerToolbarApiMocks() {
  server.use(
    http.get('/api/v1/scene.json', () => HttpResponse.json(sceneWithTranslatedTextNodes())),
    http.get('/api/v1/llm/current', () =>
      HttpResponse.json({ status: 'ready', target: null, error: null }),
    ),
    http.get('/api/v1/llm/catalog', () => HttpResponse.json({ localModels: [], providers: [] })),
  )
}

describe('CanvasToolbar translation tool export', () => {
  beforeEach(() => {
    useSelectionStore.getState().setChapter('c1')
    useSelectionStore.getState().setPage('p1')
    useJobsStore.getState().clear()
    vi.mocked(saveBlob).mockClear()
  })

  it('copies current page translated text from the translation tool dropdown', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    registerToolbarApiMocks()

    renderWithQuery(<CanvasToolbar />)

    await userEvent.click(await screen.findByTestId('translation-tool-trigger'))
    const copyButton = await screen.findByTestId('translation-tool-copy-page')
    await waitFor(() => expect(copyButton).not.toBeDisabled())
    await userEvent.click(copyButton)

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith('first translation continued\nsecond translation'),
    )
  })

  it('copies chapter translated text with page headers from the translation tool dropdown', async () => {
    const writeText = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    })
    registerToolbarApiMocks()

    renderWithQuery(<CanvasToolbar />)

    await userEvent.click(await screen.findByTestId('translation-tool-trigger'))
    const copyButton = await screen.findByTestId('translation-tool-copy-chapter')
    await waitFor(() => expect(copyButton).not.toBeDisabled())
    await userEvent.click(copyButton)

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        'Page 1 - P1\n\nfirst translation continued\nsecond translation\n\nPage 2 - P2\n\nchapter second page',
      ),
    )
  })

  it('saves current page translated text as a txt file from the translation tool dropdown', async () => {
    registerToolbarApiMocks()

    renderWithQuery(<CanvasToolbar />)

    await userEvent.click(await screen.findByTestId('translation-tool-trigger'))
    const saveButton = await screen.findByTestId('translation-tool-save-page')
    await waitFor(() => expect(saveButton).not.toBeDisabled())
    await userEvent.click(saveButton)

    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1))
    const [blob, filename] = vi.mocked(saveBlob).mock.calls[0]
    await expect((blob as Blob).text()).resolves.toBe(
      'first translation continued\nsecond translation',
    )
    expect(filename).toBe('Proj-P1-translations.txt')
  })

  it('runs bubble segmentation before inpaint so the inpainter has a bubble mask', async () => {
    const pipelineRequests: unknown[] = []
    registerToolbarApiMocks()
    server.use(
      http.get('/api/v1/config', () =>
        HttpResponse.json({
          pipeline: {
            bubble_segmenter: 'speech-bubble-segmentation',
            inpainter: 'lama-manga',
          },
        }),
      ),
      http.post('/api/v1/pipelines', async ({ request }) => {
        pipelineRequests.push(await request.json())
        return HttpResponse.json({ operationId: 'op-1' })
      }),
    )

    renderWithQuery(<CanvasToolbar />)

    const inpaintButton = await screen.findByTestId('toolbar-inpaint')
    await userEvent.click(inpaintButton)

    await waitFor(() => expect(pipelineRequests).toHaveLength(1))
    expect(pipelineRequests[0]).toMatchObject({
      steps: ['speech-bubble-segmentation', 'lama-manga'],
      pages: ['p1'],
    })
  })
})
