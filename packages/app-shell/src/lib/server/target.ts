// Which copy of the app a call is about: `live` or `draft`.
//
// Since changes waiting (#5178) NO request names a copy: records are always
// live and structural commands become changes waiting (changes.ts). The draft
// copy is private to changes.ts and the engine's checks and preview; a request
// can no longer ask for it (`?target=`, `x-shell-target` and `/mcp?target=` are
// gone). `Target`/`CallScope` remain as the internal plumbing, always `live`.
//
// `source` says who is calling, for the card a structural command becomes:
// the assistant's own tools, or any other API caller.
//
// The one piece of async-scoped state is the scope handed to the App model's
// builder methods (they are static methods with fixed signatures that smrt
// generates REST and MCP from). It is entered only by `withScope`, at the
// request entries, and reads as `live` when nothing entered it.
import { AsyncLocalStorage } from 'node:async_hooks';
import { EngineError } from '../../engine/index.ts';

export const TARGETS = ['live', 'draft'] as const;
export type Target = (typeof TARGETS)[number];

export function isTarget(value: unknown): value is Target {
  return value === 'live' || value === 'draft';
}

export interface CallScope {
  /** Copy for record operations: app tools, app REST, record routes. */
  records: Target;
  /** Copy for builder operations: define/add/remove/undo/describe/history. */
  structure: Target;
  /** Who is calling (the card's source); unset reads as `api`. */
  source?: 'assistant' | 'api';
  /**
   * Set only for a comment turn (#5206): the ONE waiting change the turn is
   * about. It adds the `change_revise` tool for that card and withholds the
   * structural builder tools and record writes.
   */
  reviseCardId?: string;
}

export const LIVE_SCOPE: Readonly<CallScope> = Object.freeze({
  records: 'live',
  structure: 'live',
});

/** Both halves on one copy. */
export function scopeFor(target: Target): CallScope {
  return { records: target, structure: target };
}

/** MCP URL scope: live/draft, assistant split, or tool-free import planning. */
export type McpScopeKey = 'live' | 'assistant' | 'import-plan';

export function mcpScopeKey(params: URLSearchParams): McpScopeKey {
  const scope = params.get('scope');
  if (params.get('target') !== null)
    throw new EngineError(
      'target is no longer supported: structural changes wait for the owner',
      'invalid',
    );
  if (scope !== null) {
    if (scope !== 'assistant' && scope !== 'import-plan')
      throw new EngineError(
        "scope must be 'assistant' or 'import-plan'",
        'invalid',
      );
    return scope;
  }
  return 'live';
}

const scopeStore = new AsyncLocalStorage<CallScope>();

/** Run `fn` with `scope` for the App model's builder methods. */
export function withScope<T>(
  scope: CallScope,
  fn: () => Promise<T>,
): Promise<T> {
  return scopeStore.run({ ...scope }, fn);
}

/** The scope entered by the request entry, or all-live. */
export function currentScope(): CallScope {
  return scopeStore.getStore() ?? LIVE_SCOPE;
}
