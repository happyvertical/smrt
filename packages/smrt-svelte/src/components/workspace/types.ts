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

/**
 * Configuration for a single role in a multi-role admin shell. The role
 * determines which navigation sections are shown, the display label, and
 * an optional color identifier consumers can use to theme the shell.
 *
 * Role IDs are arbitrary strings — the framework doesn't know about specific
 * roles. Consumers pick whatever set fits their app (e.g. 'super', 'admin',
 * 'tenant-owner', 'editor').
 *
 * See `RoleShell` for the renderer that consumes this config and
 * `happyvertical/smrt#1226` (Phase 4b) for design context.
 */
export interface RoleConfig {
  /** Stable role identifier. */
  id: string;
  /** Display label (e.g. "Super Admin"). */
  label: string;
  /** Optional subtitle / description. */
  description?: string;
  /** Optional icon string/glyph for the role's header area. */
  icon?: string;
  /**
   * Optional color identifier. Rendered as a CSS custom property
   * `--smrt-role-color: <value>` on the shell root so consumer CSS can
   * theme child components. Pick a semantic name your design system
   * understands (e.g. 'blue', 'success', 'primary').
   */
  color?: string;
  /** Navigation sections shown for this role. Same shape as NavItem[]. */
  sections: NavItem[];
}

// ────────────────────────────────────────────────
// Tools dock primitives
// ────────────────────────────────────────────────

export interface ToolDef {
  id: string;
  label: string;
  /**
   * Single-character glyph or emoji rendered in the rail layout when no
   * `iconComponent` is provided. Defaults to the uppercased first character
   * of `label` when both are omitted.
   *
   * Note: ambiguous in dense docks (e.g. "Chat" and "Claim Audit" both
   * collapse to "C"). Provide `iconComponent` for production docks — see
   * the `iconComponent` field below.
   */
  icon?: string;
  /**
   * Component rendered in the rail layout (and as a leading glyph in the
   * topbar layout) for this tool. Takes precedence over `icon`. Matches
   * the pattern used by `NavTree` for per-item icons — pass the icon
   * component from your library of choice (lucide-svelte etc.) directly,
   * or a thin `.svelte` wrapper around it.
   *
   * The component is rendered with no props (`<IconComponent />`); if your
   * icon library needs sizing, wrap it in a thin `.svelte` component that
   * hard-codes the dimensions you want (typically ~18px to match
   * `.tools-dock__rail-glyph`).
   *
   * @example
   * ```ts
   * import MessageSquare from 'lucide-svelte/icons/message-square';
   * import ChatPanel from './ChatPanel.svelte';
   *
   * const tool: ToolDef = {
   *   id: 'chat',
   *   label: 'Chat',
   *   iconComponent: MessageSquare,
   *   component: ChatPanel,
   * };
   * ```
   */
  iconComponent?: Component;
  /**
   * Panel component rendered when this tool is active. Receives the dock's
   * current `context` and the dock API.
   *
   * Tools that want typed access to `context.data` / `context.actions`
   * should locally type their own props inside the component, e.g.
   *
   * ```svelte
   * <script lang="ts">
   *   import type { ToolsDockApi, ToolsDockContext } from
   *     '@happyvertical/smrt-svelte/workspace';
   *
   *   interface MyData { siteSlug: string; contentId: string }
   *   interface MyActions { triggerSave(): void }
   *
   *   let { context, dock }: {
   *     context: ToolsDockContext<MyData, MyActions> | null;
   *     dock: ToolsDockApi;
   *   } = $props();
   * </script>
   * ```
   *
   * The dock erases tool-specific types at registration (tools are stored
   * as a homogeneous `ToolDef[]`), so the props type is intentionally
   * `Component<any>`. Svelte component props are checked contravariantly,
   * which means a hard-coded `Component<{ context: ToolsDockContext | null; ... }>`
   * slot would reject any component declaring a narrower
   * `context: ToolsDockContext<MyData, MyActions> | null` prop — defeating
   * the point of letting consumers type the prop locally. Erasing here
   * means the per-component prop annotation shown above compiles without
   * a registration-site cast.
   *
   * A previous version of this API carried a `<TCtx>` generic on `ToolDef`
   * that flowed into the `context` prop. In practice it was always erased
   * at registration, so consumers cast at the registration site and
   * re-declared the prop shape inside the component anyway. The current
   * shape preserves the typed-context ergonomics while removing both the
   * useless generic and the registration-site cast.
   */
  // Registration is intentionally type-erased; see JSDoc above. The `any`
  // here is load-bearing — see Copilot/codex/claude review threads on PR
  // #1239 for the contravariance rationale.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  component: Component<any>;
  badge?: number | string | null;
  /**
   * Optional gate IDs that must all evaluate to true for the tool to be
   * visible. Convention: `<subsystem>:<identifier>`, e.g.:
   *
   *   - `'permission:articles.publish'`
   *   - `'feature:video-tools'`
   *   - `'user-pref:show-jobs'`
   *
   * Gates are evaluated server-side via `composeDockAvailability` from
   * `@happyvertical/smrt-svelte/workspace/server`. Each gate's prefix
   * (text before the `:`) selects which evaluator handles it; tools with
   * unknown prefixes throw at composition time (loud-fail beats
   * silent-leak).
   *
   * Reserved prefixes (used by built-in evaluators):
   *   - `permission:` — RBAC, via smrt-users
   *   - `feature:` — feature flags, via smrt-features (if available)
   *
   * Consumer-defined prefixes (e.g., `myapp:`) are fine; consumer must
   * register the evaluator.
   */
  gates?: string[];
}

