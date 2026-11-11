/** Browser-safe field definitions and the canonical layered policy resolver. */
import type { FieldUIHints } from '@happyvertical/smrt-core';
import {
  isFieldUIFormat,
  isFieldUIWidget,
} from '@happyvertical/smrt-core/ui-metadata';
import type {
  ExplainedObjectFieldPolicy,
  FieldPolicyDelta,
  FieldPolicyLayerContribution,
  FieldPolicyVisibility,
  ResolvedFieldPolicy,
} from './types.js';

/** Registry and generated web definitions both satisfy this public metadata shape. */
export interface PolicyFieldDefinition {
  type: string;
  default?: unknown;
  description?: string;
  required?: boolean;
  nullable?: boolean;
  readonly?: boolean;
  sensitive?: boolean;
  transient?: boolean;
  readPermission?: string;
  idType?: string;
  ui?: FieldUIHints;
  _meta?: Record<string, unknown>;
}

/**
 * Narrow a manifest `_meta.ui` bag to the known {@link FieldUIHints} keys with
 * their expected primitive types, dropping junk (mirrors the sanitization the
 * web emission applies in core's `web-collections.ts`).
 */
export function sanitizeFieldUIHints(value: unknown): FieldUIHints | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const ui: FieldUIHints = {
    ...(typeof raw.basic === 'boolean' ? { basic: raw.basic } : {}),
    ...(typeof raw.group === 'string' ? { group: raw.group } : {}),
    ...(typeof raw.order === 'number' && Number.isFinite(raw.order)
      ? { order: raw.order }
      : {}),
    ...(typeof raw.locked === 'boolean' ? { locked: raw.locked } : {}),
    ...(isFieldUIWidget(raw.widget) ? { widget: raw.widget } : {}),
    ...(isFieldUIFormat(raw.format) ? { format: raw.format } : {}),
  };
  return Object.keys(ui).length > 0 ? ui : undefined;
}

/** Security rail: `sensitive` may live top-level or under `_meta` (STI merges). */
export function isSensitiveField(field: PolicyFieldDefinition): boolean {
  return field.sensitive === true || field._meta?.sensitive === true;
}

/** Security rail: `readPermission` may live top-level or under `_meta`. */
export function getFieldReadPermission(
  field: PolicyFieldDefinition,
): string | undefined {
  if (typeof field.readPermission === 'string') {
    return field.readPermission;
  }
  const metaPermission = field._meta?.readPermission;
  return typeof metaPermission === 'string' ? metaPermission : undefined;
}

export function isTransientField(field: PolicyFieldDefinition): boolean {
  return field.transient === true || field._meta?.transient === true;
}

/**
 * True when a registered field can receive a policy row.  Keep this shared by
 * the resolver and the catalog audit: otherwise a row that never resolves can
 * accidentally be presented as an editable setting.
 */
export function isPolicyAddressableField(
  field: PolicyFieldDefinition,
): boolean {
  return (
    field._meta?.__smrtSystemField !== true &&
    field.type !== 'oneToMany' &&
    field.type !== 'manyToMany' &&
    field.type !== 'meta'
  );
}

/**
 * A field is required when flagged required and not explicitly nullable.
 *
 * `nullable` is read from BOTH the top level and `_meta` for the same reason
 * `sensitive`/`readPermission`/`transient` are: registrations reach the
 * registry through several paths (decorator, manifest, STI merge) and land the
 * flag in either place. Checking only one side made the pair asymmetric —
 * `required` was read from both while `nullable` was read from one.
 */
export function isRequiredField(field: PolicyFieldDefinition): boolean {
  if (field.nullable === true || field._meta?.nullable === true) {
    return false;
  }
  return field.required === true || field._meta?.required === true;
}

/** The manifest/code default for a field, boxed; `undefined` when none. */
export function getCodeDefault(
  field: PolicyFieldDefinition,
): { value: unknown } | undefined {
  if (field.default !== undefined) {
    return { value: field.default };
  }
  if (field._meta?.default !== undefined) {
    return { value: field._meta.default };
  }
  return undefined;
}

/**
 * A resolved default satisfies the required-field invariant only when it is a
 * value a form could actually submit: explicit `null` and the empty string do
 * not count (a required text field "defaulting" to `''` is still unfilled).
 */
