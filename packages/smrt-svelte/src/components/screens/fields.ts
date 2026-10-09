/**
 * Pure derivation of list / view / edit fields from a manifest-derived
 * collection definition and its resolved field policy (#3718).
 *
 * Mirrors smrt-fields' `ObjectForm` selection rule: a field renders only when
 * it is in BOTH the generated web definition and the resolved policy, so
 * sensitive, transient and read-permission-gated fields (which the policy
 * resolver omits) can never appear on a generated screen. Without a policy the
 * code seed applies: the manifest `ui` hints and the cold-start rule (no
 * `basic` markers anywhere => everything basic; any marker => unmarked fields
 * advanced).
 */
import type {
  ScreenCollectionDefinition,
  ScreenField,
  ScreenFieldDefinition,
  ScreenInputKind,
  ScreenMode,
  ScreenPolicy,
} from './types.js';

/** Managed by the platform; never editable and never a default column. */
const SYSTEM_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'tenantId',
  'createdAt',
  'updatedAt',
  'createdBy',
  'updatedBy',
]);

/** System timestamps that are informative (read-only) on a record view. */
const META_TIMESTAMP_FIELDS: readonly string[] = ['createdAt', 'updatedAt'];

/** Columns shown by default on a list when the policy marks many basic. */
export const DEFAULT_MAX_LIST_COLUMNS = 6;

export interface DeriveScreenFieldsOptions {
  mode: ScreenMode;
  /**
   * Explicit field names, in the order given. Hidden fields, fields outside
   * the policy, and non-editable system fields are still dropped.
   */
  include?: readonly string[];
  /** Field names to drop. */
  exclude?: readonly string[];
  /** List mode only: cap on default columns (`include` is never capped). */
  maxListColumns?: number;
}

/** `dueDate` -> `Due date`; reference fields drop a trailing `Id`. */
export function humanizeFieldName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (spaced === '') return name;
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function humanizeLabel(name: string, definition: ScreenFieldDefinition) {
  if (
    (definition.type === 'foreignKey' ||
      definition.type === 'crossPackageRef') &&
    /.[a-z]Id$/.test(name)
  ) {
    return humanizeFieldName(name.slice(0, -2));
  }
  return humanizeFieldName(name);
}

/** Singular and plural display names derived from the class name. */
export function screenTitles(definition: ScreenCollectionDefinition): {
  singular: string;
  plural: string;
} {
  const singular = humanizeFieldName(definition.className);
  const last = singular.slice(-1);
  const plural = /(s|x|z|ch|sh)$/i.test(singular)
    ? `${singular}es`
    : /[^aeiou]y$/i.test(singular)
      ? `${singular.slice(0, -1)}ies`
      : last === ''
        ? singular
        : `${singular}s`;
  return { singular, plural };
}

/** Which control renders a field, from its widget hint and wire type. */
export function inputKindFor(
  definition: ScreenFieldDefinition,
): ScreenInputKind {
  const widget = definition.ui?.widget;
  if (definition.type === 'text') {
    if (widget === 'textarea') return 'textarea';
    if (widget === 'email') return 'email';
    if (widget === 'url') return 'url';
    if (widget === 'phone') return 'tel';
    return 'text';
  }
  // Money is integer minor units only; a currency hint on a decimal is a
  // plain decimal (rates and confidences are the only decimals).
  if (definition.type === 'integer') {
    return widget === 'currency' ? 'money' : 'integer';
  }
  switch (definition.type) {
    case 'decimal':
      return 'decimal';
    case 'boolean':
      return 'boolean';
    case 'datetime':
      return 'datetime';
    case 'json':
      return 'json';
    default:
      return 'reference';
  }
}

function isRequired(
  definition: ScreenFieldDefinition,
  policyRequired: boolean | undefined,
): boolean {
  if (policyRequired !== undefined) return policyRequired;
  return definition.required === true && definition.nullable !== true;
}

/**
 * Mismatch between a definition and a policy, or `null` when they belong
 * together. Components surface this instead of rendering the wrong object.
 */
export function screenSourceError(
  definition: ScreenCollectionDefinition,
  policy: ScreenPolicy | undefined | null,
): string | null {
  if (policy && policy.objectRef !== definition.objectRef) {
    return `Field policy is for '${policy.objectRef}', not '${definition.objectRef}'.`;
  }
  return null;
}

interface Candidate {
  name: string;
  definition: ScreenFieldDefinition;
  index: number;
}

function isDeclaredName(name: string): boolean {
  return !name.startsWith('_') && !name.startsWith('$');
}

function seedBasicSet(candidates: readonly Candidate[]): ReadonlySet<string> {
  const hasMarkers = candidates.some((c) => c.definition.ui?.basic === true);
  const basic = new Set<string>();
  for (const c of candidates) {
    if (c.definition.ui?.basic === true) basic.add(c.name);
    else if (c.definition.ui?.basic !== false && !hasMarkers) basic.add(c.name);
  }
  return basic;
}