export interface AvailableTool {
  id: string;
  label?: string;
  badge?: number | string | null;
}

/**
 * Context blob the dock surfaces to tools and `fetchAvailability`. Both
 * generics default so existing call sites keep compiling:
 *
 * - `TData` types the shape of `data` (route data, selection, etc.).
 *   Defaults to `Record<string, unknown>`.
 * - `TActions` types the shape of `actions` — the host-supplied callback
 *   map tools may invoke to reach back into the page (`triggerSave`,
 *   `openDialog`, etc.). Defaults to a permissive
 *   `Record<string, (...args: any[]) => unknown>` so the untyped pattern
 *   `dock.setContext({ actions: { triggerSave() {} } })` keeps compiling
 *   without a generic argument.
 *
 * The constraint is a self-mapped
 * `{ [K in keyof TActions]: (...args: any[]) => any }` rather than
 * `Record<string, ...>`. This accepts interface-style action maps without
 * an explicit string index signature — the common pattern Copilot flagged
 * in the original PR review. A bare `Record<string, ...>` constraint
 * rejects interfaces (which have no index signature) under strict TS,
 * forcing consumers to use type aliases or add `[key: string]: ...`.
 *
 * Recommended consumer pattern: thread these generics into the tool
 * component's own `context` prop so `context?.actions?.foo()` is fully
 * typed without a cast.
 *
 * ```ts
 * interface MyData { siteSlug: string; contentId: string }
 * interface MyActions { triggerSave(): void; openReview(kind: string): void }
 *
 * // factory site:
 * const dock = defineToolsDock<MyData, MyActions>({ ... });
 *
 * // tool component:
 * let { context }: {
 *   context: ToolsDockContext<MyData, MyActions> | null;
 * } = $props();
 * context?.actions?.triggerSave(); // typed
 * ```
 */
export interface ToolsDockContext<
  TData = Record<string, unknown>,
  TActions extends { [K in keyof TActions]: (...args: any[]) => any } = Record<
    string,
    (...args: any[]) => unknown
  >,
