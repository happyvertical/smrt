/**
 * Playbook preflight (issue #2590).
 *
 * Playbooks are not atomic and have no compensation, so the real failure mode
 * is half-execution — five steps started, dead at four. Preflight is what
 * prevents that, and secondarily lets a tool listing hide playbooks the caller
 * cannot run.
 *
 * **Preflight predicts; it never grants.** Every step re-enforces at execution,
 * unconditionally — at the REST boundary in the browser, and by
 * `PrincipalRun.assertToolAllowed()` / `assertOperation()` server-side. Without
 * that, a permission revoked mid-playbook would leave a cached "allowed"
 * standing, which is a time-of-check/time-of-use bypass. Nothing in this module
 * executes, authorizes, or caches an authorization.
 *
 * The two planes are deliberately asymmetric:
 *
 * - **Server** is a predicate that already exists. `PrincipalRun` exposes
 *   `isToolAllowed(tool): boolean` alongside the throwing `assertToolAllowed()`,
 *   and `assertOperation` wraps `assertOperationPermission`. Preflight is the
 *   intersection of each step against those two, evaluated and never executed.
 * - **Browser** cannot reuse the generated REST auth contract at all.
 *   `authMiddleware` is `(objectName, action) => (req) => Promise<Request |
 *   Response>`: request-bound, `Response`-returning rather than boolean, and
 *   free to consult session stores, rate-limit, or audit. It is not a dry-run
 *   predicate, so preflight covers the **static layers only** — action exposure,
 *   `public` access, and field-level permission slugs — and reports the app-auth
 *   layer as `unknown`. It never invokes `authMiddleware`, synthetically or
 *   otherwise.
 */

import { getPlaybookCacheGeneration } from './cache.js';
import { PlaybookOverrideCollection } from './collections/PlaybookOverrideCollection.js';
import { resolvePlaybook } from './playbook-resolver.js';
import {
  getCachedPlaybookPreflight,
  setCachedPlaybookPreflight,
} from './preflight-cache.js';
import type {
  BrowserPreflightOptions,
  PlaybookPreflightAvailableReport,
  PlaybookPreflightReport,
  PlaybookPreflightRequest,
  PlaybookPreflightUnavailableReport,
  PreflightLayerReport,
  PreflightStepEvaluator,
  PreflightStepReport,
  PreflightSummary,
  PreflightVerdict,
  ServerPreflightOptions,
} from './preflight-types.js';
import type {
  PlaybookOperationStep,
  PlaybookPlan,
  PlaybookPlanStep,
  ResolvePlaybookOptions,
} from './types.js';

/**
 * The one response every unresolvable playbook produces.
 *
 * Frozen and shared so an unknown key and an unauthorized key are byte-for-byte
 * identical: same shape, same values, no key echo, no reason code, no message.
 * Preflight answers only for playbooks resolvable through the caller's own
 * layer chain, and says nothing about anything else — including whether it
 * exists.
 */
export const PLAYBOOK_PREFLIGHT_UNAVAILABLE: PlaybookPreflightUnavailableReport =
  Object.freeze({
    available: false,
    advisory: true,
    verdict: 'deny',
    steps: Object.freeze([]),
    summary: Object.freeze({ allow: 0, deny: 0, unknown: 0 }),
  }) as PlaybookPreflightUnavailableReport;

/**
 * The capability classification of the preflight surface itself: a read, safely
 * repeatable, with no effect outside the system it reports on. Both planes
 * expose it under a default read-only exposure policy.
 */
export const PLAYBOOK_PREFLIGHT_CAPABILITY = Object.freeze({
  effect: 'read',
  idempotent: true,
  openWorld: false,
} as const);

const VERDICT_RANK: Record<PreflightVerdict, number> = {
  allow: 0,
  unknown: 1,
  deny: 2,
};

/** Fail-closed combination: `deny` beats `unknown` beats `allow`. */
export function worstVerdict(
  left: PreflightVerdict,
  right: PreflightVerdict,
): PreflightVerdict {
  return VERDICT_RANK[right] > VERDICT_RANK[left] ? right : left;
}

function combineLayers(
  layers: readonly PreflightLayerReport[],
): Pick<PreflightStepReport, 'verdict' | 'reason'> {
  let verdict: PreflightVerdict = 'allow';
  for (const layer of layers) {
    verdict = worstVerdict(verdict, layer.verdict);
  }
  // The step's reason is the first layer that produced the aggregate verdict,
  // so the reason and the verdict can never describe different layers.
  const source = layers.find((layer) => layer.verdict === verdict);
  return { verdict, reason: source?.reason ?? 'ok' };
}

