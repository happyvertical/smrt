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
  icon?: string;
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
