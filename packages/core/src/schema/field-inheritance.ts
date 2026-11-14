/**
 * The one rule for "what fields does a class have, counting what it inherits"
 * (#4940, #4942).
 *
 * The build step (`ManifestGenerator.mergeInheritedFields()`) and the registry
 * (`getAllFields()`, `getOwnTableFieldsSync()`, and through them
 * `runtimeModelEntry()`) both call {@link resolveInheritedFields}; they differ
 * only in how they turn their own data into {@link FieldInheritanceLink}s and
 * in the {@link FieldRepresentation} they write fills in. The differential test
 * `field-inheritance-parity.test.ts` runs one matrix of declaration shapes
 * through both and requires them to agree.
 *
 * This module is pure. It imports nothing from the registry or the scanner, so
 * both sides can use it without a cycle, and it is generic over any field
 * shape that structurally satisfies {@link InheritableField} (a manifest
 * `FieldDefinition` and a registry `RegisteredField` both do).
 *
 * ## The rule
 *
 * Ancestors are applied base to child, then the class's own fields last.
 *
 * - A field new to the result is taken as declared.
 * - A redeclaration inherits its parent's options as defaults. Only stated
 *   options override them, nearest first, for own-table and shared-table alike.
 *   Scanner `_meta.__statedOptions` records written decorator options (plus
 *   enum and relationship declarations), before inferred values are normalized
 *   by the registry. Bare and partial redeclarations keep the other options.
 *   Null clears an option; the effective value is absent. A type change drops
 *   inherited sqlType, min/max, minLength/maxLength, pattern, enum, default and
 *   backfill. Registry fields also keep tenancy markers, combine validators
 *   and fill a missing runtime value. Replacing a framework abstract base's
 *   default takes the declaration whole. The class's own declaration is last.
 * - A framework abstract base's own default is never replaced by another
 *   framework base's in a shared-table family (the first stays; only `enum`
 *   and `description` follow the later one); in an own-table class the later
 *   base replaces it.
 * - `SmrtHierarchical.parentId` becomes a nullable self-referencing
 *   `foreignKey`. Its target is the class's own table: the class itself for an
 *   own-table class, the family root (the first concrete class in the chain)
 *   for a shared-table one. In an own-table class a concrete ancestor's own
 *   `parentId` never replaces that binding; the class's own declaration does.
 *
 * The one limit on loosening: a field that is required and carries
 * `requiredFor` (smrt's own code is wrong without it) may not become
 * optional. {@link resolveInheritedFields} refuses it with
 * `CONFIG_REQUIRED_FIELD_LOOSENED` (#4932), so the build, the registry and
 * run-time models all refuse by this one decision, {@link requiredLoosenedReason}.
 * Only a stated `required: false` is refused: an entry with no stated-options
 * list (a manifest older than the list, or one written by hand) keeps the
 * parent's `required` and is not refused ({@link inferredRequired}).
 *
 * A calculated field (`generated`, #4915) is inherited like any other option,
 * but a redeclaration may not clear it ({@link assertCalculatedKept}).
 *
 * Methods merge by a different rule and are not part of this.
 */

import { ConfigurationError } from '../errors.js';

/** The slice of a field this module reads. */
export interface InheritableField {
  type?: string;
  required?: boolean;
  enum?: unknown;
  description?: string;
  related?: string;
  _meta?: { [key: string]: unknown } | undefined;
  __tenancy?: unknown;
  value?: unknown;
}

/** One class in the chain, in the neutral form both sides can produce. */
export interface FieldInheritanceLink<F extends InheritableField> {
  /** Simple class name (`SmrtHierarchical`, `Event`, ...). */
  name: string;
  /** The class's own declared fields. */
  fields: Iterable<readonly [string, F]>;
  /** A framework abstract base: scaffolding with no table of its own. */
  frameworkBase: boolean;
}

/**
 * How options are written. A manifest `FieldDefinition` has first-class
 * attributes and decorator `_meta`; registry fields mirror effective options
 * under `_meta` and carry runtime-only tenancy, validators and `value`.
 */
export type FieldRepresentation = 'manifest' | 'registry';

export type FieldInheritanceStrategy = 'own-table' | 'shared-table';

export interface ResolveInheritedFieldsInput<F extends InheritableField> {
  strategy: FieldInheritanceStrategy;
  /** The class being resolved (its simple name). */
  className: string;
  /** Ancestors, base first. The class itself is not among them. */
  ancestors: ReadonlyArray<FieldInheritanceLink<F>>;
  /** The class's own declared fields, applied last. */
  own: Iterable<readonly [string, F]>;
  representation: FieldRepresentation;
  /** Called when a replacement changes a field's type (a developer warning). */
  onTypeMismatch?: (
    fieldName: string,
    inheritedType: string | undefined,
    ownType: string,
    inherited: F,
  ) => void;
}

