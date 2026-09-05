/** Where the "just mine" graph filter is remembered.
 *
 * Deliberately one key for every session, not `…:<sessionName>`. The filter says
 * something about you — which commits are yours — not about the repo you happen
 * to be looking at, so scoping it per session meant switching it on again in
 * every session, forever.
 *
 * localStorage can throw outright (a private window, or a browser set to block
 * site data), so both sides swallow failure: a filter that cannot be remembered
 * must still be usable. */
export const MINE_ONLY_STORAGE_KEY = 'lumbergh:gitGraphMineOnly'

export function readMineOnly(): boolean {
  try {
    return localStorage.getItem(MINE_ONLY_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function writeMineOnly(value: boolean): void {
  try {
    localStorage.setItem(MINE_ONLY_STORAGE_KEY, String(value))
  } catch {
    // Not remembering the choice is survivable; failing the toggle is not.
  }
}