export function isUsableRequiredDefault(
  defaultBox: { value: unknown } | undefined,
): boolean {
  if (!defaultBox) {
    return false;
  }
  return defaultBox.value !== null && defaultBox.value !== '';
}

/**
 * Compute the code-seed visibility for every field of an object using the
 * cold-start rule (#2046): with no `ui.basic` markers anywhere on the object,
 * every field is `basic`; once any field is marked `basic: true`, unmarked
 * fields default to `advanced` (and an explicit `basic: false` is always
 * `advanced`).
 */
export function buildCodeSeedVisibility(
  fields: ReadonlyMap<string, PolicyFieldDefinition>,
): Map<string, FieldPolicyVisibility> {
  let hasBasicMarkers = false;
  const hints = new Map<string, FieldUIHints | undefined>();
  for (const [name, field] of fields) {
    const ui = sanitizeFieldUIHints(field._meta?.ui ?? field.ui);
    hints.set(name, ui);
    if (ui?.basic === true) {
      hasBasicMarkers = true;
    }
  }

  const visibility = new Map<string, FieldPolicyVisibility>();
  for (const [name] of fields) {
    const ui = hints.get(name);
    if (ui?.basic === true) {
      visibility.set(name, 'basic');
    } else if (ui?.basic === false || hasBasicMarkers) {
      visibility.set(name, 'advanced');
    } else {
      visibility.set(name, 'basic');
    }
  }
  return visibility;
}

/** Code-seed delta for one field (visibility supplied by the cold-start pass). */
export function buildCodeSeedDelta(
  field: PolicyFieldDefinition,
  visibility: FieldPolicyVisibility,
): FieldPolicyDelta {
  const ui = sanitizeFieldUIHints(field._meta?.ui ?? field.ui);
  const help =
    typeof field.description === 'string'
      ? field.description
      : typeof field._meta?.description === 'string'
        ? field._meta.description
        : undefined;
  const codeDefault = getCodeDefault(field);

  return {
    ...(codeDefault ? { default: codeDefault } : {}),
    ...(field.readonly === true ? { readOnly: true } : {}),
    visibility,
    ...(help !== undefined ? { help } : {}),
    ...(ui?.order !== undefined ? { order: ui.order } : {}),
    ...(ui?.locked === true ? { locked: true } : {}),
  };
}

/** Code-seed grouping key (`ui.group`) — not overridable by stored rows. */
export function getCodeSeedGroup(field: PolicyFieldDefinition): string | null {
  return sanitizeFieldUIHints(field._meta?.ui ?? field.ui)?.group ?? null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether a reference field stores text ids instead of native UUIDs. */
function usesTextIdStorage(field: PolicyFieldDefinition): boolean {
  return field.idType === 'text' || field._meta?.idType === 'text';
}

/**
 * True when a reference identifier can be stored in the field's backing
 * column. Native UUID columns accept UUIDs only; `idType: 'text'` opts into
 * arbitrary non-empty string identifiers. Shared by policy defaults and the
 * usage histogram so a poisoned sample can never become an unwriteable
 * suggestion.
 */
export function isStorableReferenceId(
  field: PolicyFieldDefinition,
  value: unknown,
): value is string {
  if (typeof value !== 'string' || value === '') return false;
  return usesTextIdStorage(field) || UUID_PATTERN.test(value);
}

/**
 * Type-check a parsed default value against the manifest field type.
 *
 * Explicit `null` is allowed only for optional fields (a required field with a
 * null default has no usable default). Unsupported field types reject defaults
 * outright (fail closed).
 */
export function assertDefaultValueMatchesFieldType(
  objectRef: string,
  fieldName: string,
  field: PolicyFieldDefinition,
  value: unknown,
): void {
  const label = `Field policy default for "${objectRef}.${fieldName}"`;

  if (value === null) {
    if (isRequiredField(field)) {
      throw new Error(
        `${label} may not be null: the field is required, so a null default ` +
          `is never a usable default`,
      );
    }
    return;
  }

  switch (field.type) {
    case 'text':
      if (typeof value !== 'string') {
        throw new Error(`${label} must be a string (field type "text")`);
      }
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw new Error(`${label} must be an integer (field type "integer")`);
      }
      return;
    case 'decimal':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(
          `${label} must be a finite number (field type "decimal")`,
        );
      }
      return;
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new Error(`${label} must be a boolean (field type "boolean")`);
      }
      return;
    case 'datetime':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        throw new Error(
          `${label} must be a date-parseable string (field type "datetime")`,
        );
      }
      return;
    case 'json':
      // Any JSON value (it already survived JSON.parse).
      return;
    case 'foreignKey':
    case 'crossPackageRef':
      if (typeof value !== 'string') {
        throw new Error(
          `${label} must be a string id (field type "${field.type}")`,
        );
      }
      // Reference columns are native UUID on PostgreSQL/DuckDB unless the
      // field explicitly opts into text ids — a non-UUID default would
      // validate here but fail at insert time on those dialects.
      if (!isStorableReferenceId(field, value)) {
        throw new Error(
          `${label} must be a UUID string (the reference column stores ` +
            `native UUIDs; declare idType 'text' on the field to store ` +
            `arbitrary ids)`,
        );
      }
      return;
    default:
      throw new Error(
        `${label} is not supported: defaults cannot target ` +
          `"${String(field.type)}" fields`,
      );
  }
}

