/**
 * Shared types for the workspace shell primitives.
 *
 * See @happyvertical/smrt#1226 (epic) and #1227 / #1228 / #1229 (implementers).
 */

import type { Component } from 'svelte';

// ────────────────────────────────────────────────
// Nav primitives (used by NavTree, Breadcrumbs)
// ────────────────────────────────────────────────

export interface NavItem {
  href: string;
  label: string;
  icon?: string;
  description?: string;
  exact?: boolean;
  defaultExpanded?: boolean;
  badge?: number | string | null;
  children?: NavItem[];
}

export interface BreadcrumbItem {
  href?: string;
  label: string;
}

// ────────────────────────────────────────────────
// Tools dock primitives
// ────────────────────────────────────────────────

export interface ToolDef<TCtx = unknown> {
  id: string;
  label: string;
  /**
   * Single-character glyph or emoji rendered in the rail layout when no
   * `iconComponent` is provided. Defaults to the uppercased first character
   * of `label` when both are omitted.
   *
   * Note: ambiguous in dense docks (e.g. "Chat" and "Claim Audit" both
   * collapse to "C"). Provide `iconComponent` for production decks — see
   * the `iconComponent` field below.
   */
  icon?: string;
  /**
   * Component rendered in the rail layout (and as a leading glyph in the
   * topbar layout) for this tool. Takes precedence over `icon`. Matches
   * the pattern used by `NavTree` for per-item icons — pass a wrapper
   * component over your icon library of choice (lucide-svelte etc.).
   *
   * The component is rendered with no required props; if your icon library
   * needs sizing, wrap it in a thin component that hard-codes the dimensions
   * you want (typically ~18px to match `.tools-dock__rail-glyph`).
   *
   * @example
   * ```svelte
   * <script>
   *   import { MessageSquare } from 'lucide-svelte';
   *   const ChatIcon = () => MessageSquare; // or a wrapper component
   * </script>
   * ```
   */
  iconComponent?: Component;
  component: Component<{ context: TCtx; dock: ToolsDockApi }>;
  badge?: number | string | null;
}

export interface AvailableTool {
  id: string;
  label?: string;
  badge?: number | string | null;
}

export interface ToolsDockContext<TData = Record<string, unknown>> {
  type: string;
  title?: string;
  url?: string;
  data?: TData;
  actions?: Record<string, (...args: any[]) => unknown>;
}

/**
 * Typed payloads for dock-owned events. Event names under the `dock:` prefix
 * are reserved for the workspace primitives. Consumers should pick names in
 * their own namespace (e.g. `'my-app:foo'`) and use the stringly-typed
 * overloads of {@link ToolsDockApi.on} / {@link ToolsDockApi.emit}:
 *
 * ```ts
 * dock.on<MyPayload>('my-app:selection-changed', (e) => {
 *   // ...
 * });
 * dock.emit<MyPayload>('my-app:selection-changed', payload);
 * ```
 */
export interface ToolsDockEvents {
  /**
   * Fired by the dock after `isOpen`, `activeTool`, or `context` change —
   * i.e. `open()`, `close()`, `toggle()`, `setContext()`, and availability
   * changes that clear the active tool. Payload reflects post-mutation
   * values. Useful for mirroring dock state into a separate store
   * (workbench, analytics, etc.) without threading multiple `$effect`s
   * through every state-bearing getter.
   */
  'dock:change': {
    isOpen: boolean;
    activeTool: string | null;
    context: ToolsDockContext | null;
  };
}

export interface ToolsDockApi {
  readonly activeTool: string | null;
  readonly isOpen: boolean;
  readonly availableTools: ReadonlyArray<AvailableTool>;
  /**
   * The current dock context (route data, selection, etc.) as supplied via
   * `setContext()`. Untyped on the API surface — tools receive a typed
   * `context` prop via `ToolDef<TCtx>` instead.
   */
  readonly context: ToolsDockContext | null;
  open(id?: string): void;
  close(): void;
  toggle(id?: string): void;
  setContext(ctx: ToolsDockContext | null): void;
  /**
   * Force a re-run of the `fetchAvailability` callback with the current
   * context. Useful when a side-channel event signals that availability or
   * badges changed without the dock context itself changing (e.g. a job
   * completes, a content row's status flips, a websocket "updated" event
   * arrives). `setContext()` short-circuits on strict-equal references so
   * the only way to refetch with the same context is to call this method.
   *
   * If no `fetchAvailability` is configured, this resets `availableTools`
   * to the full registered set (same behavior as the implicit initial
   * snapshot). Concurrent / overlapping calls are token-gated — stale
   * results are dropped, only the latest fetch applies.
   */
  refreshAvailability(): void;
  /**
   * Emit an event to all subscribers. The typed overload covers built-in
   * `'dock:*'` events (see {@link ToolsDockEvents}); the stringly-typed
   * overload covers any consumer-defined event name. Consumers should pick
   * names in their own namespace (e.g. `'my-app:foo'`) — `'dock:*'` is
   * reserved for the workspace primitives.
   */
  emit<K extends keyof ToolsDockEvents>(
    event: K,
    payload: ToolsDockEvents[K],
  ): void;
  emit<TPayload>(event: string, payload: TPayload): void;
  /**
   * Subscribe to a dock event. Returns an unsubscribe function. When the
   * event name is a key of {@link ToolsDockEvents} (i.e. `'dock:*'`), the
   * payload type is inferred automatically; otherwise an explicit
   * `TPayload` may be supplied via the stringly-typed overload.
   *
   * @example
   * ```ts
   * const off = dock.on('dock:change', ({ isOpen, activeTool, context }) => {
   *   // mirror to another store
   * });
   * // ...later
   * off();
   * ```
   */
  on<K extends keyof ToolsDockEvents>(
    event: K,
    handler: (payload: ToolsDockEvents[K]) => void,
  ): () => void;
  on<TPayload>(event: string, handler: (payload: TPayload) => void): () => void;
}
