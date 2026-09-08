// A phone that walks off the Wi-Fi leaves the long poll hanging with no TCP error,
// and a hung fetch renders the last board forever. Give it a ceiling past the
// server's own timeout so the loop falls through to "no link to lumbergh" instead.
const LINGER_MS = 15000;

import { apiUrl } from "./api.js";

export async function fetchBoard({ wait = false, timeout = 300 } = {}) {
  const qs = new URLSearchParams({ wait: String(wait), timeout: String(timeout) });
  const abort = new AbortController();
  const cutoff = setTimeout(() => abort.abort(), (wait ? timeout : 30) * 1000 + LINGER_MS);
  try {
    const res = await fetch(apiUrl(`/api/glasses/board?${qs}`), {
      cache: "no-store",
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`board ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(cutoff);
  }
}
