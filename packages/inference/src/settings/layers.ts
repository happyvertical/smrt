/**
 * Layered read of `_smrt_inference_overrides` (#4754): the code default
 * (core's built-in resolution), the `inference` config, the app row, then
 * the tenant row, as in smrt-prompts. A tenant row takes effect only while
 * the app row's allow-list and the policy hook still allow it.
 */
import {
  type InferenceAlias,
  type InferenceConfig,
  type InferenceFusionDefinition,
  type InferenceTarget,
  type InferenceTier,
  type InferenceTranscriptsConfig,
  mergeInferenceConfigs,
} from '@happyvertical/smrt-core';
import {
  APP_INFERENCE_SCOPE_ID,
  type InferenceOverride,
} from '../models/InferenceOverride.js';
import type { InferenceOverrideCollection } from '../models/InferenceOverrideCollection.js';
import {
  type InferenceTenantTargetPolicy,
  isTenantValueAllowed,
} from './override-service.js';
import { parseInferenceBinding } from './targets.js';

/**
 * The settings layers' config shape: core's `InferenceConfig`, whose
 * `fusions` member is #4753's typed `InferenceFusionDefinition` map.
 */
export type InferenceSettingsConfig = InferenceConfig;

/** The stored layers, each as an `InferenceConfig` fragment. */
export interface InferenceOverrideLayers {
  app: InferenceSettingsConfig;
  tenant: InferenceSettingsConfig;
  /** Tenant bindings present but refused by the allow-list or policy at read time. */
  blockedTenantBindings: string[];
  /** Raw rows, for screens that show each scope. */
  appRows: Map<string, InferenceOverride>;
  tenantRows: Map<string, InferenceOverride>;
}

/**
 * Merge config layers, lowest first. Core's merge (#4753) already replaces
 * `fusions` whole per name, so this is `mergeInferenceConfigs()`.
 */
export function mergeSettingsConfigs(
  ...layers: Array<InferenceSettingsConfig | undefined | null>
): InferenceSettingsConfig | undefined {
  return mergeInferenceConfigs(...layers);
}

function layerFromRows(
  rows: Map<string, InferenceOverride>,
  include: (binding: string) => boolean,
): InferenceSettingsConfig {
  const layer: InferenceSettingsConfig = {};
  for (const [binding, row] of rows) {
    if (!include(binding)) continue;
    const parsed = parseInferenceBinding(binding);
    if (!parsed) continue;
    let value: unknown;
    try {
      value = row.getValue();
    } catch {
      // A row written by an older or foreign writer that no longer validates
      // never takes effect; the settings screen shows it as raw state.
      continue;
    }
    if (value === null) continue;
    switch (parsed.kind) {
      case 'tier':
        layer.tiers ??= {};
        layer.tiers[parsed.name as InferenceTier] = value as InferenceTarget;
        break;
      case 'default-tier':
        layer.defaultTier = value as InferenceTier;
        break;
      case 'transcripts':
        // App rows only: the tenant layer keeps tier and default-tier rows.
        layer.transcripts = value as InferenceTranscriptsConfig;
        break;
      case 'alias':
        layer.aliases ??= {};
        layer.aliases[parsed.name as string] = value as InferenceAlias;
        break;
      case 'fusion':
        layer.fusions ??= {};
        layer.fusions[parsed.name as string] =
          value as InferenceFusionDefinition;
        break;
    }
  }
  return layer;
}

/** The raw rows of the app scope and (with a tenant) one tenant scope. */
export interface InferenceOverrideRows {
  tenantId: string | null;
  appRows: Map<string, InferenceOverride>;
  tenantRows: Map<string, InferenceOverride>;
}

/** Two bounded reads: the app scope and, with `tenantId`, that tenant's. */
export async function readInferenceOverrideRows(
  overrides: InferenceOverrideCollection,
  tenantId: string | null | undefined,
): Promise<InferenceOverrideRows> {
  const tenant = tenantId ?? null;
  const [appRows, tenantRows] = await Promise.all([
    overrides.getScopeMap('app', APP_INFERENCE_SCOPE_ID),
    tenant
      ? overrides.getScopeMap('tenant', tenant)
      : Promise.resolve(new Map<string, InferenceOverride>()),
  ]);
  return { tenantId: tenant, appRows, tenantRows };
}

/**
 * Read the app layer and (with `tenantId`) the tenant layer; the tenant
 * layer keeps only tier and default-tier rows the allow-list and policy
 * still allow.
 */
export async function loadInferenceOverrideLayers(
  overrides: InferenceOverrideCollection,
  options: {
    tenantId?: string | null;
    tenantTargetPolicy?: InferenceTenantTargetPolicy;
  } = {},
): Promise<InferenceOverrideLayers> {
  return buildInferenceOverrideLayers(
    await readInferenceOverrideRows(overrides, options.tenantId),
    options.tenantTargetPolicy,
  );
}

/**
 * Layers from rows already read. Applies the allow-list and the policy hook
 * now, so a caller that caches rows (the override resolver) still re-checks
 * the current policy on every use.
 */
export async function buildInferenceOverrideLayers(
  rows: InferenceOverrideRows,
  tenantTargetPolicy?: InferenceTenantTargetPolicy,
): Promise<InferenceOverrideLayers> {
  const { tenantId, appRows, tenantRows } = rows;
  const options = { tenantTargetPolicy };
  const app = layerFromRows(appRows, () => true);
  const blocked: string[] = [];
  const allowedTenant = new Set<string>();
  if (tenantId) {
    for (const [binding, row] of tenantRows) {
      const parsed = parseInferenceBinding(binding);
      if (parsed?.kind !== 'tier' && parsed?.kind !== 'default-tier') continue;
      let value: unknown;
      try {
        value = row.getValue();
      } catch {
        continue;
      }
      if (value === null) continue;
      let allowList: string[] | null = null;
      try {
        allowList = appRows.get(binding)?.getTenantAllowList() ?? null;
      } catch {
        allowList = null;
      }
      if (
        await isTenantValueAllowed(
          binding,
          value,
          tenantId,
          allowList,
          options.tenantTargetPolicy,
        )
      ) {
        allowedTenant.add(binding);
      } else {
        blocked.push(binding);
      }
    }
  }
  const tenant = layerFromRows(tenantRows, (binding) =>
    allowedTenant.has(binding),
  );
  return {
    app,
    tenant,
    blockedTenantBindings: blocked.sort(),
    appRows,
    tenantRows,
  };
}
