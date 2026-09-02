import type {
  CapabilityClassification,
  CapabilityDeclaration,
} from '@happyvertical/smrt-types';
import {
  PLAYBOOK_PLANES,
  type PlaybookConfigOverrideInput,
  type PlaybookDefinition,
  type PlaybookDefinitionInput,
  type PlaybookEditableConfig,
  type PlaybookFailurePolicy,
  type PlaybookLayer,
  type PlaybookMetadata,
  type PlaybookPlane,
  type PlaybookStep,
} from './types.js';

/**
 * Every field defaults to non-editable, matching `normalizeEditableConfig` in
 * `@happyvertical/smrt-prompts`. `steps` is not in this table at all — it is
 * structurally non-editable rather than defaulted false.
 */
const DEFAULT_EDITABLE: PlaybookEditableConfig = {
  title: false,
  description: false,
  planes: false,
  enabled: false,
  metadata: false,
};

/**
 * Fail-closed capability classification, per epic #2585 invariant 3. Applied
 * whenever the host cannot tell us how a referenced operation is classified.
 */
export const FAIL_CLOSED_CLASSIFICATION: CapabilityClassification = {
  effect: 'destructive',
  idempotent: false,
  openWorld: true,
};

const FAILURE_POLICIES = new Set<PlaybookFailurePolicy>(['abort', 'continue']);

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeEditableConfig(
  editable?: Partial<PlaybookEditableConfig>,
): PlaybookEditableConfig {
  return {
    title: editable?.title ?? DEFAULT_EDITABLE.title,
    description: editable?.description ?? DEFAULT_EDITABLE.description,
    planes: editable?.planes ?? DEFAULT_EDITABLE.planes,
    enabled: editable?.enabled ?? DEFAULT_EDITABLE.enabled,
    metadata: editable?.metadata ?? DEFAULT_EDITABLE.metadata,
  };
}

/**
 * Applies a partial capability declaration over the fail-closed default.
 *
 * A playbook step never classifies itself: this only fills the gaps left by a
 * declaration that the host inherited from the referenced operation.
 */
export function applyCapabilityDeclaration(
  declaration?: CapabilityDeclaration | null,
): CapabilityClassification {
  if (!isPlainObject(declaration)) {
    return { ...FAIL_CLOSED_CLASSIFICATION };
  }

  return {
    effect: declaration.effect ?? FAIL_CLOSED_CLASSIFICATION.effect,
    idempotent: declaration.idempotent ?? FAIL_CLOSED_CLASSIFICATION.idempotent,
    openWorld: declaration.openWorld ?? FAIL_CLOSED_CLASSIFICATION.openWorld,
  };
}

export function isCapabilityDeclarationComplete(
  declaration?: CapabilityDeclaration | null,
): boolean {
  return (
    isPlainObject(declaration) &&
    declaration.effect !== undefined &&
    declaration.idempotent !== undefined &&
    declaration.openWorld !== undefined
  );
}

export function normalizePlanes(
  planes: readonly PlaybookPlane[] | null | undefined,
  context: string,
): readonly PlaybookPlane[] | undefined {
  if (planes === undefined) {
    return undefined;
  }

  if (planes === null) {
    return undefined;
  }

  if (!Array.isArray(planes)) {
    throw new Error(`${context} planes must be an array`);
  }

  const normalized: PlaybookPlane[] = [];
  for (const plane of planes) {
    if (!PLAYBOOK_PLANES.includes(plane)) {
      throw new Error(
        `${context} declares unknown plane "${String(plane)}"; expected one of ${PLAYBOOK_PLANES.join(', ')}`,
      );
    }
    if (!normalized.includes(plane)) {
      normalized.push(plane);
    }
  }

  if (normalized.length === 0) {
    throw new Error(`${context} must declare at least one plane`);
  }

  // Stable order keeps stored/serialized planes comparable.
  return PLAYBOOK_PLANES.filter((plane) => normalized.includes(plane));
}

function normalizeFailurePolicy(
  value: unknown,
  context: string,
): PlaybookFailurePolicy {
  if (!FAILURE_POLICIES.has(value as PlaybookFailurePolicy)) {
    throw new Error(
      `${context} onStepFailure must be "abort" or "continue", received "${String(value)}"`,
    );
  }

  return value as PlaybookFailurePolicy;
}

