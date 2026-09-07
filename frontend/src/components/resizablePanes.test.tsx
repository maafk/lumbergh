/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import ResizablePanes from './ResizablePanes'
import VerticalResizablePanes from './VerticalResizablePanes'

// vitest.config.ts does not set `globals: true`, so @testing-library/react's
// auto-cleanup (which detects a global `afterEach`) never registers. Each
// `render` call in this file would otherwise leave its DOM behind for the
// next test.
afterEach(cleanup)

const panes = (collapse: 'left' | 'right' | null) => (
  <ResizablePanes
    collapse={collapse}
    left={<div data-testid="left-child">left</div>}
    right={<div data-testid="right-child">right</div>}
  />
)

describe('ResizablePanes collapse', () => {
  it('renders both panes when nothing is collapsed', () => {
    const { queryByTestId } = render(panes(null))
    expect(queryByTestId('left-child')).not.toBeNull()
    expect(queryByTestId('right-child')).not.toBeNull()
    const leftPane = queryByTestId('left-child')!.closest('[data-pane="left"]') as HTMLElement
    expect(leftPane.style.width).toBe('50%')
    const rightPane = queryByTestId('right-child')!.closest('[data-pane="right"]') as HTMLElement
    expect(rightPane.style.width).toBe('50%')
  })

  it('drops the right pane from the DOM when collapsing right', () => {
    const { queryByTestId } = render(panes('right'))
    expect(queryByTestId('left-child')).not.toBeNull()
    expect(queryByTestId('right-child')).toBeNull()
    const leftPane = queryByTestId('left-child')!.closest('[data-pane="left"]') as HTMLElement
    expect(leftPane.style.width).toBe('100%')
  })

  it('keeps the left pane MOUNTED but hidden when collapsing left', () => {
    // The left pane holds the terminal: a live PTY, a WebSocket and scrollback.
    // Unmounting it reconnects the session, so it must stay in the DOM.
    const { queryByTestId } = render(panes('left'))
    expect(queryByTestId('right-child')).not.toBeNull()
    const leftChild = queryByTestId('left-child')
    expect(leftChild).not.toBeNull()
    expect(leftChild!.closest('[data-pane="left"]')).toHaveProperty('style.display', 'none')
    const rightPane = queryByTestId('right-child')!.closest('[data-pane="right"]') as HTMLElement
    expect(rightPane.style.width).toBe('100%')
  })
})

describe('the splitter is easier to grab than it is to see', () => {
  /** Tailwind sizes, read off the class list: jsdom has no layout, so there are
   * no real widths to measure here. */
  const sizeOf = (el: Element, axis: 'w' | 'h'): string | undefined =>
    [...el.classList].find((c) => c.startsWith(`${axis}-`))

  it('draws a hairline but offers a wide target, horizontally', () => {
    const { getByTestId } = render(panes(null))

    expect(sizeOf(getByTestId('pane-splitter'), 'w')).toBe('w-3')
    expect(sizeOf(getByTestId('pane-splitter-line'), 'w')).toBe('w-[2px]')
  })

  it('keeps the target and the line as separate elements', () => {
    const { getByTestId } = render(panes(null))

    const target = getByTestId('pane-splitter')
    const line = getByTestId('pane-splitter-line')
    expect(target).not.toBe(line)
    expect(target.contains(line)).toBe(true)
  })

  it('still starts a drag from the wide target, not only from the line', () => {
    const { getByTestId } = render(panes(null))

    fireEvent.mouseDown(getByTestId('pane-splitter'), { clientX: 100 })
    fireEvent.mouseMove(window, { clientX: 140 })

    expect(getByTestId('pane-splitter-line').className).toContain('bg-action')
  })

  it('has no splitter to grab when a pane is collapsed', () => {
    const { queryByTestId } = render(panes('left'))
    expect(queryByTestId('pane-splitter')).toBeNull()
  })
})

describe('the vertical splitter matches it', () => {
  it('draws a hairline but offers a wide target', () => {
    const { getByTestId } = render(
      <VerticalResizablePanes
        top={<div>top</div>}
        bottom={<div>bottom</div>}
        storageKey="test:vertical"
      />
    )

    expect([...getByTestId('pane-splitter').classList]).toContain('h-3')
    expect([...getByTestId('pane-splitter-line').classList]).toContain('h-[2px]')
  })
})
