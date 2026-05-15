/**
 * Registration site for the typed-tool fixture. This file is the contract
 * the workspace ergonomics PR (#1239) is restoring:
 *
 *   - `TypedTool.svelte` declares its own typed `context` prop of shape
 *     `ToolsDockContext<MyData, MyActions> | null`.
 *   - It must be assignable to `ToolDef.component` without a registration-
 *     site cast.
 *   - `defineToolsDock<MyData, MyActions>(...)` must accept an interface
 *     `MyActions` (no string index signature) under the factory generic.
 *   - `dock.setContext({ actions: { triggerSave } })` must still compile
 *     with no generic arguments (back-compat for the untyped pattern).
 *
 * If TypeScript ever rejects this file under strict checks, the regression
 * from review thread #1239/PRRT_kwDOQDruXs6CbBcK has returned.
 */

import type {
  DefineToolsDockOptions,
  ToolDef,
  ToolsDockApi,
  ToolsDockContext,
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