function normalizeOptionalText(
  value: unknown,
  context: string,
  field: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${context} ${field} must be a string`);
  }

  return value;
}

/**
 * Validates and freezes the declared step list.
 *
 * Rejects nested playbooks at definition time (epic #2585): a package playbook
 * referencing a tenant-overridden playbook is the description-behavior
 * mismatch one level removed.
 */
export function normalizeSteps(
  steps: readonly PlaybookStep[] | undefined,
  context: string,
): readonly PlaybookStep[] {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${context} requires at least one step`);
  }

  return Object.freeze(
    steps.map((rawStep, index) => {
      const stepContext = `${context} step ${index}`;

      if (!isPlainObject(rawStep)) {
        throw new Error(`${stepContext} must be an object`);
      }

      const kind = rawStep.kind;

      if (kind === 'playbook' || 'playbook' in rawStep) {
        throw new Error(
          `${stepContext} references another playbook; nested playbooks are not supported`,
        );
      }

      if (kind === 'operation') {
        const model = rawStep.model;
        const action = rawStep.action;

        if (typeof model !== 'string' || model.trim() === '') {
          throw new Error(`${stepContext} requires a qualified model name`);
        }

        if (!model.includes(':')) {
          throw new Error(
            `${stepContext} model "${model}" must be a qualified pair such as "@happyvertical/smrt-commerce:Order"`,
          );
        }

        if (typeof action !== 'string' || action.trim() === '') {
          throw new Error(`${stepContext} requires an action name`);
        }

        return Object.freeze({
          kind: 'operation' as const,
          model,
          action,
          ...(normalizeOptionalText(rawStep.label, stepContext, 'label') !==
          undefined
            ? { label: rawStep.label as string }
            : {}),
          ...(normalizeOptionalText(
            rawStep.description,
            stepContext,
            'description',
          ) !== undefined
            ? { description: rawStep.description as string }
            : {}),
          ...(rawStep.optional === undefined
            ? {}
            : { optional: Boolean(rawStep.optional) }),
        }) satisfies PlaybookStep;
      }

      if (kind === 'intent') {
        const id = rawStep.id;

        if (typeof id !== 'string' || id.trim() === '') {
          throw new Error(`${stepContext} requires an intent id`);
        }

        return Object.freeze({
          kind: 'intent' as const,
          id,
          ...(normalizeOptionalText(rawStep.label, stepContext, 'label') !==
          undefined
            ? { label: rawStep.label as string }
            : {}),
          ...(normalizeOptionalText(
            rawStep.description,
            stepContext,
            'description',
          ) !== undefined
            ? { description: rawStep.description as string }
            : {}),
          ...(rawStep.optional === undefined
            ? {}
            : { optional: Boolean(rawStep.optional) }),
        }) satisfies PlaybookStep;
      }

      throw new Error(
        `${stepContext} has unknown kind "${String(kind)}"; expected "operation" or "intent"`,
      );
    }),
  );
}

export function hasIntentStep(steps: readonly PlaybookStep[]): boolean {
  return steps.some((step) => step.kind === 'intent');
}

/**
 * Default plane validity. Operation-only playbooks are valid on both planes;
 * anything containing a view intent is browser-valid only until the author
 * explicitly declares server validity through the #2446 command/ack bridge.
 */
export function defaultPlanesForSteps(
  steps: readonly PlaybookStep[],
): readonly PlaybookPlane[] {
  return hasIntentStep(steps) ? (['browser'] as const) : PLAYBOOK_PLANES;
}

export function normalizePlaybookDefinitionInput(
  input: PlaybookDefinitionInput,
): PlaybookDefinition {
  if (!input || typeof input.key !== 'string' || input.key.trim() === '') {
    throw new Error('Playbook definitions require a non-empty key');
  }

  const context = `Playbook "${input.key}"`;

  if (typeof input.title !== 'string' || input.title.trim() === '') {
    throw new Error(`${context} requires a title`);
  }

  if (
    typeof input.description !== 'string' ||
    input.description.trim() === ''
  ) {
    throw new Error(`${context} requires a description`);
  }

  if ('steps' in ((input.editable ?? {}) as Record<string, unknown>)) {
    throw new Error(
      `${context} cannot mark steps editable; playbook step lists are never editable`,
    );
  }

  const steps = normalizeSteps(input.steps, context);
  const declaredPlanes = normalizePlanes(input.planes, context);

  return Object.freeze({
    key: input.key,
    title: input.title,
    description: input.description,
    steps,
    planes: declaredPlanes ?? defaultPlanesForSteps(steps),
    onStepFailure:
      input.onStepFailure === undefined
        ? 'abort'
        : normalizeFailurePolicy(input.onStepFailure, context),
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    metadata: input.metadata ? sanitizeMetadata(input.metadata) : {},
    editable: normalizeEditableConfig(input.editable),
  });
}

