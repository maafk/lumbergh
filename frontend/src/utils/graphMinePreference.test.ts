/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MINE_ONLY_STORAGE_KEY, readMineOnly, writeMineOnly } from './graphMinePreference'

beforeEach(() => localStorage.clear())
afterEach(() => vi.restoreAllMocks())

describe('remembering the "just mine" filter', () => {
  it('is off until it is turned on', () => {
    expect(readMineOnly()).toBe(false)
  })

  it('survives a round trip', () => {
    writeMineOnly(true)
    expect(readMineOnly()).toBe(true)

    writeMineOnly(false)
    expect(readMineOnly()).toBe(false)
  })

  it('uses one key for every session, so it is set once and not per session', () => {
    writeMineOnly(true)

    const keys = Object.keys(localStorage)
    expect(keys).toEqual([MINE_ONLY_STORAGE_KEY])
    expect(MINE_ONLY_STORAGE_KEY).not.toContain(':lumbergh:')
    expect(keys[0].split(':')).toHaveLength(2)
  })

  it('reads false rather than throwing when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    expect(readMineOnly()).toBe(false)
  })

  it('keeps working when the choice cannot be saved', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })

    expect(() => writeMineOnly(true)).not.toThrow()
  })
})
