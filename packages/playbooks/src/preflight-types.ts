/**
 * Preflight contract (issue #2590) — the verdict vocabulary both planes share.
 *
 * Kept beside the resolution types rather than inside them because preflight is
 * a *reader* of a resolved plan: nothing here changes what a playbook is, and
 * nothing here executes, authorizes, or grants anything.
 */

import type {
  PlaybookOperationStep,
  PlaybookPlane,
  PlaybookPlanStep,
  PlaybookStep,
  ResolvePlaybookOptions,
} from './types.js';

/**
 * Verdict for one authority layer, one step, or a whole plan.
 *
 * `unknown` is a first-class answer, never a rounded-down `allow`: a layer that
 * cannot be evaluated without executing something says so.
 */
export type PreflightVerdict = 'allow' | 'deny' | 'unknown';

/**
 * The authority layers preflight reports on. The two planes are deliberately
 * asymmetric and report different layers:
 *
 * - server plane — `tool-allowlist`, `operation-permission`, and `plane` for an
 *   intent step;
 * - browser plane — `action-exposure`, `public-access`, `field-permissions`,
 *   `app-auth`, and `intent-mount` for an intent step.
 */
export type PreflightLayer =
  | 'tool-allowlist'
  | 'operation-permission'
  | 'plane'
  | 'action-exposure'
  | 'public-access'
  | 'field-permissions'
  | 'app-auth'
  | 'intent-mount';

/** Why a layer reached its verdict. A stable code, never a free-form message. */
export type PreflightReason =
  | 'ok'
  | 'tool-not-allowed'
  | 'permission-denied'
  | 'permission-unknown'
  | 'plane'
  | 'action-not-exposed'
  | 'not-public'
  | 'auth-required'
  | 'app-auth-not-evaluated'
  | 'app-auth-not-configured'
  | 'fields-redacted'
  | 'field-permissions-unknown'
  | 'intent-not-mounted'
  | 'intent-bridge-not-evaluated'
  | 'not-evaluated';

/** One authority layer's verdict for one step. */
export interface PreflightLayerReport {
  layer: PreflightLayer;
  verdict: PreflightVerdict;
  reason: PreflightReason;
  /**
   * Permission slugs this layer found missing, when it knows them. Present only
   * on layers that evaluate a slug set.
   */
  missingPermissions?: readonly string[];
}

/** A step's aggregate verdict plus the per-layer detail behind it. */
export interface PreflightStepReport {
  index: number;
  kind: PlaybookStep['kind'];
  verdict: PreflightVerdict;
  /** Reason of the first layer that produced the step's aggregate verdict. */
  reason: PreflightReason;
  layers: readonly PreflightLayerReport[];
}

/** What a step evaluator returns; `preflightPlan` supplies `index` and `kind`. */
export interface PreflightStepEvaluation {
  layers: readonly PreflightLayerReport[];
}

/** Evaluates one resolved plan step without executing any part of it. */
export type PreflightStepEvaluator = (
  step: PlaybookPlanStep,
) => PreflightStepEvaluation | Promise<PreflightStepEvaluation>;

export interface PreflightSummary {
  allow: number;
  deny: number;
  unknown: number;
}

export interface PlaybookPreflightAvailableReport {
  available: true;
  /**
   * Literal `true` on every report, as a type-level reminder: a report is a
   * prediction, never a grant, and every step is authorized again where it
   * executes.
   */
  advisory: true;
  key: string;
  plane: PlaybookPlane;
  title: string;
  description: string;
  verdict: PreflightVerdict;
  steps: readonly PreflightStepReport[];
  summary: PreflightSummary;
}

/**
 * The single, uniform answer for every playbook the caller's own layer chain
 * cannot resolve. An unknown key and an unauthorized key produce this exact
 * frozen value, so preflight is not an enumeration oracle: it carries no key,
 * no plane, and no reason to tell the two apart.
 */
export interface PlaybookPreflightUnavailableReport {
  available: false;
  advisory: true;
  verdict: 'deny';
  steps: readonly [];
  summary: PreflightSummary;
}

/** A preflight result. Advisory only — see the two variants above. */
export type PlaybookPreflightReport =
  | PlaybookPreflightAvailableReport
  | PlaybookPreflightUnavailableReport;

/**
 * Static layers a browser-plane step is evaluated against.
 *
 * Everything here is a build-time or configuration fact. The generated
 * `authMiddleware` is deliberately absent: it is request-bound, returns a
 * `Response` rather than a boolean, and may consult session stores, rate-limit,
 * or audit — so preflight never invokes it, synthetically or otherwise, and
 * `appAuthConfigured` is the only thing it is allowed to know about it.
 *
 * An `authPredicate` seam (option 1 in #2590) can later be added as an optional
 * member here, turning the `app-auth` layer's `unknown` into a real verdict
 * without changing the report contract.
 */
export interface BrowserPreflightLayerSource {
  /** `isApiActionEnabled` for the referenced model operation. */
  isActionExposed(model: string, action: string): boolean;
  /** `isRoutePublic` for the HTTP method the action maps to. */
  isRoutePublic(model: string, action: string): boolean;
  /** Field-level read-permission slugs the step's model declares. */
  requiredFieldPermissions(model: string, action: string): readonly string[];
  /** Whether an app-level auth middleware is wired. Never invoked. */
  appAuthConfigured: boolean;
}

export interface BrowserPreflightOptions {
  layers: BrowserPreflightLayerSource;
  /**
   * The caller's published permission slugs, when the host publishes them.
   * `null`/absent makes the field layer report `unknown` rather than guess.
   */
  permissions?: Iterable<string> | null;
}

export interface ServerPreflightOptions {
  /** `PrincipalRun.isToolAllowed` for the slug that gates this step. */
  isToolAllowed(step: PlaybookOperationStep): boolean;
  /**
   * The operation-permission predicate. Evaluates the catalog gate for the
   * step's `(collection, action)` without performing the operation.
   */
  checkOperationPermission(
    step: PlaybookOperationStep,
  ): PreflightVerdict | Promise<PreflightVerdict>;
  /** Declared plane validity of a view intent, from the #2588 registry. */
  intentPlanes?(id: string): readonly PlaybookPlane[] | null | undefined;
}

export interface PlaybookPreflightRequest {
  key: string;
  plane: PlaybookPlane;
  /**
   * Opaque, caller-scoped principal identity used to partition the cache. It is
   * never echoed in the report and never consulted for authority. The cache key
   * also folds in `resolve.tenantId`, so a principal string need not encode the
   * tenant to stay correct.
   */
  principal: string;
  /** Options handed to `resolvePlaybook()` — the caller's own layer chain. */
  resolve?: ResolvePlaybookOptions;
  /** Evaluates each resolved step. */
  evaluate: PreflightStepEvaluator;
}
