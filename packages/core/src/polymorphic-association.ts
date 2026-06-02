/**
 * SmrtPolymorphicAssociation — base class for polymorphic association rows.
 *
 * A polymorphic association links an owner row to an arbitrary target
 * SmrtObject identified by a `(metaType, metaId)` pair — `metaType` being the
 * target's qualified class name (e.g. `@happyvertical/smrt-content:Article`)
 * and `metaId` its row id. Pair that with a `role` discriminator and a
 * `sortOrder`, and one join table can reference many different target types
 * without a typed foreign key per type.
 *
 * Subclasses add their own "owner" side and decorate with `@smrt()`:
 *
 * ```typescript
 * @smrt({ conflictColumns: ['asset_id', 'meta_type', 'meta_id', 'role'] })
 * export class AssetAssociation extends SmrtPolymorphicAssociation {
 *   @foreignKey('Asset', { required: true })
 *   assetId = '';
 * }
 *
 * const target = await association.hydrate(); // resolves metaType + loads metaId
 * ```
 *
 * Convention: `metaId` is intentionally a bare string, NOT a typed
 * `@foreignKey` / `@crossPackageRef` — it is polymorphic, so there is no
 * single target table to point at. `metaType` carries the type information
 * instead, resolved at runtime via `ObjectRegistry`.
 *
 * This is an abstract framework base in the same family as
 * `SmrtHierarchical` and `SmrtJunction`: it has no `@smrt()` decorator and no
 * table of its own. Its columns are merged into each concrete subclass's
 * manifest by the scanner's `FRAMEWORK_BASE_CLASSES` /
 * `FRAMEWORK_ABSTRACT_BASE_NAMES` wiring. Keep those two lists in sync when
 * touching this class.
 *
 * @example
 * ```typescript
 * @smrt({ conflictColumns: ['owner_id', 'meta_type', 'meta_id', 'role'] })
 * export class CommentAssociation extends SmrtPolymorphicAssociation {
 *   @foreignKey('Comment', { required: true })
 *   ownerId = '';
 * }
 * ```
 */

import type { SmrtCollection } from './collection';
import { field } from './decorators/index';
import { SmrtObject, type SmrtObjectOptions } from './object';
import { ObjectRegistry } from './registry';

/**
 * Options accepted by `SmrtPolymorphicAssociation` (and its subclasses)
 * covering the polymorphic right side of the join.
 */
export interface SmrtPolymorphicAssociationOptions extends SmrtObjectOptions {
  /** Target class name or qualified name (e.g. `'Article'` or `'@pkg:Article'`). */
  metaType?: string;
  /** Target object id. */
  metaId?: string;
  /** Association role (e.g. `'hero'`, `'thumbnail'`, `'attachment'`). */
  role?: string;
  /** Sort order within a role. */
  sortOrder?: number;
}

export class SmrtPolymorphicAssociation extends SmrtObject {
  /**
   * Internal marker so the scanner can recognize this framework abstract base
   * even when consumers haven't built its package. Mirrors
   * `SmrtHierarchical._isHierarchicalBase` and `SmrtJunction._isJunctionBase`.
   * Don't rename without also updating the scanner's `FRAMEWORK_BASE_CLASSES`
   * set in `packages/scanner/src/inheritance-resolver.ts` and
   * `FRAMEWORK_ABSTRACT_BASE_NAMES` in
   * `packages/core/src/scanner/manifest-generator.ts`.
   */
  static readonly _isPolymorphicAssociationBase = true as const;

  /** Target class name or qualified name (e.g. `'Article'` or `'@pkg:Article'`). */
  @field({ required: true })
  metaType = '';

  /**
   * Target object id. Bare string by design — polymorphic, not a typed
   * `@foreignKey` / `@crossPackageRef`, because there is no single target
   * table to point at.
   */
  @field({ required: true })
  metaId = '';

  /** Role of this association (e.g. `'hero'`, `'thumbnail'`, `'attachment'`). */
  @field({ required: true })
  role = 'default';

  /** Sort order for ordering targets within a role. */
  @field()
  sortOrder: number = 0;

  constructor(options: SmrtPolymorphicAssociationOptions = {}) {
    super(options);
    if (options.metaType) this.metaType = options.metaType;
    if (options.metaId) this.metaId = options.metaId;
    if (options.role) this.role = options.role;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
  }

  /**
   * Resolve and load the target object this association points at.
   *
   * Resolves `metaType` to its registered class via
   * `ObjectRegistry.getClassByQualifiedName` (falling back to a simple-name
   * lookup for legacy/unqualified values), then loads the `metaId` row through
   * the target's collection. Going through the collection means STI targets
   * are rehydrated as their concrete subclass and a missing row yields `null`.
   *
   * When the type isn't registered yet, the raw `metaType` is handed to
   * `ObjectRegistry.getCollection`, which lazily loads an installed-but-
   * unimported target package before resolving — so a qualified `metaType`
   * still hydrates even if nothing has imported the target class.
   *
   * Returns `null` when `metaType`/`metaId` are unset, the type can't be
   * resolved to a registered/loadable class, or the target row no longer
   * exists. The target shares this association's database connection via
   * `this.options`.
   *
   * Prefer qualified `metaType` values (`@pkg:Class`): a bare simple name is
   * resolved best-effort and is ambiguous when two packages share a class
   * name.
   *
   * @typeParam T - Expected target type for the caller's convenience cast.
   */
  async hydrate<T extends SmrtObject = SmrtObject>(): Promise<T | null> {
    if (!this.metaType || !this.metaId) return null;

    // Prefer the qualified-name lookup; fall back to a simple-name lookup for
    // legacy/unqualified values. When neither resolves, hand the raw metaType
    // to getCollection so its lazy external-package load can still find it.
    const registered =
      ObjectRegistry.getClassByQualifiedName(this.metaType) ??
      ObjectRegistry.getClass(this.metaType);
    const lookup =
      registered?.qualifiedName ?? registered?.name ?? this.metaType;

    let collection: SmrtCollection<SmrtObject>;
    try {
      collection = await ObjectRegistry.getCollection<SmrtObject>(
        lookup,
        this.options,
      );
    } catch {
      // metaType doesn't resolve to a registered or loadable class.
      return null;
    }

    const target = await collection.get({ id: this.metaId });
    return target as T | null;
  }
}
