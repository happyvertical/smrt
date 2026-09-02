import { getPackageConfig } from '@happyvertical/smrt-config';
import { getTenantId } from '@happyvertical/smrt-tenancy';
import { getCachedPlaybookBase, setCachedPlaybookBase } from './cache.js';
import { PlaybookOverrideCollection } from './collections/PlaybookOverrideCollection.js';
import { PlaybookRegistry } from './playbook-registry.js';
import type {
  PlaybookCacheValue,
  PlaybookDefinition,
  PlaybookPackageConfig,
  PlaybookPlan,
  PlaybookPlanStep,
  PlaybookRejection,
  PlaybookResolution,
  ResolvePlaybookOptions,
} from './types.js';
import {
  applyCapabilityDeclaration,
  isCapabilityDeclarationComplete,
  mergePlaybookLayers,
  normalizePlaybookLayer,
} from './utils.js';

function getPlaybookConfig(): PlaybookPackageConfig {
  return getPackageConfig<PlaybookPackageConfig>('playbooks', {
    playbooks: {},
  });
}

function reject(
  key: string,
  reason: PlaybookRejection['reason'],
  message: string,
  stepIndex?: number,
): PlaybookRejection {
  return {
    ok: false,
    reason,
    message,
    key,
    ...(stepIndex === undefined ? {} : { stepIndex }),
  };
}

async function loadPlaybookBase(
  definition: PlaybookDefinition,
  options: ResolvePlaybookOptions,
): Promise<PlaybookCacheValue> {
  const key = definition.key;
  const tenantId =
    options.tenantId !== undefined ? options.tenantId : (getTenantId() ?? null);

  let collection: PlaybookOverrideCollection | null = null;
  let cacheDb: ResolvePlaybookOptions['db'] | undefined = options.db;
  if (options.db) {
    const initializedCollection = await PlaybookOverrideCollection.create({
      db: options.db,
    });
    collection = initializedCollection;
    cacheDb = initializedCollection.db as ResolvePlaybookOptions['db'];
  }

  const cached = getCachedPlaybookBase(key, tenantId, cacheDb);
  if (cached) {
    return cached;
  }

  const config = getPlaybookConfig();
  const layers = [
    normalizePlaybookLayer(
      config.playbooks?.[key],
      `Playbook "${key}" config override`,
    ),
  ];

  if (collection) {
    const stored = await collection.getResolutionLayers(key, tenantId);

    if (stored.app) {
      layers.push(stored.app.toPlaybookLayer());
    }

    if (stored.tenant) {
      layers.push(stored.tenant.toPlaybookLayer());
    }
  }

  const merged = mergePlaybookLayers(definition, ...layers);
  const value: PlaybookCacheValue = {
    key,
    title: merged.title,
    description: merged.description,
    planes: merged.planes,
    onStepFailure: merged.onStepFailure,
    enabled: merged.enabled,
    metadata: merged.metadata,
  };

  setCachedPlaybookBase(key, tenantId, cacheDb, value);
  return value;
}

/**
 * Resolves a playbook to a plan for a caller on a given plane.
 *
 * Returns a discriminated result rather than throwing: resolution fails closed
 * and every rejection names a specific reason. Nothing here executes a step —
 * the plan is followed step by step by the agent, and each step is authorized
 * independently at the REST boundary or by `PrincipalRun.assertToolAllowed()`.
 */
export async function resolvePlaybook(
  key: string,
  options: ResolvePlaybookOptions = {},
): Promise<PlaybookResolution> {
  const definition = PlaybookRegistry.get(key);
  if (!definition) {
    return reject(key, 'unknown-playbook', `Unknown playbook key "${key}"`);
  }

  const base = await loadPlaybookBase(definition, options);
  const runtimeOverride = normalizePlaybookLayer(
    options.override,
    `Playbook "${key}" runtime override`,
  );
  const merged = mergePlaybookLayers(
    {
      ...definition,
      title: base.title,
      description: base.description,
      planes: base.planes,
      onStepFailure: base.onStepFailure,
      enabled: base.enabled,
      metadata: base.metadata,
    },
    runtimeOverride,
  );

  if (!merged.enabled) {
    return reject(
      key,
      'disabled',
      `Playbook "${key}" is disabled for this scope`,
    );
  }

  const plane = options.plane ?? 'server';
  if (!merged.planes.includes(plane)) {
    return reject(
      key,
      'plane-not-declared',
      `Playbook "${key}" is not valid on the "${plane}" plane; it declares ${merged.planes.join(', ')}`,
    );
  }

  const steps: PlaybookPlanStep[] = [];

  for (const [index, step] of definition.steps.entries()) {
    if (step.kind === 'operation') {
      // The step never classifies itself: the host supplies the classification
      // emitted for the referenced operation, and anything undeclared resolves
      // to the fail-closed default.
      const declaration = options.classifier?.(step) ?? null;
      steps.push({
        index,
        step,
        classification: applyCapabilityDeclaration(declaration),
        classificationDeclared: isCapabilityDeclarationComplete(declaration),
      });
      continue;
    }

    // Seam for #2588: without a declared-intent registry there is no identity
    // to resolve against, so an intent step fails closed rather than being
    // assumed valid.
    if (!options.intents) {
      return reject(
        key,
        'intent-registry-unavailable',
        `Playbook "${key}" step ${index} references view intent "${step.id}", but no intent registry was supplied (see #2588)`,
        index,
      );
    }

    const record = options.intents(step.id);
    if (!record) {
      return reject(
        key,
        'unknown-intent',
        `Playbook "${key}" step ${index} references unknown view intent "${step.id}"`,
        index,
      );
    }

    if (record.planes && !record.planes.includes(plane)) {
      return reject(
        key,
        'intent-plane-not-declared',
        `Playbook "${key}" step ${index} references view intent "${step.id}", which is not valid on the "${plane}" plane`,
        index,
      );
    }

    steps.push({
      index,
      step,
      classification: applyCapabilityDeclaration(record.classification),
      classificationDeclared: isCapabilityDeclarationComplete(
        record.classification,
      ),
    });
  }

  const plan: PlaybookPlan = {
    key,
    title: merged.title,
    description: merged.description,
    plane,
    planes: merged.planes,
    onStepFailure: merged.onStepFailure,
    metadata: merged.metadata,
    // Steps come from the code definition alone. No layer can supply them.
    steps,
  };

  return { ok: true, plan };
}
