/**
 * SmrtJunction — base class for two-sided junction (many-to-many) collections.
 *
 * A junction collection manages rows that link a "left" entity to a "right" entity,
 * typically with discriminator fields (relationship/role) and an optional sortOrder.
 * Examples in the monorepo:
 *
 * | Subclass                       | Left field    | Right field | Discriminator   |
 * |--------------------------------|---------------|-------------|-----------------|
 * | ContentAssetCollection         | contentId     | assetId     | relationship    |
 * | PerformerOwnedAssetCollection  | performerId   | assetId     | role            |
 * | PlaceAssetCollection           | placeId       | assetId     | relationship    |
 * | EventParticipantCollection     | eventId       | profileId   | role            |
 * | FactContentCollection          | factId        | contentId   | relationship    |
 *
 * Each subclass declares `leftField` / `rightField` (camelCase) and optionally
 * overrides `sortField` (defaults to `'sortOrder'`; set `null` to disable ORDER BY).
 *
 * Polymorphic subclasses (where "left" or "right" is a composite key like
 * `metaType + metaId`) may override `byLeft` / `byRight` / `attach` / `detach`
 * with diverging signatures — see `AssetAssociationCollection` for a reference.
 *
 * @typeParam TItem - The junction row class (extends `SmrtObject`)
 */

import { SmrtCollection } from './collection';
import type { SmrtObject } from './object';

/**
 * Options passed to `attach` / `setLinks` — written into the created junction row.
 *
 * Common keys: `relationship`, `role`, `sortOrder`, `tenantId`.
 * Subclass-specific keys (e.g. `placement`, `groupId` on EventParticipant) pass through.
 * Keys must match actual camelCase column names on the junction model; unknown
 * keys are rejected by `SmrtCollection.create`'s WHERE/field validation.
 */
export type JunctionAttachOptions = Record<string, unknown>;

/**
 * Options passed to `byLeft` / `byRight` / `detach` — additional WHERE filters
 * narrowing the operation. Keys must match camelCase column names.
 */
export type JunctionFilterOptions = Record<string, unknown>;