/**
 * The one decision for "this redeclaration loosens a field smrt needs": the
 * inherited field is required and carries `requiredFor` (#4923), and the
 * resolved field is not required. Returns the reason, or undefined when the
 * change is allowed (#4932).
 */
export function requiredLoosenedReason(
  inherited: InheritableField,
  resolved: InheritableField,
): string | undefined {
  const reason = inherited._meta?.requiredFor;
  return typeof reason === 'string' &&
    isRequired(inherited) &&
    !isRequired(resolved)
    ? reason
    : undefined;
}

/**
 * Whether a field is required. A registry field loaded from a manifest keeps
 * the flag under `_meta` only, so both places are read.
 */
function isRequired(field: InheritableField): boolean {
  return (field.required ?? field._meta?.required) === true;
}

/**
 * The options of an entry with no stated-options list that are not trusted when
 * the parent's field is one smrt needs. A manifest built before the scanner
 * wrote the list (or one written by hand) says nothing about what its author
 * wrote, and the older scanner inferred `required: false` (and `nullable`) for
 * fields the author never touched. Taking that as stated would refuse a
 * subclass at run time for something nobody wrote (#4942), so for a field smrt
 * needs the entry's `required` and `nullable` are left out: the field keeps the
 * parent's `required` and `requiredFor`, and nothing is refused. Every other
 * option the entry carries wins, as it did before this release, when the entry
 * replaced its parent's field whole. An entry with a list (even an empty one),
 * and a field no reason protects, are unaffected.
 */
function inferredRequired(
  inherited: InheritableField,
  incoming: InheritableField,
): ReadonlySet<string> {
  const unlisted = !Array.isArray(incoming._meta?.__statedOptions);
  return unlisted &&
    typeof inherited._meta?.requiredFor === 'string' &&
    isRequired(inherited)
    ? new Set(['required', 'nullable'])
    : new Set();
}

/** Refuse a loosened field smrt needs, naming the class and field. */
export function assertRequiredNotLoosened(
  className: string,
  fieldName: string,
  inherited: InheritableField,
  resolved: InheritableField,
): void {
  const reason = requiredLoosenedReason(inherited, resolved);
  if (reason === undefined) return;
  throw new ConfigurationError(
    `${className}.${fieldName} cannot be made optional. smrt needs it (${reason}). ` +
      'Keep it required, or leave the field out of the subclass.',
    'CONFIG_REQUIRED_FIELD_LOOSENED',
  );
}

/**
 * Whether a field is calculated by the database (`generated`, #4915). Only an
 * expression counts: `_meta.generated: true` is the older marker for a field
 * the framework added (the tenant column of `tenantScoped`).
 */
function isCalculated(field: InheritableField): boolean {
  const bag = field as { generated?: unknown };
  const value = bag.generated ?? field._meta?.generated;
  return typeof value === 'object' && value !== null;
}

/**
 * Refuse a redeclaration that turns an inherited calculated field into an
 * ordinary one (by `generated: null`, or a replacement that drops it). A
 * calculated column is the database's: an ordinary declaration would make
 * migrate convert the parent's column (PostgreSQL `DROP EXPRESSION`; SQLite
 * and DuckDB drop and re-add it). The other direction, an inherited ordinary
 * field made calculated, is refused by the generated-field validation
 * (`generated-fields.ts`) on every registration path.
 */
export function assertCalculatedKept(
  className: string,
  fieldName: string,
  inherited: InheritableField,
  resolved: InheritableField,
): void {
  if (!isCalculated(inherited) || isCalculated(resolved)) return;
  throw new ConfigurationError(
    `${className}.${fieldName} cannot stop being calculated: its parent computes it in the database. ` +
      'Leave the field out of the subclass, or declare a field with another name.',
    'CONFIG_CALCULATED_FIELD_CLEARED',
  );
}

const HIERARCHICAL_BASE = 'SmrtHierarchical';

type Bag = Record<string, unknown>;

