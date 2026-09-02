/**
 * Server-plane playbook preflight as a `PrincipalTool` (issue #2590).
 *
 * Playbooks are not atomic and have no compensation, so the real failure mode
 * is half-execution — five steps started, dead at four. This tool predicts that
 * ahead of time by intersecting each step against the two predicates
 * `PrincipalRun` already exposes:
 *
 * - `isToolAllowed(tool)` — the persona's fail-closed allow-list, the same gate
 *   `assertToolAllowed()` throws on;
 * - `assertOperation(collection, action)` — the catalog permission gate, which
 *   *evaluates* the operation's permission without performing the operation.
 *
 * **It never executes a step, and it never grants one.** Name gates entry;
 * decomposition gates every step. Preflight computes the intersection ahead of
 * time; it replaces neither gate, and every step is authorized again when the
 * agent actually runs it — so a permission revoked between the prediction and
 * the execution still denies at execution.
 */

import {
  ObjectRegistry,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  createServerStepEvaluator,
  type PlaybookIntentResolver,
  type PlaybookOperationClassifier,
  type PlaybookOperationStep,
  type PlaybookPlane,
  type PlaybookPreflightReport,
  type PreflightVerdict,
  preflightPlaybook,
} from '@happyvertical/smrt-playbooks';
import {
  type OperationPermissionCollectionInput,
  OperationPermissionError,
} from '@happyvertical/smrt-users';
import type { PrincipalRun } from './execute-as-principal.js';
import type { PrincipalTool, PrincipalToolContext } from './invoke-agent.js';

/** Tool name + permission slug, gated by the persona's `allowedTools`. */
export const PLAYBOOK_PREFLIGHT_TOOL_SLUG = 'playbooks.preflight';

/** Provider function name offered to the model. */
export const PLAYBOOK_PREFLIGHT_FUNCTION_NAME = 'playbook_preflight';

/**
 * Resolves the REST/permission collection slug a qualified model reference maps
 * to (`@happyvertical/smrt-commerce:Order` → `orders`), falling back to the
 * lower-cased class name for a model this process has not registered.
 */
export function playbookStepCollection(model: string): string {
  const registered = model.includes(':')
    ? ObjectRegistry.getClassByQualifiedName(model)
    : ObjectRegistry.getClass(model);
  if (registered?.collection) {
    return registered.collection;
  }
  const simple = model.includes(':')
    ? (model.split(':').pop() ?? model)
    : model;
  return simple.toLowerCase();
}

/** Default persona tool slug gating an operation step: `<collection>.<action>`. */
export function playbookStepToolSlug(step: PlaybookOperationStep): string {
  return `${playbookStepCollection(step.model)}.${step.action}`;
}

export interface CreatePlaybookPreflightToolOptions {
  /** Database handle used to resolve the caller's override layers. */
  db?: SmrtClassOptions['db'];
  /** Tenant scope for resolution. Defaults to the live run's tenant. */
  tenantId?: string | null;
  /**
   * Maps an operation step to the persona tool slug that gates it. Defaults to
   * {@link playbookStepToolSlug}.
   */
  toolSlug?: (step: PlaybookOperationStep) => string;
  /**
   * Maps an operation step to the permission-catalog collection. Defaults to
   * the registered collection slug for the step's model.
   */
  collection?: (
    step: PlaybookOperationStep,
  ) => OperationPermissionCollectionInput;
  /** Host classification source for operation steps. */
  classifier?: PlaybookOperationClassifier;
  /** Host intent registry (the #2588 seam). */
  intents?: PlaybookIntentResolver;
  /** Override the tool description offered to the model. */
  description?: string;
}

