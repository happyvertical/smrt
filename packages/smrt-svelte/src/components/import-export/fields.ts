import type {
  SmrtWebCollectionDefinition,
  SmrtWebFieldDefinition,
} from '@happyvertical/smrt-web';
import type { ImportExportField, ImportExportFieldType } from './types.js';

/**
 * The slice of a resolved field policy (`ResolvedFieldPolicy` from
 * `@happyvertical/smrt-fields`) the import/export layer reads. Declared
 * structurally so this package takes no dependency on smrt-fields: pass the
 * resolver's `fields` record as-is.
 */
export interface ImportExportFieldPolicy {
  visibility?: 'basic' | 'advanced' | 'hidden';
  label?: string | null;
  help?: string | null;
  order?: number | null;
  /** An org-locked field keeps its resolved default and is never overwritten by import. */
  locked?: boolean;
  hasDefault?: boolean;
  defaultValue?: unknown;
  required?: boolean;
}

export interface FieldsFromDefinitionOptions {
  /** Resolved policy per field name (`ResolvedObjectFieldPolicy.fields`). */
  policy?: Readonly<Record<string, ImportExportFieldPolicy>>;
  /** Enumerations the manifest does not carry: field name to allowed values. */
  enums?: Readonly<Record<string, readonly string[]>>;
  /** Field names that must be unique within an imported file. */
  unique?: readonly string[];
  /** Field names to leave out entirely. */
  exclude?: readonly string[];
}

/** Managed by the framework or the server; never imported or exported by default. */
const SYSTEM_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'created_at',
  'updated_at',
  'context',
]);
/** Set from the session by tenant-scoped collections. */
const TENANT_FIELDS = new Set(['tenantId', 'tenant_id']);

const TYPE_MAP: Record<SmrtWebFieldDefinition['type'], ImportExportFieldType> =
  {
    text: 'text',
    decimal: 'decimal',
    integer: 'integer',
    boolean: 'boolean',
    datetime: 'datetime',
    json: 'json',
    foreignKey: 'reference',
    crossPackageRef: 'reference',
  };

/** `publishedAt` becomes `Published At`. */
export function humanizeFieldName(name: string): string {
  const spaced = name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Derive import/export columns from a generated collection definition (the
 * manifest) and, optionally, the resolved field policy:
 *
 * - system fields (`createdAt`, `updatedAt`, ...) and `_`-prefixed storage
 *   fields are skipped; `id` is exportable but never imported; tenant fields
 *   are neither
 * - a supplied policy is an allowlist: a field the policy omits is neither
 *   imported nor exported (manifest defaults apply only with no policy)
 * - a policy `hidden` field is neither imported nor exported, so an export
 *   cannot reveal what the UI hides
 * - a policy `locked` field is not importable and keeps its resolved default
 * - policy label, help, order, default and required override the manifest seed
 * - order is policy order, then `ui.order`, then manifest declaration order
 */
export function fieldsFromCollectionDefinition(
  definition: Pick<SmrtWebCollectionDefinition, 'fields'>,
  options: FieldsFromDefinitionOptions = {},
): ImportExportField[] {
  const { policy, enums = {}, unique = [], exclude = [] } = options;
  const skip = new Set(exclude);
  const uniqueSet = new Set(unique);
  const entries: Array<{
    field: ImportExportField;
    order: number;
    seq: number;
  }> = [];
  let seq = 0;

  for (const [name, def] of Object.entries(definition.fields)) {
    seq++;
    if (name.startsWith('_') || SYSTEM_FIELDS.has(name) || skip.has(name))
      continue;
    if (name === 'id') continue; // re-added below with fixed semantics
    const p = policy?.[name];
    // A supplied resolved policy is an allowlist: the resolver omits sensitive,
    // transient and read-gated fields, so a field absent from it never appears.
    if (policy && !p) continue;
    const tenant = TENANT_FIELDS.has(name);
    const hidden = p?.visibility === 'hidden';
    const locked = p?.locked === true;
    const enumValues = enums[name];
    const hasDefault =
      p?.hasDefault === true ||
      (p?.hasDefault === undefined && def.default !== undefined);
    const defaultValue = p?.hasDefault === true ? p.defaultValue : def.default;
    const required =
      p?.required ?? (def.required === true && def.nullable !== true);

    entries.push({
      field: {
        name,
        label: p?.label || humanizeFieldName(name),
        type: enumValues ? 'enum' : TYPE_MAP[def.type],
        required: required && !hasDefault,
        importable: !tenant && !hidden && !locked,
        exportable: !tenant && !hidden,
        ...(enumValues ? { options: enumValues } : {}),
        ...(def.ui?.widget ? { widget: def.ui.widget } : {}),
        ...((p?.help ?? def.description)
          ? { help: (p?.help ?? def.description) as string }
          : {}),
        ...(hasDefault ? { hasDefault: true, defaultValue } : {}),
        ...(locked && !hidden && !tenant ? { locked: true } : {}),
        ...(uniqueSet.has(name) ? { unique: true } : {}),
      },
      order: p?.order ?? def.ui?.order ?? Number.POSITIVE_INFINITY,
      seq,
    });
  }

  entries.sort((a, b) =>
    a.order === b.order ? a.seq - b.seq : a.order - b.order,
  );
  const fields = entries.map((e) => e.field);
  if (!skip.has('id')) {
    fields.unshift({
      name: 'id',
      label: 'ID',
      type: 'reference',
      required: false,
      importable: false,
      exportable: true,
    });
  }
  return fields;
}