/** Options tied to the field type, rather than its role in the model. */
const TYPE_BOUND_OPTIONS = new Set([
  'sqlType',
  'min',
  'max',
  'enum',
  'default',
  'backfill',
  'minLength',
  'maxLength',
  'pattern',
]);
const FIELD_SHAPE_KEYS = new Set(['type', '_meta', 'value', '__tenancy']);
const MANIFEST_OPTIONS = new Set([
  'required',
  'default',
  'min',
  'max',
  'minLength',
  'maxLength',
  'enum',
  'description',
  'related',
  'transient',
  'sensitive',
  'readonly',
  'readPermission',
  'exported',
]);

/**
 * Scanner fields name their stated options before registry normalization can
 * copy inferred values into `_meta`. Decorator-only and older fields use the
 * options they carry. Undefined leaves an option out; null explicitly clears it.
 */
function stated(field: InheritableField): Set<string> {
  const names = field._meta?.__statedOptions;
  return new Set(
    Array.isArray(names)
      ? names.filter((key): key is string => typeof key === 'string')
      : [...Object.keys(field), ...Object.keys(field._meta ?? {})].filter(
          (key) =>
            !FIELD_SHAPE_KEYS.has(key) &&
            !key.startsWith('__') &&
            (field._meta?.[key] !== undefined ||
              (field as Bag)[key] !== undefined),
        ),
  );
}

function fillMissing<F extends InheritableField>(
  inherited: F,
  own: F,
  representation: FieldRepresentation,
  /** Carried options that are not taken as stated (see {@link inferredRequired}). */
  notStated: ReadonlySet<string> = new Set(),
): F {
  const inheritedBag = inherited as Bag;
  const ownBag = own as Bag;
  const inheritedMeta = inherited._meta ?? {};
  const ownMeta = own._meta ?? {};
  const meta: Bag = { ...inheritedMeta, ...ownMeta };
  const out = { ...own } as Bag;
  const ownStated = stated(own);
  for (const key of notStated) ownStated.delete(key);
  const inheritedStated = stated(inherited);
  // A type the scanner could not resolve is a fallback, not a stated type: the
  // field keeps its parent's type and options (#4942).
  const typeUnresolved =
    ownMeta.__typeUnresolved === true && inherited.type !== undefined;
  const typeChanged =
    !typeUnresolved &&
    !!inherited.type &&
    !!own.type &&
    inherited.type !== own.type;
  if (typeUnresolved) out.type = inherited.type;
  // The marker follows the type that won: the parent's when the type was
  // inherited, the class's own otherwise.
  const unresolvedMarker = typeUnresolved
    ? inheritedMeta.__typeUnresolved
    : ownMeta.__typeUnresolved;
  if (unresolvedMarker === true) meta.__typeUnresolved = true;
  else delete meta.__typeUnresolved;
  const keys = new Set([
    ...Object.keys(inherited),
    ...Object.keys(inheritedMeta),
    ...Object.keys(own),
    ...Object.keys(ownMeta),
    ...ownStated,
    ...inheritedStated,
  ]);
  for (const key of keys) {
    if (FIELD_SHAPE_KEYS.has(key) || key.startsWith('__')) continue;
    const ownValue = ownMeta[key] !== undefined ? ownMeta[key] : ownBag[key];
    const parentValue =
      inheritedMeta[key] !== undefined ? inheritedMeta[key] : inheritedBag[key];
    // `required` and `nullable` are two spellings of one option: a replacement
    // that states `required` does not inherit the parent's `nullable`.
    const canInherit =
      !(typeChanged && TYPE_BOUND_OPTIONS.has(key)) &&
      !(
        key === 'nullable' &&
        ownStated.has('required') &&
        !ownStated.has('nullable')
      );
    // A stated name with no value records a previous clear. Keep that clear
    // when an already-resolved manifest passes through the registry again.
    const value = ownStated.has(key)
      ? ownValue
      : canInherit && inherited.type !== undefined
        ? parentValue
        : ownValue;
    delete out[key];
    delete meta[key];
    if (value !== undefined && value !== null) {
      if (
        (representation === 'manifest' && MANIFEST_OPTIONS.has(key)) ||
        key in ownBag ||
        key in inheritedBag
      )
        out[key] = value;
      if (
        representation === 'registry' ||
        key in ownMeta ||
        key in inheritedMeta ||
        !MANIFEST_OPTIONS.has(key)
      )
        meta[key] = value;
    }
  }
  if (ownStated.has('nullable') && ownMeta.nullable === true) {
    out.required = false;
    meta.required = false;
    ownStated.add('required');
  }
  if (
    Array.isArray(ownMeta.__statedOptions) ||
    Array.isArray(inheritedMeta.__statedOptions)
  ) {
    meta.__statedOptions = [
      ...new Set([
        ...[...inheritedStated].filter(
          (key) => !(typeChanged && TYPE_BOUND_OPTIONS.has(key)),
        ),
        ...ownStated,
      ]),
    ];
  }
  if (representation === 'registry') {
    // Runtime-only state a manifest never carries.
    if (meta.__tenancy === undefined && inheritedMeta.__tenancy !== undefined)
      meta.__tenancy = inheritedMeta.__tenancy;
    const inheritedValidate = inheritedMeta.validate;
    const ownValidate = ownMeta.validate;
    if (
      typeof inheritedValidate === 'function' &&
      typeof ownValidate === 'function'
    ) {
      type Validator = (value: unknown) => boolean | Promise<boolean>;
      meta.validate = async (value: unknown) =>
        (await (inheritedValidate as Validator)(value)) &&
        (await (ownValidate as Validator)(value));
    }
    // The @tenantId marker survives a scanner type conflict (#841).
    if (inherited.__tenancy !== undefined) {
      out.__tenancy = {
        ...((own.__tenancy as Bag | undefined) ?? {}),
        ...(inherited.__tenancy as Bag),
      };
    }
    if (own.value === undefined && inherited.value !== undefined)
      out.value = inherited.value;
  }
  if (Object.keys(meta).length > 0 || own._meta !== undefined) out._meta = meta;
  return out as F;
}

