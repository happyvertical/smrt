/**
 * The `overview` preference kind: the sparse `OverviewOverride` of a
 * customizable overview page (`@happyvertical/smrt-svelte/overview`).
 *
 * The surface id is the page's `OverviewDefinition.id`. Validation needs the
 * page definition and widget registry, which the caller passes as the kind's
 * `options` (`{ definition, registry }`); the overview layer in
 * `../overview.ts` does that for every call.
 */
import {
  checkOverviewOverride,
  diffOverview,
  type OverviewDefinition,
  type OverviewDocument,
  type OverviewIssue,
  resolveOverview,
  type WidgetRegistry,
} from '@happyvertical/smrt-svelte/overview/server';
import type {
  PreferenceIssue,
  PreferenceKindDefinition,
  PreferenceValidation,
} from '../kinds.js';
import {
  CUSTOMIZE_OVERVIEW_PERMISSION,
  PERSONALIZE_OVERVIEW_PERMISSION,
} from '../permissions.js';

export const OVERVIEW_PREFERENCE_KIND = 'overview';

/** The validation inputs of the `overview` kind. */
export interface OverviewKindOptions {
  definition: OverviewDefinition;
  registry: WidgetRegistry;
}

/**
 * `definition` with another tier's document as its defaults: the definition a
 * user-tier controller and save are validated against
 * (`withTenantDefaults(definition, state.tenant.document)`).
 */
export function withTenantDefaults(
  definition: OverviewDefinition,
  document: OverviewDocument,
): OverviewDefinition {
  return { ...definition, defaults: document.widgets };
}

function toPreferenceIssue(issue: OverviewIssue): PreferenceIssue {
  return {
    path: issue.widgetId,
    code: issue.code,
    message: issue.message,
    detail: issue,
  };
}

/** The `OverviewIssue` behind a preference issue (or a generic one). */
export function toOverviewIssue(issue: PreferenceIssue): OverviewIssue {
  if (issue.detail && typeof issue.detail === 'object') {
    return issue.detail as OverviewIssue;
  }
  return {
    widgetId: null,
    type: null,
    code: issue.code === 'future_version' ? 'future_version' : 'malformed',
    message: issue.message,
  };
}

function readOptions(options: unknown): OverviewKindOptions | null {
  if (!options || typeof options !== 'object') return null;
  const { definition, registry } = options as Partial<OverviewKindOptions>;
  if (!definition || !registry) return null;
  return { definition, registry };
}

/**
 * The definition one tier validates against: the page definition for the
 * tenant tier, the tenant-merged one for the user tier.
 */
export function overviewTierDefinition(
  { definition, registry }: OverviewKindOptions,
  scope: 'tenant' | 'user',
  tenantOverride: unknown,
): OverviewDefinition {
  if (scope === 'tenant') return definition;
  const tenant = resolveOverview(definition, tenantOverride ?? null, registry);
  return withTenantDefaults(definition, tenant.document);
}

export const overviewPreferenceKind: PreferenceKindDefinition = {
  kind: OVERVIEW_PREFERENCE_KIND,
  formatVersion: 1,
  permissions: {
    tenant: CUSTOMIZE_OVERVIEW_PERMISSION,
    user: PERSONALIZE_OVERVIEW_PERMISSION,
  },
  validate(payload, ctx): PreferenceValidation {
    const options = readOptions(ctx.options);
    if (!options || options.definition.id !== ctx.surfaceId) {
      return {
        ok: false,
        canonical: null,
        issues: [
          {
            path: null,
            code: 'missing_context',
            message:
              'the overview kind needs { definition, registry } for this surface',
          },
        ],
      };
    }
    const definition = overviewTierDefinition(options, ctx.scope, ctx.tenant);
    if (ctx.phase === 'save') {
      const checked = checkOverviewOverride(
        definition,
        payload,
        options.registry,
      );
      return checked.ok
        ? { ok: true, canonical: checked.override, issues: [] }
        : {
            ok: false,
            canonical: null,
            issues: checked.issues.map(toPreferenceIssue),
          };
    }
    const resolved = resolveOverview(definition, payload, options.registry);
    return {
      ok: resolved.overrideIssues.length === 0,
      canonical: diffOverview(resolved.base, resolved.document),
      issues: resolved.overrideIssues.map(toPreferenceIssue),
    };
  },
};
