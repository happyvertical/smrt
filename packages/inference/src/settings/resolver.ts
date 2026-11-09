/**
 * An `InferenceResolver` that applies the stored app and tenant bindings
 * (#4754) at call time: config < app row < allowed tenant row. A tier with
 * no stored binding defers to `base` (another resolver, e.g. #4756's
 * per-user one) or to core's built-in config resolution, so an empty table
 * changes nothing.
 *
 * Aliases defined only in app rows are not visible to the executor (it reads
 * the process config), so a stored binding to such an alias is returned as
 * the alias's inline candidate chain, expanded recursively; aliases that the
 * config defines stay references.
 *
 * Fusions defined in app rows reach the executor through `lookupFusion()`
 * (#4800, core's `InferenceExecutionContext.lookupFusion`): read from the
 * app scope only (a tenant never defines a fusion), validated against
 * config + app rows including every seat's prompt key (an invalid row throws
 * `InferenceConfigError`, never runs), with app-only seat aliases inlined
 * the same way. An app row shadows a config fusion of the same name.
 */
import {
  type InferenceAlias,
  type InferenceCandidate,
  type InferenceFusionDefinition,
  type InferenceResolver,
  type InferenceTarget,
  type InferenceTier,
  inferenceTargetKind,
  resolveAutoTier,
  type SmrtClassOptions,
  type SmrtCollectionOptions,
} from '@happyvertical/smrt-core';
import {
  findFusionDefinitionIssues,
  findFusionDefinitionPromptIssues,
  validateInferenceTarget,
} from '../config.js';
import { InferenceConfigError } from '../errors.js';
import { InferenceOverrideCollection } from '../models/InferenceOverrideCollection.js';
import { getInferenceOverrideGeneration } from './cache.js';
import {
  buildInferenceOverrideLayers,
  type InferenceOverrideRows,
  mergeSettingsConfigs,
  readInferenceOverrideRows,
} from './layers.js';
import type { InferenceTenantTargetPolicy } from './override-service.js';
import { applyStoredTranscriptSettings } from './transcripts.js';

/** Options for {@link createInferenceOverrideResolver}. */
export interface InferenceOverrideResolverOptions {
  /** Database options for the override collection (list bounds are stripped). */
  db?: SmrtClassOptions;
  /** An existing collection instead of `db`. */
  overrides?: InferenceOverrideCollection;
  /** Resolver to defer to for tiers with no stored binding. */
  base?: InferenceResolver;
  /** The code half of the tenant allow-list (same hook as the settings service). */
  tenantTargetPolicy?: InferenceTenantTargetPolicy;
  /**
   * How long a tenant's layers are reused, ms. Default 30 000. Any write in
   * this process invalidates immediately; other processes see it after TTL.
   */
  ttlMs?: number;
}

const MAX_CACHED_TENANTS = 500;

function expandStoredAliases(
  target: InferenceTarget,
  appAliases: Record<string, InferenceAlias>,
  configAliases: Record<string, InferenceAlias>,
): InferenceTarget {
  if (inferenceTargetKind(target) !== 'alias') return target;
  const name = target.alias as string;
  // A config alias the app row does not replace: the executor resolves it.
  if (!Object.hasOwn(appAliases, name)) return target;
  const expand = (alias: string, seen: Set<string>): InferenceCandidate[] => {
    if (seen.has(alias)) return []; // validated cycle-free before this runs
    const next = new Set(seen).add(alias);
    const definition = appAliases[alias] ?? configAliases[alias];
    return (definition?.candidates ?? []).flatMap((candidate) =>
      candidate.alias && Object.hasOwn(appAliases, candidate.alias)
        ? expand(candidate.alias, next)
        : [candidate],
    );
  };
  return { kind: 'candidates', candidates: expand(name, new Set()) };
}

/**
 * A stored fusion's seats with app-only aliases inlined as candidate
 * chains (the executor resolves seat aliases against the process config).
 */
function expandStoredFusionAliases(
  definition: InferenceFusionDefinition,
  appAliases: Record<string, InferenceAlias>,
  configAliases: Record<string, InferenceAlias>,
): InferenceFusionDefinition {
  return {
    ...definition,
    seats: definition.seats.map((seat) =>
      typeof seat.target === 'string'
        ? { ...seat }
        : {
            ...seat,
            target: expandStoredAliases(
              { ...seat.target },
              appAliases,
              configAliases,
            ),
          },
    ),
  };
}

