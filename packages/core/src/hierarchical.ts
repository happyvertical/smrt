/**
 * SmrtHierarchical — base class for self-referencing tree hierarchies.
 *
 * Provides batched parent/children/ancestors/descendants/hierarchy traversal
 * and a cycle-safe `moveTo`. Replaces five copies of the same logic across
 * Place, Event, Tag, Account, and Zone.
 *
 * Examples in the monorepo:
 *
 * | Subclass | Domain                                         |
 * |----------|------------------------------------------------|
 * | Place    | hierarchical geographic places                 |
 * | Event    | nestable event hierarchy (game → period → …)   |
 * | Tag      | tag taxonomies and category trees              |
 * | Account  | chart of accounts                              |
 * | Zone     | placement zones inside a digital property      |
 *
 * Convention: every subclass uses `parentId: string | null` referencing
 * another row in the same table (or STI base table) by UUID. Classes whose
 * self-reference has different semantics — e.g. `Fact.previousFactId` (an
 * evolution chain) or `Asset.sourceAssetId` (a derivation DAG) — should
 * NOT extend SmrtHierarchical. Use descriptive names and class-specific
 * methods instead.
 *
 * @example
 * ```typescript
 * @smrt({ tableStrategy: 'sti', api: true })
 * export class Place extends SmrtHierarchical {
 *   name = '';
 * }
 *
 * const ancestors = await place.getAncestors();
 * const descendants = await place.getDescendants(); // BFS, one query per level
 * await place.moveTo(newParent);                    // cycle-checked
 * ```
 */

import type { SmrtCollection } from './collection';
import { SmrtObject } from './object';
import { ObjectRegistry } from './registry';

/**
 * Aggregate hierarchy view: ancestors (root-first), self, and all descendants
 * (BFS order). Generic on the concrete subclass so `getHierarchy()` preserves
 * the caller's type — `place.getHierarchy()` yields `HierarchyView<Place>`.
 */
export interface HierarchyView<T extends SmrtHierarchical> {
  ancestors: T[];
  current: T;
  descendants: T[];
}

export class SmrtHierarchical extends SmrtObject {
  /**
   * Internal marker so the scanner can recognize this framework abstract base
   * even when consumers haven't built its package. Mirrors
   * `SmrtJunction._isJunctionBase`. Don't rename without also updating the
   * scanner's `FRAMEWORK_BASE_CLASSES` set in
   * `packages/scanner/src/inheritance-resolver.ts`.
   */
  static readonly _isHierarchicalBase = true as const;

  /** Self-referencing parent. `null` means top-level (no parent). */
  parentId: string | null = null;

  /**
   * Resolve the collection used to load siblings/ancestors/descendants.
   *
   * Goes through `ObjectRegistry.getCollection` so subclasses don't have to
   * hard-code a dynamic import of their own collection module. Also acts as
   * the abstract-base guard — `new SmrtHierarchical()` followed by any
   * traversal method throws a clear error rather than producing garbage.
   *
   * For STI subclasses, queries are issued against the STI base collection
   * so the table/discriminator are correct.
   *
   * Disambiguates classes that share a simple name across packages
   * (e.g. two packages both shipping `Document`) by walking the
   * constructor prototype chain. Constructor identity is unique even
   * when class names collide, so this is collision-immune end-to-end:
   *
   * 1. Walk `this.constructor`'s prototype chain. For each ancestor
   *    constructor, ask `ObjectRegistry.getClassByConstructor()` for
   *    its registration. Track the OLDEST registration whose decorator
   *    config declares `tableStrategy: 'sti'` — that's the STI base.
   * 2. If we found an STI base, use its qualified name as the
   *    collection lookup key.
   * 3. Otherwise (non-STI), use this constructor's own qualified
   *    registration name.
   * 4. Fall back to the simple `this.constructor.name` only when nothing
   *    is registered (in which case `getCollection` itself will surface
   *    the existing "not found in ObjectRegistry" error).
   *
   * This finishes the qualified-name disambiguation that the prior
   * implementation only delivered for non-STI hierarchical classes —
   * `ObjectRegistry.getSTIBase(simpleName)` returns simple ancestor
   * names from the inheritance chain map, which collapsed the qualified
   * lookup back to an ambiguous simple key. Walking the runtime
   * prototype chain sidesteps that entirely.
   */
  protected async _hierarchyCollection(): Promise<SmrtCollection<this>> {
    if (this.constructor === SmrtHierarchical) {
      throw new Error(
        'SmrtHierarchical is abstract — extend it from a concrete @smrt() class before calling hierarchy methods.',
      );
    }

    // Walk the prototype chain looking for the OLDEST ancestor whose
    // registered config declares STI. Keep overwriting so we end on the
    // root-most STI declaration (multi-level STI hierarchies put the
    // shared table on the OLDEST ancestor — see ObjectRegistry.getSTIBase).
    //
    // Terminate at SmrtHierarchical (the typical case for any concrete
    // subclass) and at `Function.prototype` / `Object.prototype` — those
    // are what `Object.getPrototypeOf(ctor)` ultimately surfaces at the
    // top of the chain (not the `Function` / `Object` constructors), so
    // an explicit check against the prototypes avoids running the
    // registry lookup on irrelevant non-class objects.
    let stiBaseRegistration: ReturnType<
      typeof ObjectRegistry.getClassByConstructor
    >;
    let ctor: unknown = this.constructor;
    while (
      ctor &&
      ctor !== SmrtHierarchical &&
      ctor !== Function.prototype &&
      ctor !== Object.prototype
    ) {
      const reg = ObjectRegistry.getClassByConstructor(ctor as any);
      if (reg?.config?.tableStrategy === 'sti') {
        stiBaseRegistration = reg;
      }
      ctor = Object.getPrototypeOf(ctor);
    }

    const ownRegistration = ObjectRegistry.getClassByConstructor(
      this.constructor as any,
    );
    const resolved = stiBaseRegistration ?? ownRegistration;
    const collectionClass =
      resolved?.qualifiedName ?? resolved?.name ?? this.constructor.name;

    return await ObjectRegistry.getCollection<this>(
      collectionClass,
      this.options,
    );
  }

