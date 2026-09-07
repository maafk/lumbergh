import { useState, useCallback, useEffect, useRef } from 'react'

interface Props {
  left: React.ReactNode
  right: React.ReactNode
  defaultLeftWidth?: number // percentage
  minLeftWidth?: number // percentage
  maxLeftWidth?: number // percentage
  storageKey?: string // localStorage key for persistence
  // Which pane, if either, gives up its width. Collapsing 'left' HIDES it rather
  // than unrendering it: that side holds the terminal, and unmounting tears down
  // xterm and its WebSocket. Collapsing 'right' unrenders, since panel state is
  // cheap to rebuild.
  collapse?: 'left' | 'right' | null
}

export default function ResizablePanes({
  left,
  right,
  defaultLeftWidth = 50,
  minLeftWidth = 20,
  maxLeftWidth = 80,
  storageKey,
  collapse = null,
}: Props) {
  const [leftWidth, setLeftWidth] = useState(() => {
    if (storageKey) {
      const saved = localStorage.getItem(storageKey)
      if (saved) {
        const parsed = parseFloat(saved)
        if (!isNaN(parsed) && parsed >= minLeftWidth && parsed <= maxLeftWidth) {
          return parsed
        }
      }
    }
    return defaultLeftWidth
  })
  const [isDragging, setIsDragging] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const updateWidth = useCallback(
    (clientX: number) => {
      if (!containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const x = clientX - rect.left
      const percentage = (x / rect.width) * 100
      const clamped = Math.min(Math.max(percentage, minLeftWidth), maxLeftWidth)
      setLeftWidth(clamped)
    },
    [minLeftWidth, maxLeftWidth]
  )

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return
      updateWidth(e.clientX)
    },
    [isDragging, updateWidth]
  )

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!isDragging) return
      updateWidth(e.touches[0].clientX)
    },
    [isDragging, updateWidth]
  )

  const handleEnd = useCallback(() => {
    setIsDragging(false)
  }, [])

  // Persist to localStorage
  useEffect(() => {
    if (storageKey) {
      localStorage.setItem(storageKey, leftWidth.toString())
    }
  }, [leftWidth, storageKey])

  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleEnd)
      document.addEventListener('touchmove', handleTouchMove)
      document.addEventListener('touchend', handleEnd)
      // Prevent text selection while dragging
      document.body.style.userSelect = 'none'
      document.body.style.cursor = 'col-resize'
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleEnd)
      document.removeEventListener('touchmove', handleTouchMove)
      document.removeEventListener('touchend', handleEnd)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
  }, [isDragging, handleMouseMove, handleTouchMove, handleEnd])

  return (
    <div ref={containerRef} className="flex h-full">
      {/* Left pane */}
      <div
        data-pane="left"
        style={
          collapse === 'left'
            ? { display: 'none' }
            : { width: collapse === 'right' ? '100%' : `${leftWidth}%` }
        }
        className="h-full overflow-hidden"
      >
        {left}
      </div>

      {!collapse && (
        <>
          {/* Splitter. The grab area is 12px — matching the graph's panel
              resizers — while the drawn line stays 2px: a 2px target is most of
              a pixel of tolerance with a mouse and hopeless with a thumb.
              Real layout width rather than an overlay pushed out with negative
              margins, which would hang over each neighbour's content and eat
              scrollbar drags to buy splitter drags. */}
          <div
            data-testid="pane-splitter"
            onMouseDown={handleMouseDown}
            onTouchStart={handleTouchStart}
            className="group w-3 flex-shrink-0 cursor-col-resize touch-none flex items-stretch justify-center"
          >
            <div
              data-testid="pane-splitter-line"
              className={`w-[2px] transition-colors group-hover:bg-action ${
                isDragging ? 'bg-action' : 'bg-border-default'
              }`}
            />
          </div>
        </>
      )}

      {collapse !== 'right' && (
        <div
          data-pane="right"
          style={{ width: collapse === 'left' ? '100%' : `${100 - leftWidth}%` }}
          className="h-full overflow-hidden"
        >
          {right}
        </div>
      )}
    </div>
  )
}
