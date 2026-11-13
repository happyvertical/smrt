// Which copy of the app a request is about: `live` or `draft`.
//
// There is NO ambient "current host". Every entry (a REST route, an MCP
// request, an assistant tool call) reads the copy from the request itself,
// builds a {@link CallScope} and passes it down. The default is `live`, the
// strict side: the approval gate is on, and while a draft is open its
// structure is frozen. Only `hostFor('draft')` can reach the draft host, and
// only a request that said `draft` gets there.
//
// A scope has two halves because the person may look at the live records while
// the assistant builds in the draft: `records` is the copy for record
// operations (app tools, app REST, reports, record routes), `structure` the
// copy for builder operations (define, add, remove, undo, describe, history).
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
}

export const LIVE_SCOPE: Readonly<CallScope> = Object.freeze({
  records: 'live',
  structure: 'live',
});

/** Both halves on one copy. */
export function scopeFor(target: Target): CallScope {
  return { records: target, structure: target };
}

/**
 * A request's target value: absent means `live`; anything but `live` or
 * `draft` is a 400, never a silent fallback to some other copy.
 */
export function parseTarget(value: unknown): Target {
  if (value === undefined || value === null || value === '') return 'live';
  if (isTarget(value)) return value;
  throw new EngineError("target must be 'live' or 'draft'", 'invalid');
}

/** Which scope one /mcp URL asks for: `?target=live|draft`, `?scope=assistant`, or none (live). */
export type McpScopeKey = Target | 'assistant';

export function mcpScopeKey(params: URLSearchParams): McpScopeKey {
  const scope = params.get('scope');
  const target = params.get('target');
  if (scope !== null && target !== null)
    throw new EngineError('send either scope or target, not both', 'invalid');
  if (scope !== null) {
    if (scope !== 'assistant')
      throw new EngineError("scope must be 'assistant'", 'invalid');
    return 'assistant';
  }
  return parseTarget(target);
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