  /**
   * The parent row, or `null` when this row is top-level.
   *
   * Single query. Returns the hydrated row (STI dispatch applies, so an
   * Article-extends-Document subclass comes back as `Article`).
   */
  async getParent(): Promise<this | null> {
    if (!this.parentId) return null;
    const collection = await this._hierarchyCollection();
    const parent = await collection.get({ id: this.parentId });
    return parent as this | null;
  }

  /**
   * Immediate children. Single query: `WHERE parent_id = this.id`.
   */
  async getChildren(): Promise<this[]> {
    if (!this.id) return [];
    const collection = await this._hierarchyCollection();
    const children = await collection.list({
      where: { parentId: this.id },
    });
    return children as this[];
  }

  /**
   * All ancestors, root-first (immediate parent last). Does not include self.
   *
   * Intrinsically O(depth) queries — each step needs the previous level's
   * `parentId` before it can fetch the next. Includes cycle protection: if
   * a row's ancestor chain loops back on itself (data corruption), the walk
   * stops cleanly instead of looping forever.
   */
  async getAncestors(): Promise<this[]> {
    const ancestors: this[] = [];
    const visited = new Set<string>();
    if (this.id) visited.add(this.id);
    let current: this = this;

    while (current.parentId) {
      if (visited.has(current.parentId)) break;
      visited.add(current.parentId);

      const parent = (await current.getParent()) as this | null;
      if (!parent) break;
      ancestors.unshift(parent);
      current = parent;
    }

    return ancestors;
  }

  /**
   * All descendants in BFS order. One query per level of depth using `IN`
   * on the previous level's IDs — eliminates the recursive-per-child N+1
   * pattern the duplicated implementations used.
   *
   * Cycle-safe via a visited Set keyed on row id.
   */
  async getDescendants(): Promise<this[]> {
    if (!this.id) return [];
    const collection = await this._hierarchyCollection();
    const descendants: this[] = [];
    const visited = new Set<string>([this.id]);
    let frontier: string[] = [this.id];

    while (frontier.length > 0) {
      const children = (await collection.list({
        where: { parentId: frontier },
      })) as this[];

      const next: string[] = [];
      for (const child of children) {
        if (!child.id || visited.has(child.id)) continue;
        visited.add(child.id);
        descendants.push(child);
        next.push(child.id);
      }
      frontier = next;
    }

    return descendants;
  }

  /**
   * Full hierarchy view: ancestors, self, descendants. Issued concurrently.
   */
  async getHierarchy(): Promise<HierarchyView<this>> {
    const [ancestors, descendants] = await Promise.all([
      this.getAncestors(),
      this.getDescendants(),
    ]);
    return { ancestors, current: this, descendants };
  }

  /**
   * Reparent this row. Pass `null` to make it a root, an id string, or the
   * target row itself. Refuses to:
   *
   * - move a row to itself (self-loop)
   * - move a row under one of its own descendants (would create a cycle)
   *
   * Persists via `save()`. Caller is responsible for any out-of-band
   * denormalization (e.g. depth caches on subclasses like Tag.level).
   */
  async moveTo(newParent: this | string | null): Promise<void> {
    const newParentId =
      newParent === null
        ? null
        : typeof newParent === 'string'
          ? newParent
          : (newParent.id ?? null);

    if (newParentId !== null && newParentId === this.id) {
      throw new Error(
        `Cannot move ${this.constructor.name} ${this.id} to itself.`,
      );
    }

    if (newParentId !== null) {
      const descendants = await this.getDescendants();
      if (descendants.some((d) => d.id === newParentId)) {
        throw new Error(
          `Cannot move ${this.constructor.name} ${this.id} under one of its own descendants (${newParentId}) — would create a cycle.`,
        );
      }
    }

    this.parentId = newParentId;
    await this.save();
  }
}
