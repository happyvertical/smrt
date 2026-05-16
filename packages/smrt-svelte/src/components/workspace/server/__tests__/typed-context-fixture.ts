/**
 * Compile-time regression fixture for the `TCtx` generic on
 * `composeDockAvailability` / `ComposeDockAvailabilityOptions` /
 * `GateEvaluator`.
 *
 * This is the contract round-3 of PR #1242 is restoring:
 *
 *   - `TCtx` must accept an INTERFACE (no string index signature). The
 *     round-1 fixup tightened the constraint to
 *     `TCtx extends Record<string, unknown>`, which silently rejected
 *     interface-style contexts — the same trap Copilot caught with
 *     `TActions` in PR #1239. The constraint is now a self-mapped
 *     `{ [K in keyof TCtx]: unknown }` (matching the `TActions` pattern in
 *     `../../types.ts`).
 *
 *   - The default `TCtx = GateEvaluationContext` must keep existing
 *     untyped call sites compiling unchanged.
 *
 *   - The factory's `<TCtx>` generic must flow through to each evaluator
 *     so `ctx.fieldName` is typed without a cast at the evaluator call
 *     site.
 *
 * Lives in a `.ts` file (NOT `.test.ts`) so:
 *   - `tsc --noEmit` (the package's `typecheck` script, run in CI via
 *     `pnpm turbo run typecheck`) does include it — the package's
 *     `tsconfig.svelte.json` includes `src/** /*.ts` and excludes only
 *     `**\/*.test.ts` and `**\/*.spec.ts`.
 *   - Vitest does NOT execute it (no `.test.ts` suffix), so the
 *     `_assertInterfaceTCtx*` symbols below never run — their bodies must
 *     just compile.
 *
 * Mirrors the same pattern as
 * `../../__tests__/typed-tool-fixture/register-typed-tool.ts` (PR #1239).
 */

import { composeDockAvailability } from '../compose-availability.js';
import type {
  ComposeDockAvailabilityOptions,
  GatedToolSummary,
  GateEvaluationContext,
  GateEvaluator,
} from '../types.js';

/**
 * Interface-style context — no string index signature. Under a bare
 * `Record<string, unknown>` constraint this fails to satisfy `TCtx`
 * (TS2344). Under the self-mapped `{ [K in keyof TCtx]: unknown }`
 * constraint it's accepted.
 */
interface MyInterfaceContext {
  userId: string;
  tenantId: string;
}

/**
 * Type-only assertion: an `Options` literal parameterized over an
 * interface-style context must compile, and the evaluator must receive a
 * typed `ctx` (no cast) with the consumer's field types.
 *
 * If `TCtx` ever tightens back to `Record<string, unknown>`, this
 * declaration fails with TS2344 ("Type 'MyInterfaceContext' does not
 * satisfy the constraint 'Record<string, unknown>'").
 */
export const _assertInterfaceTCtxOptions: ComposeDockAvailabilityOptions<MyInterfaceContext> =
  {
    tools: [],
    context: { userId: 'u-1', tenantId: 't-1' },
    evaluators: {
      permission: (gateId, ctx) => {
        // No cast required — ctx.userId / ctx.tenantId are typed `string`.
        const _userId: string = ctx.userId;
        const _tenantId: string = ctx.tenantId;
        return gateId.startsWith('permission:');
      },
    },
  };

/**
 * Type-only assertion: `GateEvaluator<MyInterfaceContext>` accepts an
 * interface. Same regression as above, but exercised through the
 * `GateEvaluator` alias directly (which `ComposeDockAvailabilityOptions`
 * indexes into via `evaluators`).
 */
export const _assertInterfaceTCtxEvaluator: GateEvaluator<
  MyInterfaceContext
> = (gateId, ctx) => {
  const _: string = ctx.userId;
  return gateId === 'permission:any';
};

/**
 * Type-only assertion: the `composeDockAvailability<TCtx>` factory
 * accepts an interface-style `TCtx` and threads it through to evaluators
 * without erasure. Never called at runtime — its body just has to
 * compile.
 */
export async function _assertInterfaceTCtxFactoryFlow(): Promise<void> {
  const tools: ReadonlyArray<GatedToolSummary> = [
    { id: 't', label: 'T', gates: ['permission:any'] },
  ];
  await composeDockAvailability<MyInterfaceContext>({
    tools,
    context: { userId: 'u-1', tenantId: 't-1' },
    evaluators: {
      permission: (_gateId, ctx) => {
        // TYPED: ctx.userId is `string`, not `unknown`. If the factory
        // dropped its generic on the evaluator signature, the next line
        // would only compile as `unknown`.
        const _userId: string = ctx.userId;
        return true;
      },
    },
  });
}

/**
 * Type-only assertion: the untyped (back-compat) call site must still
 * compile with no generic argument and resolve `TCtx` to the default
 * `GateEvaluationContext` (`Record<string, unknown>`). If the default
 * ever drifted, every existing untyped consumer would break.
 */
export async function _assertUntypedDefaultTCtx(): Promise<void> {
  const ctx: GateEvaluationContext = { foo: 'bar' };
  await composeDockAvailability({
    tools: [{ id: 't', label: 'T' }],
    context: ctx,
    evaluators: {},
  });
}