/** Order by explicit `order` (nulls last), then declaration order. */
function byOrder(
  a: { order: number | null; index: number },
  b: { order: number | null; index: number },
): number {
  return (
    (a.order ?? Number.MAX_SAFE_INTEGER) -
      (b.order ?? Number.MAX_SAFE_INTEGER) || a.index - b.index
  );
}

/**
 * Select and decorate the fields one screen shows.
 *
 * - `edit`: basic and advanced tiers, system fields never.
 * - `view`: basic and advanced tiers, then `createdAt`/`updatedAt` as
 *   read-only advanced meta when the definition has them.
 * - `list`: basic tier only, without long text, JSON or raw reference columns,
 *   capped at {@link DEFAULT_MAX_LIST_COLUMNS}; `include` overrides all of it.
 */
export function deriveScreenFields(
  definition: ScreenCollectionDefinition,
  policy: ScreenPolicy | undefined | null,
  options: DeriveScreenFieldsOptions,
): ScreenField[] {
  const { mode, include, exclude } = options;
  const excluded = new Set(exclude ?? []);

  const candidates: Candidate[] = Object.entries(definition.fields)
    .map(([name, fieldDefinition], index) => ({
      name,
      definition: fieldDefinition,
      index,
    }))
    .filter(
      (c) =>
        isDeclaredName(c.name) &&
        !SYSTEM_FIELDS.has(c.name) &&
        c.name !== definition.idField,
    );

  const seedBasic = policy ? null : seedBasicSet(candidates);

  const decorate = (c: Candidate): ScreenField | null => {
    const policyField = policy?.fields[c.name];
    if (policy && !policyField) return null;
    const tier = policyField
      ? policyField.visibility
      : seedBasic?.has(c.name)
        ? 'basic'
        : 'advanced';
    if (tier === 'hidden') return null;
    const label = policyField?.label?.trim();
    const help = policyField?.help ?? c.definition.description ?? null;
    return {
      name: c.name,
      label: label || humanizeLabel(c.name, c.definition),
      help: help && help.trim() !== '' ? help : null,
      type: c.definition.type,
      kind: inputKindFor(c.definition),
      required: isRequired(c.definition, policyField?.required),
      tier,
      group: policyField?.group ?? c.definition.ui?.group ?? null,
      order: policyField?.order ?? c.definition.ui?.order ?? null,
      definition: c.definition,
    };
  };

  const decorated = candidates
    .map((c) => ({ c, field: decorate(c) }))
    .filter((e): e is { c: Candidate; field: ScreenField } => e.field !== null)
    .filter((e) => !excluded.has(e.c.name));

  const meta = (name: string): ScreenField | null => {
    const fieldDefinition = definition.fields[name];
    if (!fieldDefinition || excluded.has(name)) return null;
    return {
      name,
      label: humanizeFieldName(name),
      help: null,
      type: fieldDefinition.type,
      kind: 'datetime',
      required: false,
      tier: 'advanced',
      group: null,
      order: null,
      definition: fieldDefinition,
    };
  };

  if (include) {
    const byName = new Map(decorated.map((e) => [e.c.name, e.field]));
    const picked: ScreenField[] = [];
    for (const name of include) {
      if (excluded.has(name)) continue;
      if (mode !== 'edit' && META_TIMESTAMP_FIELDS.includes(name)) {
        const metaField = meta(name);
        if (metaField) picked.push(metaField);
        continue;
      }
      const field = byName.get(name);
      if (field) picked.push(field);
    }
    return picked;
  }

  const ordered = decorated
    .map((e) => e.field)
    .map((field, position) => ({ field, order: field.order, index: position }))
    .sort(byOrder)
    .map((e) => e.field);

  if (mode === 'list') {
    const cap = options.maxListColumns ?? DEFAULT_MAX_LIST_COLUMNS;
    return ordered
      .filter(
        (f) =>
          f.tier === 'basic' &&
          f.kind !== 'json' &&
          f.kind !== 'textarea' &&
          f.kind !== 'reference',
      )
      .slice(0, Math.max(0, cap));
  }

  if (mode === 'view') {
    const metas = META_TIMESTAMP_FIELDS.map(meta).filter(
      (f): f is ScreenField => f !== null,
    );
    return [...ordered, ...metas];
  }

  return ordered;
}

/** Group fields preserving first-seen group order; ungrouped is `null`. */
export function groupScreenFields(
  fields: readonly ScreenField[],
): Array<[string | null, ScreenField[]]> {
  const groups = new Map<string | null, ScreenField[]>();
  for (const field of fields) {
    const bucket = groups.get(field.group) ?? [];
    bucket.push(field);
    groups.set(field.group, bucket);
  }
  return [...groups.entries()];
}