function summarize(steps: readonly PreflightStepReport[]): PreflightSummary {
  const summary: PreflightSummary = { allow: 0, deny: 0, unknown: 0 };
  for (const step of steps) {
    summary[step.verdict] += 1;
  }
  return summary;
}

/**
 * Decomposes a resolved plan into per-step verdicts using `evaluate`.
 *
 * Every step is evaluated — evaluation does not short-circuit on the first
 * denial, because the point of preflight is to show the caller *which* step of
 * five would die, not merely that one would.
 */
export async function preflightPlan(
  plan: PlaybookPlan,
  evaluate: PreflightStepEvaluator,
): Promise<PlaybookPreflightAvailableReport> {
  const steps: PreflightStepReport[] = [];

  for (const planStep of plan.steps) {
    const { layers } = await evaluate(planStep);
    steps.push(
      Object.freeze({
        index: planStep.index,
        kind: planStep.step.kind,
        ...combineLayers(layers),
        layers: Object.freeze([...layers]),
      }),
    );
  }

  let verdict: PreflightVerdict = 'allow';
  for (const step of steps) {
    verdict = worstVerdict(verdict, step.verdict);
  }

  return Object.freeze({
    available: true,
    advisory: true,
    key: plan.key,
    plane: plan.plane,
    title: plan.title,
    description: plan.description,
    verdict,
    steps: Object.freeze(steps),
    summary: Object.freeze(summarize(steps)),
  }) as PlaybookPreflightAvailableReport;
}

/**
 * Pays the override-layer read cost a resolvable playbook would have paid.
 *
 * `resolvePlaybook()` short-circuits an unknown key before it touches the
 * override table, while a key that exists but is disabled, wrong-plane, or
 * otherwise unresolvable reads the layers first. Left alone, that difference is
 * a timing oracle over exactly the question the uniform response exists to
 * refuse. Running the same read on the unknown path puts both in the same
 * timing class (one override round-trip, then the shared frozen response).
 *
 * Best-effort by construction: preflight is advisory, so a failure here changes
 * nothing about the answer.
 */
async function equalizeUnknownKeyCost(
  key: string,
  options: ResolvePlaybookOptions | undefined,
): Promise<void> {
  if (!options?.db) {
    return;
  }

  try {
    const collection = await PlaybookOverrideCollection.create({
      db: options.db,
    });
    await collection.getResolutionLayers(key, options.tenantId ?? null);
  } catch {
    // Advisory only — never let the equalizer change the answer or throw.
  }
}

/**
 * Preflights one playbook for one caller on one plane.
 *
 * Resolves through the **caller's own layer chain** (their tenant, their
 * overrides, their plane), decomposes the plan, and evaluates each step with the
 * plane's evaluator. Any playbook the chain cannot resolve — unknown, disabled,
 * wrong plane, unresolvable intent — returns the single
 * {@link PLAYBOOK_PREFLIGHT_UNAVAILABLE} value.
 *
 * Results are cached per `(principal, key, plane)` under the playbook cache's
 * generation counter; see `preflight-cache.ts` for why that is safe.
 */
export async function preflightPlaybook(
  request: PlaybookPreflightRequest,
): Promise<PlaybookPreflightReport> {
  const { key, plane, principal, resolve, evaluate } = request;
  const db = resolve?.db;

  const cached = getCachedPlaybookPreflight(principal, key, plane, db);
  if (cached) {
    return cached;
  }

  const loadedAtGeneration = getPlaybookCacheGeneration(key, db);
  const resolution = await resolvePlaybook(key, { ...resolve, plane });

  if (!resolution.ok) {
    if (resolution.reason === 'unknown-playbook') {
      await equalizeUnknownKeyCost(key, resolve);
    }
    setCachedPlaybookPreflight(
      principal,
      key,
      plane,
      db,
      PLAYBOOK_PREFLIGHT_UNAVAILABLE,
      loadedAtGeneration,
    );
    return PLAYBOOK_PREFLIGHT_UNAVAILABLE;
  }

  const report = await preflightPlan(resolution.plan, evaluate);
  setCachedPlaybookPreflight(
    principal,
    key,
    plane,
    db,
    report,
    loadedAtGeneration,
  );
  return report;
}

function layer(
  layerName: PreflightLayerReport['layer'],
  verdict: PreflightVerdict,
  reason: PreflightLayerReport['reason'],
  missingPermissions?: readonly string[],
): PreflightLayerReport {
  return Object.freeze({
    layer: layerName,
    verdict,
    reason,
    ...(missingPermissions?.length
      ? { missingPermissions: Object.freeze([...missingPermissions]) }
      : {}),
  });
}

