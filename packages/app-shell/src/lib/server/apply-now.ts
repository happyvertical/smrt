// "Apply now" (#5206): the one pure rule that decides whether a chat reply may
// offer the single-click Apply, and whether the server accepts a `source: chat`
// apply. The server recomputes it on every such apply from the batch it holds
// and ignores whatever the client claims. It decides nothing else: the apply
// itself is still the owner's own click on the digest-pinned route.

/** Commands that only ADD something new to the app (never change what exists). */
const ADDITIVE: ReadonlySet<string> = new Set([
  'defineModel',
  'addField',
  'defineReport',
]);

export interface ApplyNowInput {
  cards: ReadonlyArray<{
    status: string;
    source: string;
    opaque: boolean;
    commands: ReadonlyArray<{ type?: unknown }>;
  }>;
  /** What the last exact check says Apply would replace; null until it has run. */
  overwrites: {
    recordsUpdated: number;
    recordsMerged: number;
    archivedValues: number;
    archivedTables: number;
  } | null;
}

/**
 * Default rule (mock Q1): exactly one active card, additive only, made by the
 * assistant (asked for in chat), and the exact check found no record updated,
 * merged or set aside.
 */
export function applyNowEligible(batch: ApplyNowInput): boolean {
  const active = batch.cards.filter((c) => c.status === 'active');
  if (active.length !== 1) return false;
  const [card] = active;
  if (card.opaque || card.source !== 'assistant') return false;
  if (!card.commands.length) return false;
  if (
    !card.commands.every(
      (c) => typeof c.type === 'string' && ADDITIVE.has(c.type),
    )
  )
    return false;
  const o = batch.overwrites;
  return (
    !!o &&
    o.recordsUpdated === 0 &&
    o.recordsMerged === 0 &&
    o.archivedValues === 0 &&
    o.archivedTables === 0
  );
}
