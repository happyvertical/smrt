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
  onStepFailure: false,
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

/**
 * `<package>:<Class>` — the same qualified form STI discriminators and
 * `@crossPackageRef` use. Both halves are required and neither may be padded.
 */
const QUALIFIED_MODEL_PATTERN = /^\S+:\S+$/;

/** Frozen so a definition's default plane list can never be mutated in place. */
const BROWSER_ONLY_PLANES: readonly PlaybookPlane[] = Object.freeze([
  'browser',
]);

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeEditableConfig(
  editable?: Partial<PlaybookEditableConfig>,
): PlaybookEditableConfig {
  const flag = (name: keyof PlaybookEditableConfig): boolean => {
    const supplied = editable?.[name];
    if (supplied === undefined) {
      return DEFAULT_EDITABLE[name];
    }

    // Only a real `true` unlocks a field. A truthy non-boolean such as
    // `'false'` would otherwise read as an explicit opt-in and open a stored
    // override the definition never meant to allow.
    if (typeof supplied !== 'boolean') {
      throw new Error(
        `Playbook editable.${name} must be a boolean, received ${typeof supplied} "${String(supplied)}"`,
      );
    }

    return supplied;
  };

  return {
    title: flag('title'),
    description: flag('description'),
    planes: flag('planes'),
    onStepFailure: flag('onStepFailure'),
    enabled: flag('enabled'),
    metadata: flag('metadata'),
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

/**
 * Enablement is a gate, so it is validated rather than coerced. Truthiness
 * would silently read a config or runtime `"false"` as enabled — the one
 * coercion failure here that fails open.
 */
function normalizeEnabled(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(
      `${context} enabled must be a boolean, received ${typeof value} "${String(value)}"`,
    );
  }

  return value;
}

/**
 * Validated, not coerced, for the same reason as {@link normalizeEnabled}: a
 * stringly-typed `"false"` would turn a required step into a skippable one.
 */
function normalizeStepOptional(value: unknown, context: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(
      `${context} optional must be a boolean, received ${typeof value} "${String(value)}"`,
    );
  }

  return value;
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

        // Both halves must be present and unpadded: ':', '@pkg:', and ':Order'
        // all contain a separator but identify no model, and would resolve
        // into a plan that no classifier or executor lookup can ever match.
        if (!QUALIFIED_MODEL_PATTERN.test(model)) {
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
            : {
                optional: normalizeStepOptional(rawStep.optional, stepContext),
              }),
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
            : {
                optional: normalizeStepOptional(rawStep.optional, stepContext),
              }),
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
  return hasIntentStep(steps) ? BROWSER_ONLY_PLANES : PLAYBOOK_PLANES;
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

  // Freeze the nested values too, not just the outer object: `planes` and
  // `editable` are the declared fail-closed policy, and a shallow freeze would
  // still let a caller push 'server' onto a browser-only definition or flip an
  // `editable` flag on the object the registry hands back.
  return Object.freeze({
    key: input.key,
    title: input.title,
    description: input.description,
    steps,
    planes: Object.freeze(declaredPlanes ?? defaultPlanesForSteps(steps)),
    onStepFailure:
      input.onStepFailure === undefined
        ? 'abort'
        : normalizeFailurePolicy(input.onStepFailure, context),
    enabled:
      input.enabled === undefined
        ? true
        : normalizeEnabled(input.enabled, context),
    metadata: Object.freeze(
      input.metadata ? sanitizeMetadata(input.metadata) : {},
    ),
    editable: Object.freeze(normalizeEditableConfig(input.editable)),
  });
}

export function sanitizeMetadata(
  metadata: PlaybookMetadata | null | undefined,
): PlaybookMetadata {
  if (!isPlainObject(metadata)) {
    return {};
  }

  // Copy and deep-freeze rather than aliasing the caller's object: metadata
  // ends up in the registered definition and the shared cache entry, and a
  // shallow freeze would leave nested values mutable through the caller's
  // original reference.
  return deepFreezeJsonObject(metadata);
}

function deepFreezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreezeJsonValue));
  }

  if (isPlainObject(value)) {
    return deepFreezeJsonObject(value);
  }

  return value;
}

function deepFreezeJsonObject(
  source: Record<string, unknown>,
): PlaybookMetadata {
  const copied: PlaybookMetadata = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) {
      continue;
    }
    copied[key] = deepFreezeJsonValue(value);
  }

  return Object.freeze(copied);
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
    layer.enabled =
      input.enabled === null ? null : normalizeEnabled(input.enabled, context);
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

  // The merged result is both cached and handed to callers as part of the
  // plan, so the policy values must be immutable: a caller pushing onto a
  // narrowed `planes` array would otherwise corrupt the cached entry and widen
  // the declared-plane gate for every resolution until the TTL expires.
  return Object.freeze({
    title,
    description,
    planes: Object.freeze(planes),
    onStepFailure,
    enabled,
    metadata: Object.freeze(metadata),
  });
}