export function sanitizeMetadata(
  metadata: PlaybookMetadata | null | undefined,
): PlaybookMetadata {
  if (!isPlainObject(metadata)) {
    return {};
  }

  const sanitized: PlaybookMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value === undefined) {
      continue;
    }
    sanitized[key] = value;
  }

  return sanitized;
}

export function parseMetadata(
  raw: string | null | undefined,
): PlaybookMetadata {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? sanitizeMetadata(parsed) : {};
  } catch {
    return {};
  }
}

export function serializeMetadata(
  metadata: PlaybookMetadata | null | undefined,
): string | null {
  if (metadata === null || metadata === undefined) {
    return null;
  }

  return JSON.stringify(sanitizeMetadata(metadata));
}

export function parsePlanes(
  raw: string | null | undefined,
): readonly PlaybookPlane[] | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return (
      normalizePlanes(parsed as PlaybookPlane[], 'Stored override') ?? null
    );
  } catch {
    return null;
  }
}

export function serializePlanes(
  planes: readonly PlaybookPlane[] | null | undefined,
): string | null {
  if (planes === null || planes === undefined) {
    return null;
  }

  return JSON.stringify(normalizePlanes(planes, 'Stored override') ?? []);
}

/**
 * Normalizes an override layer from config, storage, or a runtime call.
 *
 * A `steps` key is rejected rather than dropped: "a tenant override cannot
 * alter steps through any path" is enforced loudly at every entry point.
 */
export function normalizePlaybookLayer(
  input?: PlaybookConfigOverrideInput | null,
  context = 'Playbook override',
): PlaybookLayer {
  if (!isPlainObject(input)) {
    return {};
  }

  if ('steps' in input) {
    throw new Error(
      `${context} cannot set steps; playbook step lists are never editable`,
    );
  }

  const layer: PlaybookLayer = {};

  if (input.title !== undefined) {
    layer.title =
      input.title === null
        ? null
        : (normalizeOptionalText(input.title, context, 'title') ?? null);
  }

  if (input.description !== undefined) {
    layer.description =
      input.description === null
        ? null
        : (normalizeOptionalText(input.description, context, 'description') ??
          null);
  }

  if (input.planes !== undefined) {
    layer.planes =
      input.planes === null
        ? null
        : (normalizePlanes(input.planes, context) ?? null);
  }

  if (input.onStepFailure !== undefined) {
    layer.onStepFailure =
      input.onStepFailure === null
        ? null
        : normalizeFailurePolicy(input.onStepFailure, context);
  }

  if (input.enabled !== undefined) {
    layer.enabled = input.enabled === null ? null : Boolean(input.enabled);
  }

  if (input.metadata !== undefined) {
    layer.metadata =
      input.metadata === null ? null : sanitizeMetadata(input.metadata);
  }

  return layer;
}

export interface MergedPlaybookLayers {
  title: string;
  description: string;
  planes: readonly PlaybookPlane[];
  onStepFailure: PlaybookFailurePolicy;
  enabled: boolean;
  metadata: PlaybookMetadata;
}

/**
 * Merges layers low → high, field by field.
 *
 * Enablement is one-directional: once any layer disables a playbook, no
 * higher layer can enable it again. A tenant may narrow, never widen.
 */
export function mergePlaybookLayers(
  base: PlaybookDefinition,
  ...layers: Array<PlaybookLayer | null | undefined>
): MergedPlaybookLayers {
  let title = base.title;
  let description = base.description;
  let planes = base.planes;
  let onStepFailure = base.onStepFailure;
  let enabled = base.enabled;
  let metadata: PlaybookMetadata = { ...base.metadata };

  for (const layer of layers) {
    if (!layer) {
      continue;
    }

    if (layer.title !== undefined && layer.title !== null) {
      title = layer.title;
    }

    if (layer.description !== undefined && layer.description !== null) {
      description = layer.description;
    }

    if (layer.planes !== undefined && layer.planes !== null) {
      // Plane validity only ever narrows: an override cannot claim a plane the
      // lower layers never declared.
      planes = layer.planes.filter((plane) => planes.includes(plane));
    }

    if (layer.onStepFailure !== undefined && layer.onStepFailure !== null) {
      onStepFailure = layer.onStepFailure;
    }

    if (layer.enabled !== undefined && layer.enabled !== null) {
      enabled = enabled && layer.enabled;
    }

    if (layer.metadata !== undefined && layer.metadata !== null) {
      metadata = { ...metadata, ...layer.metadata };
    }
  }

  return {
    title,
    description,
    planes,
    onStepFailure,
    enabled,
    metadata,
  };
}