/** Accumulated merge state for one field while layers apply. */
interface MergedPolicyState {
  default?: { value: unknown };
  visibility: FieldPolicyVisibility;
  help?: string;
  label?: string;
  order?: number;
  locked?: boolean;
  readOnly?: boolean;
}

/** Encoded sparse row shared by stored policies and portable cookbooks. */
export interface PolicyRow {
  fieldName: string;
  defaultValue?: string | null;
  visibility?: FieldPolicyVisibility | null;
  label?: string | null;
  help?: string | null;
  displayOrder?: number | null;
  locked?: boolean | null;
  readOnly?: boolean | null;
}

/** Ordered surviving layer; the server owns authorization and tenant-chain selection. */
export interface PolicyRowLayer {
  layer: 'app' | 'tenant' | 'user';
  tenantId?: string;
  userId?: string;
  rows: ReadonlyMap<string, PolicyRow>;
  /** Portable rows have not passed the persistent model's write validation. */
  validateDefaults?: boolean;
}

/** The one pure resolution kernel used by server resolution and cookbook screens. */
export function resolveFieldPolicyLayers(
  objectRef: string,
  fieldMap: ReadonlyMap<string, PolicyFieldDefinition>,
  rowLayers: readonly PolicyRowLayer[],
): ExplainedObjectFieldPolicy {
  const policyFields = [...fieldMap].filter(([, field]) =>
    isPolicyAddressableField(field),
  );
  const codeVisibility = buildCodeSeedVisibility(fieldMap);
  const fields: Record<string, ResolvedFieldPolicy> = {};
  const layers: Record<string, FieldPolicyLayerContribution[]> = {};

  for (const [fieldName, fieldDef] of policyFields) {
    const contributions: FieldPolicyLayerContribution[] = [];

    const codeDelta = buildCodeSeedDelta(
      fieldDef,
      codeVisibility.get(fieldName) ?? 'basic',
    );
    contributions.push({ layer: 'code', delta: codeDelta });

    let state: MergedPolicyState = applyDelta(
      { visibility: 'basic' },
      codeDelta,
    );

    for (const layer of rowLayers) {
      const row = layer.rows.get(fieldName);
      if (!row || (layer.layer === 'user' && state.locked === true)) continue;
      const delta = rowToDelta(row);
      if (fieldDef.readonly && delta.readOnly === false) delete delta.readOnly;
      if (fieldDef.readonly && delta.default) {
        throw new Error(
          `Policy defaults cannot target read-only field ${objectRef}.${fieldName}`,
        );
      }
      if (layer.validateDefaults && delta.default) {
        if (
          isSensitiveField(fieldDef) ||
          isTransientField(fieldDef) ||
          getFieldReadPermission(fieldDef)
        ) {
          throw new Error(
            `Cookbook defaults cannot target restricted field ${objectRef}.${fieldName}`,
          );
        }
        assertDefaultValueMatchesFieldType(
          objectRef,
          fieldName,
          fieldDef,
          delta.default.value,
        );
      }
      contributions.push({
        layer: layer.layer,
        ...(layer.tenantId ? { tenantId: layer.tenantId } : {}),
        ...(layer.userId ? { userId: layer.userId } : {}),
        delta,
      });
      state = applyDelta(state, delta);
    }

    // Resolver-side required-field safety net: a required field with no
    // usable resolved default is ALWAYS visible, regardless of stored
    // visibility — write-time enforcement alone breaks when a DIFFERENT row's
    // deletion removes the default a demotion relied on.
    const required = isRequiredField(fieldDef);
    let visibilityForced = false;
    if (
      required &&
      !isUsableRequiredDefault(state.default) &&
      state.visibility !== 'basic'
    ) {
      state = { ...state, visibility: 'basic' };
      visibilityForced = true;
    }

    fields[fieldName] = {
      fieldName,
      hasDefault: state.default !== undefined,
      defaultValue: state.default?.value,
      visibility: state.visibility,
      help: state.help ?? null,
      label: state.label ?? null,
      order: state.order ?? null,
      group: getCodeSeedGroup(fieldDef),
      locked: state.locked === true,
      required,
      ...(fieldDef.readonly === true || state.readOnly !== undefined
        ? { readOnly: fieldDef.readonly === true || state.readOnly === true }
        : {}),
      ...(visibilityForced ? { visibilityForced: true } : {}),
    };
    layers[fieldName] = contributions;
  }

  return { objectRef, fields, layers };
}