function preflightFor(
  run: PrincipalRun,
  key: string,
  options: CreatePlaybookPreflightToolOptions,
): Promise<PlaybookPreflightReport> {
  const toolSlug = options.toolSlug ?? playbookStepToolSlug;
  const collectionFor =
    options.collection ??
    ((step: PlaybookOperationStep) => playbookStepCollection(step.model));

  const tenantId =
    options.tenantId !== undefined ? options.tenantId : run.context.tenantId;

  return preflightPlaybook({
    key,
    plane: 'server',
    // Cache partition only. Taken from the LIVE run context, never from tool
    // arguments, so one principal's cached prediction can never be served to
    // another.
    principal: `${run.context.userId ?? 'anonymous'}|${tenantId ?? 'global'}`,
    resolve: {
      ...(options.db === undefined ? {} : { db: options.db }),
      tenantId: tenantId ?? null,
      ...(options.classifier ? { classifier: options.classifier } : {}),
      ...(options.intents ? { intents: options.intents } : {}),
    },
    evaluate: createServerStepEvaluator({
      isToolAllowed: (step: PlaybookOperationStep): boolean =>
        run.isToolAllowed(toolSlug(step)),
      async checkOperationPermission(
        step: PlaybookOperationStep,
      ): Promise<PreflightVerdict> {
        try {
          // Evaluates the catalog gate for `(collection, action)`. Nothing is
          // performed: `assertOperation` authorizes, it does not act.
          const decision = await run.assertOperation(
            collectionFor(step),
            step.action,
          );
          return decision.allowed ? 'allow' : 'deny';
        } catch (error) {
          if (error instanceof OperationPermissionError) {
            return 'deny';
          }
          // An evaluation failure is not a denial and not an approval. Saying
          // `unknown` keeps preflight honest; execution decides for real.
          return 'unknown';
        }
      },
      ...(options.intents
        ? {
            intentPlanes: (id: string): readonly PlaybookPlane[] | null =>
              options.intents?.(id)?.planes ?? null,
          }
        : {}),
    }),
  });
}

/**
 * Builds the **playbook preflight** tool.
 *
 * Offered through the conversational tool loop and gated by the persona's
 * `allowedTools` like any other tool. Its handler re-asserts that gate, resolves
 * the requested playbook through the caller's own layer chain on the `server`
 * plane, and reports a per-step verdict. A playbook the chain cannot resolve —
 * unknown key or unauthorized key alike — returns the single uniform
 * "unavailable" report, so the tool is not an enumeration oracle.
 */
export function createPlaybookPreflightTool(
  options: CreatePlaybookPreflightToolOptions = {},
): PrincipalTool {
  return {
    slug: PLAYBOOK_PREFLIGHT_TOOL_SLUG,
    aiTool: {
      type: 'function',
      function: {
        name: PLAYBOOK_PREFLIGHT_FUNCTION_NAME,
        description:
          options.description ??
          'Predict, without running anything, which steps of a playbook you ' +
            'would be allowed to perform. Advisory only: every step is ' +
            'authorized again when it actually runs.',
        parameters: {
          type: 'object',
          required: ['key'],
          properties: {
            key: {
              type: 'string',
              description: 'The playbook key to preflight.',
            },
          },
        },
      },
    },
    async execute({
      run,
      args,
    }: PrincipalToolContext): Promise<PlaybookPreflightReport> {
      // Execution gate (defense-in-depth behind the offer gate).
      run.assertToolAllowed(PLAYBOOK_PREFLIGHT_TOOL_SLUG);

      const key = typeof args.key === 'string' ? args.key.trim() : '';
      if (!key) {
        throw new Error("playbook preflight requires a non-empty 'key'.");
      }

      return preflightFor(run, key, options);
    },
  };
}

/**
 * Filters a candidate playbook listing down to what the caller could plausibly
 * run, so a tool list does not advertise a playbook that dies at step four.
 *
 * **This filter is a listing convenience, never an authorization decision.** A
 * key it lets through is still authorized step by step at execution, and a key
 * it hides is still denied at execution — nothing downstream may treat presence
 * in this list as permission. Ordering is preserved so a listing is stable.
 */
export async function filterPlaybooksByPreflight(
  run: PrincipalRun,
  keys: readonly string[],
  options: CreatePlaybookPreflightToolOptions = {},
): Promise<string[]> {
  const allowed: string[] = [];
  for (const key of keys) {
    const report = await preflightFor(run, key, options);
    if (report.available && report.verdict !== 'deny') {
      allowed.push(key);
    }
  }
  return allowed;
}
