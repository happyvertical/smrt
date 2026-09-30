/**
 * Form-level proposals over a control interaction registry.
 *
 * Transport-neutral helpers for "propose values for this form" adapters (the
 * rich smrt-svelte `<Form webmcp>` tool, `FormScope`, a chat or voice
 * adapter). They read whatever the registry holds for one `formId` — every
 * smrt-ui primitive (`Input`, `Select`, `Textarea`, `Combobox`, …) and every
 * composite registered through `useControlRegistration` — and only ever STAGE
 * values: a person applies them through `StagedControlReview`.
 */

import type {
  ControlCommand,
  ControlCommandResult,
  ControlCommandSource,
  ControlInteractionRegistry,
  ControlSnapshot,
} from './control-interaction.js';

/** Tool-safe name (`[a-z0-9_]`) for a form's proposal tool. */
export function controlProposalToolName(formId: string): string {
  const base = formId
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `${base || 'form'}_stage_changes`;
}

/**
 * Whether a control can take a proposal at all: never secret or sensitive,
 * never declared unwritable, disabled, or read-only, and never a file or
 * password (neither is representable as a proposed JSON value).
 */
export function isControlProposable(snapshot: ControlSnapshot): boolean {
  const { metadata, state } = snapshot;
  if (metadata.sensitivity === 'secret' || metadata.sensitivity === 'sensitive')
    return false;
  if (metadata.writable === false) return false;
  if (metadata.kind === 'file' || metadata.kind === 'password') return false;
  if (state.disabled || state.readonly) return false;
  return true;
}

function numericConstraint(value: number | string | undefined) {
  if (value === undefined || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

/** JSON Schema for one control's proposed value. */
export function controlProposalSchema(
  snapshot: ControlSnapshot,
): Record<string, unknown> {
  const { metadata } = snapshot;
  const constraints = metadata.constraints ?? {};
  const optionValues = metadata.options?.map((option) => option.value);
  let schema: Record<string, unknown>;
  if (metadata.valueSchema) {
    schema = { ...metadata.valueSchema };
  } else {
    switch (metadata.kind) {
      case 'number':
      case 'slider': {
        schema = { type: 'number' };
        const minimum = numericConstraint(constraints.min);
        const maximum = numericConstraint(constraints.max);
        if (minimum !== undefined) schema.minimum = minimum;
        if (maximum !== undefined) schema.maximum = maximum;
        break;
      }
      case 'checkbox':
      case 'switch':
      case 'toggle-button':
        schema = { type: 'boolean' };
        break;
      case 'multi-select':
      case 'tags-input':
        schema = {
          type: 'array',
          items: optionValues?.length
            ? { enum: optionValues }
            : { type: 'string' },
        };
        break;
      case 'range-slider':
        schema = {
          type: 'array',
          items: { type: 'number' },
          minItems: 2,
          maxItems: 2,
        };
        break;
      case 'custom':
        // A composite without a declared valueSchema: describe, don't guess.
        schema = {};
        break;
      default:
        schema = { type: 'string' };
        if (
          typeof constraints.minLength === 'number' &&
          constraints.minLength > 0
        )
          schema.minLength = constraints.minLength;
        if (
          typeof constraints.maxLength === 'number' &&
          constraints.maxLength > 0
        )
          schema.maxLength = constraints.maxLength;
        if (optionValues?.length) schema.enum = optionValues;
    }
  }
  if (metadata.label) schema.title = metadata.label;
  if (metadata.description) schema.description = metadata.description;
  return schema;
}

export interface ControlProposalOptions {
  /** Control ids another source already describes (skipped here). */
  exclude?: Iterable<string>;
}

/**
 * The proposable controls of one form, keyed by control id. A
 * record-qualified control (subject) shares its controlId with its siblings;
 * the first registered wins so the schema key stays unambiguous.
 */
export function proposableControls(
  registry: ControlInteractionRegistry,
  formId: string,
  options: ControlProposalOptions = {},
): Map<string, ControlSnapshot> {
  const excluded = new Set(options.exclude ?? []);
  const controls = new Map<string, ControlSnapshot>();
  for (const snapshot of registry.list(formId)) {
    const { controlId } = snapshot.identity;
    if (snapshot.identity.formId !== formId || excluded.has(controlId))
      continue;
    if (!isControlProposable(snapshot) || controls.has(controlId)) continue;
    controls.set(controlId, snapshot);
  }
  return controls;
}

/** `{ controlId: schema }` for every proposable control of a form. */
export function controlProposalProperties(
  registry: ControlInteractionRegistry,
  formId: string,
  options: ControlProposalOptions = {},
): Record<string, Record<string, unknown>> {
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [controlId, snapshot] of proposableControls(
    registry,
    formId,
    options,
  )) {
    properties[controlId] = controlProposalSchema(snapshot);
  }
  return properties;
}

/** Object schema with one optional property per proposable control. */
export function controlProposalInputSchema(
  registry: ControlInteractionRegistry,
  formId: string,
  options: ControlProposalOptions = {},
): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: controlProposalProperties(registry, formId, options),
  };
}

export interface StageControlProposalsResult {
  ok: boolean;
  staged: number;
  rejected: Array<{ control: string; reason: string }>;
  /** Supplied keys that are not proposable controls of this form. */
  skipped: string[];
}

/**
 * Stage each supplied value as a proposal for local human review. Unknown,
 * secret, read-only, or disabled controls are skipped — never written — and a
 * proposal never applies or submits anything.
 */
export async function stageControlProposals(
  registry: ControlInteractionRegistry,
  formId: string,
  values: Record<string, unknown>,
  context: { source?: ControlCommandSource; actorId?: string } = {},
  options: ControlProposalOptions = {},
): Promise<StageControlProposalsResult> {
  const controls = proposableControls(registry, formId, options);
  const commands: ControlCommand[] = [];
  const skipped: string[] = [];
  for (const [controlId, value] of Object.entries(values ?? {})) {
    const snapshot = controls.get(controlId);
    if (!snapshot) {
      skipped.push(controlId);
      continue;
    }
    commands.push({ action: 'stage', identity: snapshot.identity, value });
  }
  if (commands.length === 0) {
    return { ok: false, staged: 0, rejected: [], skipped };
  }
  const commandContext = {
    source: context.source ?? ('agent' as const),
    ...(context.actorId ? { actorId: context.actorId } : {}),
  };
  let results: ControlCommandResult[];
  if (registry.executeBatch) {
    results = (await registry.executeBatch(commands, commandContext)).results;
  } else {
    results = [];
    for (const command of commands) {
      results.push(await registry.execute(command, commandContext));
    }
  }
  const rejected = results
    .filter((result) => !result.ok)
    .map((result) => ({
      control: result.identity.controlId,
      reason: result.reason ?? 'rejected',
    }));
  return {
    ok: rejected.length === 0,
    staged: results.length - rejected.length,
    rejected,
    skipped,
  };
}
