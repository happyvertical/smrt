/**
 * Registration site for the typed-tool fixture. This file is the contract
 * the workspace ergonomics PR (#1239) is restoring:
 *
 *   - `TypedTool.svelte` declares its own typed `context` prop of shape
 *     `ToolsDockContext<MyData, MyActions> | null`.
 *   - It must be assignable to `ToolDef.component` without a registration-
 *     site cast — but this assertion is only meaningful under
 *     `svelte-check`. Under `tsc --noEmit`, `.svelte` imports resolve to
 *     `Component<any>` via the ambient `declare module '*.svelte'`
 *     declaration, so the assignment compiles regardless of what
 *     `ToolDef.component` is typed as. CI runs both `typecheck` and `check`
 *     (which invokes `svelte-check`) for this reason — see the JSDoc on
 *     `../typed-tool-fixture.test.ts` for the full split.
 *   - `defineToolsDock<MyData, MyActions>(...)` must accept an interface
 *     `MyActions` (no string index signature) under the factory generic.
 *   - `dock.setContext({ actions: { triggerSave } })` must still compile
 *     with no generic arguments (back-compat for the untyped pattern).
 *   - The factory's `<TData, TActions>` generics must flow through to the
 *     returned `ToolsDockInstance<TData, TActions>` — see
 *     `_assertTypedDockFlow` below for the load-bearing assertion.
 *
 * If TypeScript ever rejects this file under strict checks, the regression
 * from review thread #1239/PRRT_kwDOQDruXs6CbBcK has returned.
 */

import {
  type DefineToolsDockOptions,
  defineToolsDock,
  type ToolDef,
  type ToolsDockApi,
  type ToolsDockContext,
  type ToolsDockInstance,
} from '../../index.js';
import TypedTool from './TypedTool.svelte';
import type { MyActions, MyData } from './typed-tool-types.js';

/** Type-only export: a tool registry that uses the typed component. */
export const typedTool: ToolDef = {
  id: 'typed',
  label: 'Typed',
  // ↳ TypedTool's `context` prop is narrower than the base
  //   `ToolsDockContext | null`. Under strict prop variance this would be
  //   rejected if `ToolDef.component` were typed as
  //   `Component<{ context: ToolsDockContext | null; dock: ToolsDockApi }>`.
  component: TypedTool,
};

/** Type-only export: options that pass the typed action map through. */
export const typedOptions: DefineToolsDockOptions<MyData, MyActions> = {
  tools: [typedTool],
};

/**
 * Type-only export: a typed context literal. This must compile under the
 * relaxed `TActions extends { [K in keyof TActions]: (...args: any[]) => any }`
 * constraint — `MyActions` is an interface (no string index signature) and
 * would fail a `Record<string, ...>` constraint.
 */
export const typedContext: ToolsDockContext<MyData, MyActions> = {
  type: 'route',
  data: { siteSlug: 'demo', contentId: 'demo-1' },
  actions: {
    triggerSave: () => undefined,
    triggerReview: (_kind: string) => undefined,
  },
};

/**
 * Type-only export: the untyped (back-compat) setContext shape — passing
 * `actions` with no factory generic. This caught a previous regression
 * where `TActions = Record<string, never>` defaulted the action map to
 * "no keys", rejecting `{ triggerSave }` outright.
 */
export const untypedContext: ToolsDockContext = {
  type: 'route',
  actions: {
    triggerSave: () => undefined,
  },
};

/** Type-only assertion: typed instance preserves the action shape. */
export type _AssertTypedActions = ToolsDockApi['context'] extends infer C
  ? C
  : never;

/**
 * Type-only fixture: exercises the end-to-end generic flow on the public
 * surface returned by `defineToolsDock<TData, TActions>(...)`. This is the
 * regression Codex flagged in PR #1239 round-2 — the factory accepts the
 * generics but erases them on the return type, so `dock.setContext(...)` and
 * `dock.context?.data` fall back to the default-typed shape.
 *
 * The function below is never called at runtime. Its body has to compile,
 * which is the load-bearing assertion: if `ToolsDockApi` / `ToolsDockInstance`
 * ever stop parameterizing their `context` / `setContext` signatures, the
 * lines marked TYPED below would fail to assign `MyData` / `MyActions` into
 * the default-typed shape (no string index signature).
 *
 * Lives inline rather than at module scope because `defineToolsDock` calls
 * `setContext`, which is only legal inside a component init scope.
 */
export function _assertTypedDockFlow(): ToolsDockInstance<MyData, MyActions> {
  const typedDock = defineToolsDock<MyData, MyActions>({
    tools: [typedTool],
    fetchAvailability: async (ctx) => {
      // TYPED: `ctx?.data?.siteSlug` must be `string | undefined`, not
      // `unknown`. If the factory dropped its generics on the callback
      // signature, the next line would only compile as `unknown`.
      const _siteSlug: string | undefined = ctx?.data?.siteSlug;
      const _save: (() => void) | undefined = ctx?.actions?.triggerSave;
      return [];
    },
  });

  // TYPED: `setContext` accepts the narrowed context with no manual cast.
  // Pre-fix this assignment failed because `ToolsDockApi.setContext` was
  // typed to receive only the default-generic `ToolsDockContext`, whose
  // `actions` slot expected `Record<string, (...args: any[]) => unknown>` —
  // `MyActions` (an interface, no string index signature) was rejected.
  typedDock.setContext({
    type: 'route',
    data: { siteSlug: 'demo', contentId: 'demo-1' },
    actions: {
      triggerSave: () => undefined,
      triggerReview: (_kind: string) => undefined,
    },
  });

  // TYPED: reading typed properties off the public `context` surface must
  // resolve to the consumer's shapes, not `Record<string, unknown>` /
  // `Record<string, (...args: any[]) => unknown>`.
  const _slug: string | undefined = typedDock.context?.data?.siteSlug;
  const _action: (() => void) | undefined =
    typedDock.context?.actions?.triggerSave;

  return typedDock;
}