/** Select portable identity layers; effective app rows override provider rows sparsely. */
export function cookbookPolicyLayers(
  definition: { objectRef: string; replacedQualifiedNames?: readonly string[] },
  cookbook: { policies: readonly (PolicyRow & { objectRef: string })[] },
): PolicyRowLayer[] {
  const aliases = new Set(definition.replacedQualifiedNames ?? []);
  const rows = [
    ...cookbook.policies.filter(
      (row) =>
        row.objectRef !== definition.objectRef && aliases.has(row.objectRef),
    ),
    ...cookbook.policies.filter(
      (row) => row.objectRef === definition.objectRef,
    ),
  ];
  return rows.map((row) => ({
    layer: 'app',
    validateDefaults: true,
    rows: new Map([[row.fieldName, row]]),
  }));
}

/** Resolve raw cookbook app rows over an already-public generated definition. */
export function resolveCookbookFieldPolicy(
  definition: {
    objectRef: string;
    replacedQualifiedNames?: readonly string[];
    fields: Readonly<Record<string, PolicyFieldDefinition>>;
  },
  cookbook: { policies: readonly (PolicyRow & { objectRef: string })[] },
): ExplainedObjectFieldPolicy {
  return resolveFieldPolicyLayers(
    definition.objectRef,
    new Map(
      Object.entries(definition.fields).filter(
        ([name, field]) =>
          ![
            'id',
            'tenantId',
            'createdBy',
            'updatedBy',
            'createdAt',
            'updatedAt',
          ].includes(name) &&
          !isSensitiveField(field) &&
          !isTransientField(field) &&
          !getFieldReadPermission(field),
      ),
    ),
    cookbookPolicyLayers(definition, cookbook),
  );
}

/** A stored row's sparse contribution (NULL columns contribute nothing). */
export function rowToDelta(row: PolicyRow): FieldPolicyDelta {
  const delta: FieldPolicyDelta = {};

  if (row.defaultValue !== null && row.defaultValue !== undefined) {
    try {
      delta.default = { value: JSON.parse(row.defaultValue) };
    } catch {
      // Unparseable stored JSON (should be prevented by save-time validation)
      // contributes nothing rather than poisoning resolution.
    }
  }
  if (row.visibility !== null && row.visibility !== undefined) {
    delta.visibility = row.visibility;
  }
  if (row.help !== null && row.help !== undefined) {
    delta.help = row.help;
  }
  if (row.label !== null && row.label !== undefined) {
    delta.label = row.label;
  }
  if (row.displayOrder !== null && row.displayOrder !== undefined) {
    delta.order = row.displayOrder;
  }
  if (row.locked !== null && row.locked !== undefined) {
    delta.locked = row.locked;
  }

  if (row.readOnly != null) delta.readOnly = row.readOnly;
  return delta;
}

function applyDelta(
  state: MergedPolicyState,
  delta: FieldPolicyDelta,
): MergedPolicyState {
  return {
    default: delta.default ?? state.default,
    visibility: delta.visibility ?? state.visibility,
    help: delta.help ?? state.help,
    label: delta.label ?? state.label,
    order: delta.order ?? state.order,
    locked: delta.locked ?? state.locked,
    readOnly: delta.readOnly ?? state.readOnly,
  };
}