function camelToSnake(name: string): string {
  return name.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

export abstract class SmrtJunction<
  TItem extends SmrtObject,
> extends SmrtCollection<TItem> {
  /** Field name (camelCase) holding the "left" foreign key, e.g. `'contentId'`. */
  protected abstract leftField: string;

  /** Field name (camelCase) holding the "right" foreign key, e.g. `'assetId'`. */
  protected abstract rightField: string;

  /**
   * Field name (camelCase) used to ORDER BY when calling `byLeft` / `byRight`.
   * Defaults to `'sortOrder'`. Set to `null` to omit ORDER BY entirely.
   *
   * Independent from `positionField` — `sortField` is a *query* concern
   * (how rows are ordered when read), while `positionField` is a *write*
   * concern (what column `setLinks` auto-assigns to). Tables that order
   * by a non-position field (e.g. `'createdAt'`) should set `sortField`
   * accordingly and leave `positionField` set to `null` or its dedicated
   * position column name.
   */
  protected sortField: string | null = 'sortOrder';

  /**
   * Field name (camelCase) that `setLinks` auto-assigns the array index
   * to when the caller doesn't supply a value. Defaults to `'sortOrder'`.
   * Set to `null` for tables without a dedicated position column (e.g.
   * pure-key junctions, or tables ordered by timestamps).
   *
   * Writing the array index into a non-position field — like `createdAt`
   * or `placement` — would corrupt data. Subclasses without a numeric
   * position column MUST set this to `null`.
   */
  protected positionField: string | null = 'sortOrder';

  /**
   * Return junction rows where the left FK matches `leftId`, narrowed by
   * optional additional WHERE filters. Ordered ASC by `sortField` if set.
   */
  async byLeft(
    leftId: string,
    opts: JunctionFilterOptions = {},
  ): Promise<TItem[]> {
    return (await this.list({
      // Spread opts FIRST so the fixed key always wins — prevents a
      // caller-supplied `{ [leftField]: otherId }` from retargeting the
      // query when opts is forwarded from untrusted input.
      where: { ...opts, [this.leftField]: leftId },
      ...(this.sortField
        ? { orderBy: `${camelToSnake(this.sortField)} ASC` }
        : {}),
    })) as TItem[];
  }

  /**
   * Return junction rows where the right FK matches `rightId`, narrowed by
   * optional additional WHERE filters. Ordered ASC by `sortField` if set.
   */
  async byRight(
    rightId: string,
    opts: JunctionFilterOptions = {},
  ): Promise<TItem[]> {
    return (await this.list({
      where: { ...opts, [this.rightField]: rightId },
      ...(this.sortField
        ? { orderBy: `${camelToSnake(this.sortField)} ASC` }
        : {}),
    })) as TItem[];
  }

  /**
   * Create a new junction row linking `leftId` ↔ `rightId`.
   *
   * Goes through `SmrtCollection.create` which performs an upsert keyed on
   * the model's `@smrt({ conflictColumns })`. Duplicates on the conflict key
   * resolve to an UPDATE that rewrites every column — including the row's
   * `id` and any timestamp columns — to the new instance's values. For most
   * junctions that's fine: callers identify rows by (left, right, discriminator),
   * not by junction-row-id, so id rewrites are invisible.
   *
   * If your junction table is externally addressable by id (e.g. its rows
   * are exposed under `/api/v1/<table>/[id]`), override this method with a
   * find-or-create check to preserve id stability across duplicate calls.
   * See `ContentReferences.attach` for an example.
   *
   * @param opts - Extra fields to write into the row (e.g. `{ relationship, sortOrder, tenantId }`)
   */
  async attach(
    leftId: string,
    rightId: string,
    opts: JunctionAttachOptions = {},
  ): Promise<TItem> {
    return (await this.create({
      // Spread opts FIRST so the fixed key fields always win — prevents
      // a caller-supplied `{ [leftField]: otherId }` from retargeting
      // the write when opts is forwarded from untrusted input.
      ...opts,
      [this.leftField]: leftId,
      [this.rightField]: rightId,
    } as any)) as TItem;
  }

  /**
   * Delete all junction rows matching `leftId` + `rightId` (+ optional filter `opts`).
   *
   * @param opts - Additional WHERE filters (e.g. `{ relationship: 'thumbnail' }`)
   */
  async detach(
    leftId: string,
    rightId: string,
    opts: JunctionFilterOptions = {},
  ): Promise<void> {
    const links = (await this.list({
      where: {
        ...opts,
        [this.leftField]: leftId,
        [this.rightField]: rightId,
      },
    })) as TItem[];
    for (const link of links) {
      await (link as unknown as { delete(): Promise<void> }).delete();
    }
  }

  /**
   * Replace the full set of right-side rows for a `leftId`, scoped by `opts`.
   *
   * Behavior:
   *  1. Snapshots and deletes existing rows matching `{ leftField: leftId, ...opts }`.
   *  2. Creates a new row for each `rightId`, spreading `opts` into the row data.
   *  3. If `positionField` is set and `opts` doesn't specify it, assigns the array index.
   *
   * Not transactional — partial failure leaves the table in a mixed state.
   * For atomic replaces, wrap the call in your own DB transaction.
   */
  async setLinks(
    leftId: string,
    rightIds: string[],
    opts: JunctionAttachOptions = {},
  ): Promise<void> {
    const existing = (await this.list({
      where: { ...opts, [this.leftField]: leftId },
    })) as TItem[];
    for (const link of existing) {
      await (link as unknown as { delete(): Promise<void> }).delete();
    }

    const positionKey = this.positionField;
    for (let i = 0; i < rightIds.length; i++) {
      const rowOpts: JunctionAttachOptions = { ...opts };
      if (positionKey && rowOpts[positionKey] === undefined) {
        rowOpts[positionKey] = i;
      }
      await this.attach(leftId, rightIds[i], rowOpts);
    }
  }
}
