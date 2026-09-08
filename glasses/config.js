// Where Lumbergh lives, for builds that are not served by it.
//
// Empty means same-origin, which is right for the browser and for the QR sideload path:
// both load this page *from* Lumbergh, so a relative /api request resolves. A packed
// .ehpk does not — the Even app serves the bundle from a local origin, where a relative
// request has no server behind it. `pack.sh` writes the real URL in here at pack time so
// the repo stays host-agnostic.
export const LUMBERGH_URL = "";
