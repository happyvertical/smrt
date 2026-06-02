/**
 * R10 — consolidated child-accessor API for `@oneToMany` relationships.
 *
 * Before R10 every model hand-rolled its own child accessor (`getTerms`,
 * `getChildren`, `getForProfile`, …) with inconsistent names and shapes. This
 * module installs ONE canonical accessor per `@oneToMany` field at class
 * registration time: a `@oneToMany('Child') items` field gains a `getItems()`
 * instance method that delegates to the existing `loadRelatedMany('items')`
 * resolver — the same code path used for lazy loading and `include:` eager
 * loading, which itself queries through the child collection (the queryable
 * primitive).
 *
 * Two invariants make this safe to apply to every registered class:
 *
 * - **Additive.** If a method of the computed name already exists anywhere on
 *   the prototype chain — a hand-rolled accessor like
 *   `ProfileRelationship.getTerms()`, a differently-shaped `Profile.getMetadata()`,
 *   or a `SmrtObject` base method — it is left untouched. The generated
 *   accessor never renames or shadows an existing public signature.
 * - **Runtime-only.** Accessors are attached to the prototype at registration;
 *   they are invisible to the build-time manifest, so they never leak into the
 *   generated REST/CLI/MCP surface (those read `classInfo.tools`/scanned
 *   methods, not the runtime prototype). They are a developer-ergonomics
 *   convenience layered on top of `loadRelatedMany`.
 *
 * Multiplicity note: when the child class declares more than one foreign key
 * back to the parent (e.g. `ProfileRelationship.fromProfileId` /
 * `toProfileId`), annotate the `@oneToMany` with `{ foreignKey: 'fromProfileId' }`
 * so `loadRelatedMany` resolves the correct inverse side. Without it the
 * resolver falls back to the first matching foreign key (legacy behavior). An
 * explicit `foreignKey` that matches no inverse FK is treated as an error.
 *
 * STI note: a child class inherits the base's generated accessor through the
 * prototype chain. `loadRelatedMany` resolves the inverse FK against the
 * instance's class AND its registered ancestors (see
 * `ObjectRegistry.getInverseRelationshipsForSelf`), so calling the accessor on
 * an STI subclass instance resolves a `@oneToMany` declared on its base.
 */

import type { RelationshipMetadata } from './registry/types';

/**
 * Compute the canonical child-accessor method name for a `@oneToMany` field.
 *
 * `terms` → `getTerms`, `relationshipsFrom` → `getRelationshipsFrom`. Exported
 * so tests and tooling can derive the name without re-implementing the rule.
 *
 * @param fieldName - The `@oneToMany` property name on the parent class
 * @returns The generated accessor method name
 */
export function childAccessorName(fieldName: string): string {
  return `get${fieldName.charAt(0).toUpperCase()}${fieldName.slice(1)}`;
}

/**
 * Install generated child accessors for a class's `@oneToMany` relationships.
 *
 * Called from the `@smrt()` decorator immediately after the class is
 * registered, so `relationships` reflects the class's own (decorator- or
 * manifest-derived) relationship metadata. Non-`oneToMany` entries are ignored,
 * so callers may pass the unfiltered relationship list.
 *
 * @param ctor - The registered class constructor (its prototype is augmented)
 * @param relationships - Relationship metadata for the class (from
 *   `ObjectRegistry.getRelationships`)
 */
export function applyOneToManyChildAccessors(
  ctor: { prototype?: any } | undefined,
  relationships: RelationshipMetadata[] | undefined,
): void {
  const prototype = ctor?.prototype;
  if (!prototype || !relationships) {
    return;
  }

  for (const relationship of relationships) {
    if (relationship.type !== 'oneToMany') {
      continue;
    }

    const fieldName = relationship.fieldName;
    if (!fieldName) {
      continue;
    }

    const accessorName = childAccessorName(fieldName);

    // Additive only: never shadow a hand-rolled accessor (or any inherited
    // method, including SmrtObject base methods) of the same name. `in`
    // walks the full prototype chain.
    if (accessorName in prototype) {
      continue;
    }

    Object.defineProperty(prototype, accessorName, {
      value: function generatedChildAccessor(this: {
        loadRelatedMany(field: string): Promise<any[]>;
      }): Promise<any[]> {
        return this.loadRelatedMany(fieldName);
      },
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}
