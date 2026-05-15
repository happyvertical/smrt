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
 * Built-in event names emitted on the {@link ToolsDockApi} pub/sub bus along
 * with their payload shapes. Consumers can extend this map by declaration
 * merging in their own `.d.ts` if they emit additional custom events via
 * {@link ToolsDockApi.emit}.
 *
 * The `'change'` event fires after any state transition that affects
 * `isOpen`, `activeTool`, or `context` — i.e. `open()`, `close()`,
 * `toggle()`, `setContext()`, and availability changes that clear the
 * active tool. Handlers see the post-update state. Useful for mirroring
 * dock state into a separate store (workbench, analytics, etc.) without
 * threading multiple `$effect`s through every state-bearing getter.
 */
export interface ToolsDockEvents {
  change: {
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
   * Emit a custom event to all subscribers. Built-in events (see
   * {@link ToolsDockEvents}) are emitted by the dock itself; consumers
   * may emit additional events to coordinate between tools.
   */
  emit<K extends keyof ToolsDockEvents>(
    event: K,
    payload: ToolsDockEvents[K],
  ): void;
  emit<TPayload>(event: string, payload: TPayload): void;
  /**
   * Subscribe to a dock event. Returns an unsubscribe function. When the
   * event name is a key of {@link ToolsDockEvents} the payload type is
   * inferred automatically; otherwise an explicit `TPayload` may be supplied.
   *
   * @example
   * ```ts
   * const off = dock.on('change', ({ isOpen, activeTool, context }) => {
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
