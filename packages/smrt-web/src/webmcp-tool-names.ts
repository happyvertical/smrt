/**
 * Document-global WebMCP tool-name lock (#2613).
 *
 * A browser tool name is derived independently on three paths that all end at
 * the same `document.modelContext`:
 *
 * 1. **generated** model tools — `<namespace>_<model>_<action>`, built by
 *    `registerWebMcpTools` from the exposure policy;
 * 2. **ui** — the six fixed `smrt_ui_*` tools a UI layer registers under a
 *    configurable prefix (`registerWebMcpUiTools` in `@happyvertical/smrt-svelte`);
 * 3. **intent** / **bespoke** — declared view intents (#2588) and hand-written
 *    `useWebMcpTool` tools, whose names come from the declaration `id` or the
 *    spec `name`.
 *
 * None of the three can see the others at declaration time: a namespace and a
 * UI prefix are runtime values a declaration never sees. `registerWebMcpTools`
 * rejects duplicates WITHIN its own prospective set, but nothing checked
 * ACROSS the paths, so a collision reached the host — which rejects the later
 * registration and leaves the tool silently absent.
 *
 * This module is the shared reservation table those paths coordinate through.
 * It is an AVAILABILITY guard, not a trust boundary: every path stays
 * fail-closed and browser-only regardless, and a collision loses a tool rather
 * than granting one. The authenticated REST surface remains the auth, tenant,
 * and field-write boundary.
 *
 * ## Why the table lives on the document, not in this module
 *
 * The lock must be shared by every registrar reachable from one page, which
 * spans package boundaries (`smrt-web` and a UI layer) and therefore possibly
 * more than one copy of this module — a second bundle chunk, a duplicated
 * dependency, or an HMR reload that replaces module state while the host
 * registry keeps every tool it already accepted. Module-level state loses the
 * reservations in all of those cases, and a lost reservation is worse than no
 * lock: it lets a duplicate through, or (on the release side) strands a name
 * forever. The table is therefore stored on the `document` object itself under
 * a cross-realm `Symbol.for` key, which every copy of this module resolves to
 * the same slot.
 *
 * The table is additionally stamped with the `modelContext` it was built for.
 * When a host installs a NEW model context on the same document — a fresh
 * origin-trial registry, or a test harness swapping the double — every tool
 * the old registry held is gone, so the table resets rather than stranding
 * those names.
 *
 * This module is dependency-free by design (see the package's dependency-DAG
 * guardrails) and ships as the `@happyvertical/smrt-web/webmcp-tool-names`
 * entry so a UI layer can reserve its fixed tool names without pulling in the
 * client-data engine.
 */

/** Which registration path holds a reserved WebMCP tool name. */
export type WebMcpToolNameOwner = 'generated' | 'ui' | 'intent' | 'bespoke';

/**
 * Thrown synchronously when a name is already held. Carries the colliding
 * name and the owner that holds it so a host can report both without parsing
 * the message.
 */
export class WebMcpToolNameCollisionError extends Error {
  constructor(
    readonly toolName: string,
    /** The path that already holds {@link toolName}. */
    readonly owner: WebMcpToolNameOwner,
    /** The path that tried to take it. */
    readonly requestedBy: WebMcpToolNameOwner,
  ) {
    super(
      `WebMCP tool name "${toolName}" is already registered by the ${owner} path; the ${requestedBy} path cannot register it. Rename the ${requestedBy} tool, or give the generated tools a webmcp namespace / the UI tools a different prefix.`,
    );
    this.name = 'WebMcpToolNameCollisionError';
  }
}

/** Releases every name one reservation holds. Idempotent. */
export interface WebMcpToolNameReservation {
  release(): void;
}

export interface ReserveWebMcpToolNamesOptions {
  /**
   * The document whose `modelContext` the names are registered against.
   * Defaults to `globalThis.document`. Registrars that accept an injectable
   * document (tests, non-window hosts) must pass the SAME object they read
   * `modelContext` from, or their reservations land in a different table.
   */
  document?: unknown;
}

/** A held name plus the token identifying the reservation that holds it. */
interface HeldName {
  owner: WebMcpToolNameOwner;
  token: object;
}

interface ToolNameTable {
  /** The model context these reservations were taken against. */
  modelContext: unknown;
  names: Map<string, HeldName>;
}

const TABLE_KEY = Symbol.for('@happyvertical/smrt-web:webmcp-tool-names');

const INERT_RESERVATION: WebMcpToolNameReservation = { release: () => {} };

function resolveDocument(documentLike: unknown): object | undefined {
  const doc =
    documentLike ??
    (globalThis as { document?: unknown }).document ??
    undefined;
  return doc && typeof doc === 'object' ? (doc as object) : undefined;
}

function tableFor(doc: object): ToolNameTable {
  const slot = doc as Record<symbol, ToolNameTable | undefined>;
  const modelContext = (doc as { modelContext?: unknown }).modelContext;
  const existing = slot[TABLE_KEY];
  // A replaced model context means the host registry that held the old
  // reservations no longer exists; start clean rather than stranding names.
  if (existing && existing.modelContext === modelContext) return existing;
  const table: ToolNameTable = { modelContext, names: new Map() };
  Object.defineProperty(doc, TABLE_KEY, {
    value: table,
    configurable: true,
    enumerable: false,
    writable: true,
  });
  return table;
}

/**
 * Reserve `names` for `owner` against the document's WebMCP registry.
 *
 * Reservation is ALL-OR-NOTHING: if any name is already held — by this path
 * or another — nothing is reserved and a {@link WebMcpToolNameCollisionError}
 * naming the colliding name and its current owner is thrown synchronously,
 * before any tool reaches `document.modelContext`. Duplicates within `names`
 * itself collide the same way.
 *
 * Off-WebMCP (no document) the call is a no-op returning an inert
 * reservation, matching every registrar's own no-op guarantee.
 *
 * A reservation releases only the names it took: `release()` never drops a
 * name a later reservation has since acquired, so a dispose that lands after
 * a same-name re-registration cannot revoke the new holder's claim.
 */
export function reserveWebMcpToolNames(
  names: readonly string[],
  owner: WebMcpToolNameOwner,
  options: ReserveWebMcpToolNamesOptions = {},
): WebMcpToolNameReservation {
  const doc = resolveDocument(options.document);
  if (!doc) return INERT_RESERVATION;

  const table = tableFor(doc);
  const token = {};
  const taken: string[] = [];
  const drop = (): void => {
    for (const name of taken) {
      // Only ever drop a name this reservation still holds. Together with the
      // `released` latch below, a stale handle can neither release twice nor
      // revoke a claim a later reservation has since taken under the same name.
      if (table.names.get(name)?.token === token) table.names.delete(name);
    }
  };

  for (const name of names) {
    const held = table.names.get(name);
    if (held) {
      // All-or-nothing: give back everything taken so far, so a rejected
      // reservation leaves no name stranded and the caller can retry with a
      // corrected set.
      drop();
      throw new WebMcpToolNameCollisionError(name, held.owner, owner);
    }
    table.names.set(name, { owner, token });
    taken.push(name);
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      drop();
    },
  };
}

/**
 * The owner currently holding `name` on this document, or undefined. For
 * diagnostics and tests; registration paths use
 * {@link reserveWebMcpToolNames}, which is atomic.
 */
export function webMcpToolNameOwner(
  name: string,
  options: ReserveWebMcpToolNamesOptions = {},
): WebMcpToolNameOwner | undefined {
  const doc = resolveDocument(options.document);
  if (!doc) return undefined;
  return tableFor(doc).names.get(name)?.owner;
}
