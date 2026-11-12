/**
 * The one rule for "what fields does a class have, counting what it inherits"
 * (#4940).
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
 * - A concrete declaration replaces what it finds, wholesale: the NEAREST
 *   declaration wins, between ancestors too, for own-table and shared-table
 *   classes alike. Replacing a concrete declaration fills only what the
 *   replacement lacks from it: `enum`, `description`, and (registry
 *   representation only) the tenancy marker, combined validators and a
 *   runtime `value`. Replacing a framework abstract base's default takes the
 *   declaration whole, with nothing filled. The class's own declaration
 *   applies last and always fills.
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
 * Methods merge by a different rule and are not part of this.
 */

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
 * How fills are written. A manifest `FieldDefinition` carries `enum` and
 * `description` at the top level; a registry field mirrors them under `_meta`
 * and carries runtime-only state (tenancy marker, validators, `value`).
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

const HIERARCHICAL_BASE = 'SmrtHierarchical';

type Bag = Record<string, unknown>;

/** Whether a replacement field already states a value for `key`. */
function stated(field: InheritableField, key: 'enum' | 'description'): boolean {
  return (
    (field as Bag)[key] !== undefined ||
    (field._meta as Bag | undefined)?.[key] !== undefined
  );
}

function fillMissing<F extends InheritableField>(
  inherited: F,
  own: F,
  representation: FieldRepresentation,
): F {
  if (representation === 'manifest') {
    return {
      ...own,
      ...(own.enum === undefined && inherited.enum !== undefined
        ? { enum: inherited.enum }
        : {}),
      ...(own.description === undefined && inherited.description !== undefined
        ? { description: inherited.description }
        : {}),
    };
  }
  const meta: Bag = { ...(own._meta ?? {}) };
  const inheritedBag = inherited as Bag;
  const inheritedMeta = (inherited._meta ?? {}) as Bag;
  const inheritedEnum = inheritedBag.enum ?? inheritedMeta.enum;
  if (!stated(own, 'enum') && inheritedEnum) meta.enum = inheritedEnum;
  const inheritedDescription =
    inheritedBag.description ?? inheritedMeta.description;
  if (!stated(own, 'description') && inheritedDescription !== undefined) {
    meta.description = inheritedDescription;
  }
  // Runtime-only state a manifest never carries.
  if (meta.__tenancy === undefined && inheritedMeta.__tenancy !== undefined) {
    meta.__tenancy = inheritedMeta.__tenancy;
  }
  const inheritedValidate = inheritedMeta.validate;
  const ownValidate = meta.validate;
  if (
    typeof inheritedValidate === 'function' &&
    typeof ownValidate === 'function'
  ) {
    type Validator = (value: unknown) => boolean | Promise<boolean>;
    meta.validate = async (value: unknown) =>
      (await (inheritedValidate as Validator)(value)) &&
      (await (ownValidate as Validator)(value));
  }
  return {
    ...own,
    _meta: meta as F['_meta'],
    // The @tenantId decorator's marker survives a redeclaration whose scanner
    // type conflicts with it (#841); on a clash the inherited marker wins.
    ...(inherited.__tenancy !== undefined
      ? {
          __tenancy: {
            ...((own.__tenancy as Bag | undefined) ?? {}),
            ...(inherited.__tenancy as Bag),
          },
        }
      : {}),
    ...(own.value === undefined && inherited.value !== undefined
      ? { value: inherited.value }
      : {}),
  };
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
    return fillMissing(inherited, incoming, representation);
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
        result.set(name, field);
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
            ? field
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
          owner.frameworkBase ? field : replace(name, current, field),
        );
        owners.set(name, link);
      }
    }
  }

  for (const [name, declared] of own) {
    const current = result.get(name);
    result.set(name, current ? replace(name, current, declared) : declared);
  }
  return result;
}
