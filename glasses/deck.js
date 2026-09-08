// Order comes from the server (attention first). The deck holds it still while the
// wearer is browsing: a card that reorders under a thumb mid-swipe means dictating
// into the wrong session, so a refresh only reorders when the wearer is at rest.
export function createDeck() {
  let cards = [];
  let index = 0;
  let browsing = false;
  let pending = 0;

  function keyOf(c) {
    return c.target;
  }

  return {
    update(next) {
      const currentKey = cards[index] ? keyOf(cards[index]) : null;
      if (browsing) {
        // Refresh the text of cards already on screen, but keep position and order.
        const byKey = new Map(next.map((c) => [keyOf(c), c]));
        cards = cards.map((c) => byKey.get(keyOf(c)) || c).filter((c) => byKey.has(keyOf(c)));
        pending = next.filter((c) => c.needs && !cards.some((k) => keyOf(k) === keyOf(c))).length;
        // Re-find the card the wearer was actually looking at — a numeric clamp alone
        // would silently slide the cursor onto a neighbor when an earlier card drops
        // out mid-browse. Only fall back to the clamp when that card itself is gone.
        const stillThere = cards.findIndex((c) => keyOf(c) === currentKey);
        index = stillThere >= 0 ? stillThere : Math.min(index, Math.max(cards.length - 1, 0));
        return;
      }
      cards = next;
      pending = 0;
      const found = cards.findIndex((c) => keyOf(c) === currentKey);
      const needy = cards.findIndex((c) => c.needs);
      index = needy >= 0 ? needy : Math.max(found, 0);
    },
    next() {
      browsing = true;
      if (cards.length) index = (index + 1) % cards.length;
    },
    prev() {
      browsing = true;
      if (cards.length) index = (index - 1 + cards.length) % cards.length;
    },
    rest() {
      browsing = false;
    },
    /** The whole board, in attention order — the default view is a list, not one card. */
    all() {
      return cards;
    },
    index() {
      return index;
    },
    current() {
      return cards[index] || null;
    },
    isQuiet() {
      return !browsing && !cards.some((c) => c.needs);
    },
    pendingAttention() {
      return pending;
    },
    size() {
      return cards.length;
    },
    workingCount() {
      return cards.filter((c) => c.state === "working").length;
    },
  };
}