/**
 * Server-plane evaluator: the intersection of the persona tool allow-list and
 * the operation-permission predicate, per step, with nothing executed.
 *
 * An intent step is reported against its **declared** plane validity: an intent
 * that does not declare `server` is denied with reason `plane`, and one that
 * does is `unknown`, because server validity rides the #2446 command/ack bridge
 * whose acknowledgement is not statically knowable. This repeats a check
 * resolution already made, deliberately — the same defense-in-depth shape as
 * `assertToolAllowed()` gating both the tool offer and its execution.
 */
export function createServerStepEvaluator(
  options: ServerPreflightOptions,
): PreflightStepEvaluator {
  return async (planStep: PlaybookPlanStep) => {
    const step = planStep.step;

    if (step.kind === 'intent') {
      const planes = options.intentPlanes?.(step.id) ?? null;
      const serverValid = planes?.includes('server') ?? false;
      return {
        layers: [
          serverValid
            ? layer('plane', 'unknown', 'intent-bridge-not-evaluated')
            : layer('plane', 'deny', 'plane'),
        ],
      };
    }

    const operation: PlaybookOperationStep = step;
    const toolLayer = options.isToolAllowed(operation)
      ? layer('tool-allowlist', 'allow', 'ok')
      : layer('tool-allowlist', 'deny', 'tool-not-allowed');

    const permissionVerdict = await options.checkOperationPermission(operation);
    const permissionLayer =
      permissionVerdict === 'allow'
        ? layer('operation-permission', 'allow', 'ok')
        : permissionVerdict === 'deny'
          ? layer('operation-permission', 'deny', 'permission-denied')
          : layer('operation-permission', 'unknown', 'permission-unknown');

    return { layers: [toolLayer, permissionLayer] };
  };
}

/**
 * Browser-plane evaluator: the static layers only.
 *
 * - `action-exposure` — `isApiActionEnabled`. A disabled action is a hard,
 *   statically knowable deny (the route answers 405).
 * - `public-access` — `isRoutePublic`. A non-public route with **no** app auth
 *   middleware wired is a hard deny (the generator's fail-closed 401); with one
 *   wired it is `unknown`, because whether that middleware passes is exactly
 *   what preflight refuses to guess.
 * - `field-permissions` — the model's declared field read-permission slugs
 *   against the caller's published set. Missing slugs redact fields rather than
 *   fail the step, so the verdict stays `allow` and carries
 *   `reason: 'fields-redacted'` plus the missing slugs; an unpublished
 *   permission set reports `unknown`.
 * - `app-auth` — `unknown` whenever a middleware is wired. This is the layer an
 *   `authPredicate` seam would later fill in.
 *
 * An intent step never crosses the REST boundary at all, so it is reported
 * `unknown` against `intent-mount`: whether the surface is mounted and what its
 * staged-control review does are runtime facts of the page, not of the build.
 */
export function createBrowserStepEvaluator(
  options: BrowserPreflightOptions,
): PreflightStepEvaluator {
  const held = options.permissions ? new Set(options.permissions) : null;

  return (planStep: PlaybookPlanStep) => {
    const step = planStep.step;

    if (step.kind === 'intent') {
      return {
        layers: [layer('intent-mount', 'unknown', 'intent-not-mounted')],
      };
    }

    const { model, action } = step;
    const layers: PreflightLayerReport[] = [];

    const exposed = options.layers.isActionExposed(model, action);
    layers.push(
      exposed
        ? layer('action-exposure', 'allow', 'ok')
        : layer('action-exposure', 'deny', 'action-not-exposed'),
    );

    const isPublic = options.layers.isRoutePublic(model, action);
    const appAuthConfigured = options.layers.appAuthConfigured;
    layers.push(
      isPublic
        ? layer('public-access', 'allow', 'ok')
        : appAuthConfigured
          ? layer('public-access', 'unknown', 'auth-required')
          : layer('public-access', 'deny', 'not-public'),
    );

    const required = options.layers.requiredFieldPermissions(model, action);
    if (!required.length) {
      layers.push(layer('field-permissions', 'allow', 'ok'));
    } else if (!held) {
      layers.push(
        layer('field-permissions', 'unknown', 'field-permissions-unknown'),
      );
    } else {
      const missing = required.filter((slug) => !held.has(slug));
      layers.push(
        missing.length
          ? // Missing a field read permission redacts the field; it does not
            // fail the step. Reporting `deny` here would predict a failure that
            // will not happen.
            layer('field-permissions', 'allow', 'fields-redacted', missing)
          : layer('field-permissions', 'allow', 'ok'),
      );
    }

    layers.push(
      appAuthConfigured
        ? layer('app-auth', 'unknown', 'app-auth-not-evaluated')
        : layer('app-auth', 'allow', 'app-auth-not-configured'),
    );

    return { layers };
  };
}