> {
  type: string;
  title?: string;
  url?: string;
  data?: TData;
  actions?: TActions;
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
   * Fired when `isOpen` or `activeTool` changes — i.e. `open()`, `close()`,
   * `toggle()`, and availability-driven `activeTool` clears.
   * Does NOT fire when only `context` changes (use `'dock:context-changed'`
   * for that). Payload reflects post-mutation values, no-op-guarded by the
   * same equality checks as the mutators.
   *
   * Useful for consumers that mirror only the open/active surface (a
   * workbench panel, a route guard) and don't care about context refreshes.
   */
  'dock:state-changed': {
    isOpen: boolean;
    activeTool: string | null;
  };
  /**
   * Fired only when `context` changes (via `setContext()` with a different
   * reference). Does NOT fire on `open()` / `close()` / `toggle()`.
   * No-op-guarded — same-reference `setContext` calls stay silent.
   *
   * Useful for consumers that mirror only the context (analytics, server
   * sync) and don't care about open/close transitions.
   *
   * The payload uses the default-typed `ToolsDockContext`; the dock's
   * event registry is shared across all `ToolsDockApi` instances and can't
   * flow the factory's `<TData, TActions>` through to per-instance
   * subscribers. Consumers that want typed access should either:
   *
   * 1. Cast at the handler site:
   *    ```ts
   *    dock.on('dock:context-changed', ({ context }) => {
   *      const typed = context as ToolsDockContext<MyData, MyActions> | null;
   *      // ... typed.data?.siteSlug
   *    });
   *    ```
   * 2. Use `dock.context` inside a `$derived` — that read is typed by the
   *    factory's `<TData, TActions>` generics on the returned instance.
   */
  'dock:context-changed': {
    context: ToolsDockContext | null;
  };
  /**
   * Fired by the dock after `isOpen`, `activeTool`, or `context` change —
   * i.e. `open()`, `close()`, `toggle()`, `setContext()`, and availability
   * changes that clear the active tool or shift visible badges. Payload
   * reflects post-mutation values.
   *
   * @deprecated Prefer `'dock:state-changed'` / `'dock:context-changed'`
   * for finer-grained subscriptions — they let consumers ignore the slice
   * of change they don't care about. `'dock:change'` continues to fire
   * (back-compat) and may be removed in a future major.
   */
  'dock:change': {
    isOpen: boolean;
    activeTool: string | null;
    context: ToolsDockContext | null;
  };
}

/**
 * Public reactive API for a tools dock instance. Two generics carry through
 * from the factory site so `dock.context` and `dock.setContext()` flow with
 * the consumer's narrowed types:
 *
 * - `TData` types the shape of `context.data`. Defaults to
 *   `Record<string, unknown>`.
 * - `TActions` types the shape of `context.actions`. Defaults to
 *   `Record<string, (...args: any[]) => unknown>` so the untyped pattern
 *   `dock.setContext({ actions: { triggerSave() {} } })` keeps compiling
 *   without a generic argument.
 *
 * The constraint mirrors {@link ToolsDockContext} — a self-mapped
 * `{ [K in keyof TActions]: (...args: any[]) => any }` — so interface-style
 * action maps satisfy the bound without requiring a string index signature.
 *
 * @example
 * ```ts
 * interface MyData { siteSlug: string }
 * interface MyActions { triggerSave(): void }
 *
 * const dock = defineToolsDock<MyData, MyActions>({ tools: [...] });
 *
 * // typed:
 * dock.setContext({
 *   type: 'route',
 *   data: { siteSlug: 'demo' },
 *   actions: { triggerSave() {} },
 * });
 * const slug: string | undefined = dock.context?.data?.siteSlug;
 * ```
 */
export interface ToolsDockApi<
  TData = Record<string, unknown>,
  TActions extends { [K in keyof TActions]: (...args: any[]) => any } = Record<
    string,
    (...args: any[]) => unknown
  >,
> {
  readonly activeTool: string | null;
  readonly isOpen: boolean;
  readonly availableTools: ReadonlyArray<AvailableTool>;
  /**
   * The current dock context (route data, selection, etc.) as supplied via
   * `setContext()`. Typed against the factory's `<TData, TActions>` generics —
   * narrow them at the `defineToolsDock<TData, TActions>(...)` call site for
   * typed access without a cast.
   */
  readonly context: ToolsDockContext<TData, TActions> | null;
  open(id?: string): void;
  close(): void;
  toggle(id?: string): void;
  setContext(ctx: ToolsDockContext<TData, TActions> | null): void;
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