/** A later framework base's `enum` / `description` follow onto the kept field. */
function followNearestDocs<F extends InheritableField>(kept: F, later: F): F {
  return {
    ...kept,
    ...(later.enum !== undefined ? { enum: later.enum } : {}),
    ...(later.description !== undefined
      ? { description: later.description }
      : {}),
  };
}

function normalizeHierarchicalParentId<F extends InheritableField>(
  field: F,
  related: string,
): F {
  return {
    ...field,
    type: 'foreignKey',
    related,
    required: false,
    _meta: { ...(field._meta ?? {}), nullable: true },
  };
}

/**
 * The effective fields of a class: its ancestors' and its own, by the rule in
 * the module comment. Insertion order is first appearance, base first.
 */
export function resolveInheritedFields<F extends InheritableField>(
  input: ResolveInheritedFieldsInput<F>,
): Map<string, F> {
  const { strategy, className, ancestors, own, representation } = input;
  const result = new Map<string, F>();
  const owners = new Map<string, FieldInheritanceLink<F>>();

  // The table a `SmrtHierarchical.parentId` points at.
  const parentTarget =
    strategy === 'own-table'
      ? className
      : (ancestors.find((link) => !link.frameworkBase)?.name ?? className);

  const replace = (name: string, inherited: F, incoming: F): F => {
    if (
      input.onTypeMismatch &&
      incoming.type &&
      incoming.type !== inherited.type
    ) {
      input.onTypeMismatch(name, inherited.type, incoming.type, inherited);
    }
    const resolved = fillMissing(
      inherited,
      incoming,
      representation,
      inferredRequired(inherited, incoming),
    );
    assertRequiredNotLoosened(className, name, inherited, resolved);
    assertCalculatedKept(className, name, inherited, resolved);
    return resolved;
  };

  for (const link of ancestors) {
    for (const [name, declared] of link.fields) {
      const field =
        link.name === HIERARCHICAL_BASE && name === 'parentId'
          ? normalizeHierarchicalParentId(declared, parentTarget)
          : declared;
      const current = result.get(name);
      const owner = owners.get(name);
      if (current === undefined || owner === undefined) {
        result.set(name, fillMissing({} as F, field, representation));
        owners.set(name, link);
        continue;
      }
      if (strategy === 'own-table') {
        // A concrete ancestor's own `parentId` never replaces the framework's
        // binding to this class's table.
        if (
          !link.frameworkBase &&
          name === 'parentId' &&
          owner.name === HIERARCHICAL_BASE
        ) {
          continue;
        }
        result.set(
          name,
          owner.frameworkBase || link.frameworkBase
            ? fillMissing({} as F, field, representation)
            : replace(name, current, field),
        );
        owners.set(name, link);
        continue;
      }
      // Shared table.
      if (link.frameworkBase) {
        result.set(name, followNearestDocs(current, field));
      } else {
        result.set(
          name,
          owner.frameworkBase
            ? fillMissing({} as F, field, representation)
            : replace(name, current, field),
        );
        owners.set(name, link);
      }
    }
  }

  for (const [name, declared] of own) {
    const current = result.get(name);
    result.set(
      name,
      current
        ? replace(name, current, declared)
        : fillMissing({} as F, declared, representation),
    );
  }
  return result;
}