/** See the module doc. */
export function createInferenceOverrideResolver(
  options: InferenceOverrideResolverOptions = {},
): InferenceResolver {
  const ttlMs = options.ttlMs ?? 30_000;
  const cache = new Map<
    string,
    { at: number; generation: number; rows: InferenceOverrideRows }
  >();
  let collection: Promise<InferenceOverrideCollection> | undefined;

  const getCollection = () => {
    if (options.overrides) return Promise.resolve(options.overrides);
    collection ??= InferenceOverrideCollection.create({
      ...(options.db ?? {}),
      defaultListLimit: undefined,
      maxListLimit: undefined,
    } as SmrtCollectionOptions) as Promise<InferenceOverrideCollection>;
    return collection;
  };

  // Rows are cached, never layers: the allow-list and the policy hook are
  // applied again on every resolution, so narrowing the policy takes effect
  // on the next call without an override write.
  const rowsFor = async (tenantId: string | null) => {
    const key = tenantId ?? '';
    const generation = getInferenceOverrideGeneration();
    const hit = cache.get(key);
    if (hit && hit.generation === generation && Date.now() - hit.at < ttlMs) {
      return hit.rows;
    }
    const rows = await readInferenceOverrideRows(
      await getCollection(),
      tenantId,
    );
    cache.delete(key);
    cache.set(key, { at: Date.now(), generation, rows });
    if (cache.size > MAX_CACHED_TENANTS) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return rows;
  };

  return {
    async resolve(request, context) {
      const tenantId =
        typeof request.tenantId === 'string' && request.tenantId
          ? request.tenantId
          : null;
      const rows = await rowsFor(tenantId);
      // The app's transcript setting (#4781) rides on the same rows: keep
      // core's app settings layer current in this process.
      applyStoredTranscriptSettings(rows.appRows);
      const layers = await buildInferenceOverrideLayers(
        rows,
        options.tenantTargetPolicy,
      );
      const merged = mergeSettingsConfigs(
        context.config,
        layers.app,
        layers.tenant,
      );
      const tier: InferenceTier =
        request.tier === 'auto' ? resolveAutoTier(merged) : request.tier;
      const stored = layers.tenant.tiers?.[tier] ?? layers.app.tiers?.[tier];
      if (!stored) {
        const next = { ...request, tier };
        const deferred = options.base
          ? await options.base.resolve(next, context)
          : undefined;
        if (deferred !== undefined) return deferred;
        // `auto` may move to a stored default tier; resolve that tier from
        // config so the caller still sees the concrete tier.
        return request.tier === 'auto'
          ? context.resolveFromConfig(next)
          : undefined;
      }
      // Only the requested tier's chain is checked: a dangling reference
      // elsewhere fails that binding, not every stored tier.
      validateInferenceTarget(stored, `inference.tiers.${tier}`, merged);
      return {
        tierResolved: tier,
        target: expandStoredAliases(
          { ...stored },
          (layers.app.aliases ?? {}) as Record<string, InferenceAlias>,
          (context.config?.aliases ?? {}) as Record<string, InferenceAlias>,
        ),
        via: 'resolver',
      };
    },

    async lookupFusion(key, request, context) {
      // App scope only: the rows are read with no tenant, so a tenant row
      // (refused on write, but possible from a foreign writer) can never
      // define or redefine a fusion.
      const app = (await buildInferenceOverrideLayers(await rowsFor(null))).app;
      const stored = Object.hasOwn(app.fusions ?? {}, key)
        ? app.fusions?.[key]
        : undefined;
      if (!stored) {
        return options.base?.lookupFusion
          ? options.base.lookupFusion(key, request, context)
          : undefined;
      }
      const merged = mergeSettingsConfigs(context.config, app);
      const path = `fusion:${key}`;
      const issues = [
        ...findFusionDefinitionIssues(stored, path, merged),
        ...findFusionDefinitionPromptIssues(stored, path),
      ];
      if (issues.length > 0) throw new InferenceConfigError(issues);
      return expandStoredFusionAliases(
        stored,
        (app.aliases ?? {}) as Record<string, InferenceAlias>,
        (context.config?.aliases ?? {}) as Record<string, InferenceAlias>,
      );
    },
  };
}
