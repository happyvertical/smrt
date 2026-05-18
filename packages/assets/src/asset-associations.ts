/**
 * AssetAssociationCollection - Polymorphic junction collection.
 *
 * Extends `SmrtJunction` with one critical difference: the "left" side of the
 * join is a composite key (`metaType` + `metaId`), not a single column. As a
 * result, `byLeft` / `attach` / `detach` / `setLinks` diverge from the base
 * signatures by taking both halves of the polymorphic owner key.
 *
 * - `leftField` is set to `'metaId'` as a placeholder to satisfy the
 *   `SmrtJunction` contract; the overridden methods never use it.
 * - `byRight(assetId)` is inherited unchanged from the base — the right side
 *   is a single column (`assetId`) and behaves like any other junction.
 *
 * For non-polymorphic links between two domain models, prefer a dedicated
 * noun-table junction (e.g. `content_assets`, `place_assets`) extending
 * `SmrtJunction` directly. Use `AssetAssociation` only for generic/provenance
 * relationships that aren't worth a dedicated table.
 */

import {
  type JunctionAttachOptions,
  type JunctionFilterOptions,
  SmrtJunction,
  smrt,
} from '@happyvertical/smrt-core';
import { AssetAssociation } from './asset-association';

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class AssetAssociationCollection extends SmrtJunction<AssetAssociation> {
  static readonly _itemClass = AssetAssociation;

  // Composite left = (metaType, metaId); right = assetId.
  // `leftField` placeholder satisfies the abstract base — the overrides below
  // always handle the composite key explicitly.
  protected leftField = 'metaId';
  protected rightField = 'assetId';

  /**
   * List associations for a polymorphic owner.
   *
   * Composite left key — pass both halves.
   */
  // @ts-expect-error — diverges from SmrtJunction.byLeft(leftId) by arity; see class docstring.
  async byLeft(
    metaType: string,
    metaId: string,
    opts: JunctionFilterOptions = {},
  ): Promise<AssetAssociation[]> {
    return (await this.list({
      // Spread opts first so the fixed polymorphic owner keys always win.
      where: { ...opts, metaType, metaId },
      orderBy: 'sort_order ASC',
    })) as AssetAssociation[];
  }

  /**
   * Create an association. Composite left (metaType, metaId) precedes right (assetId).
   */
  // @ts-expect-error — diverges from SmrtJunction.attach(leftId, rightId) by arity.
  async attach(
    metaType: string,
    metaId: string,
    assetId: string,
    opts: JunctionAttachOptions = {},
  ): Promise<AssetAssociation> {
    return (await this.create({
      // Spread opts first so the fixed key fields always win.
      ...opts,
      assetId,
      metaType,
      metaId,
    } as any)) as AssetAssociation;
  }

  /**
   * Delete matching associations. Composite left (metaType, metaId) precedes right (assetId).
   */
  // @ts-expect-error — diverges from SmrtJunction.detach(leftId, rightId) by arity.
  async detach(
    metaType: string,
    metaId: string,
    assetId: string,
    opts: JunctionFilterOptions = {},
  ): Promise<void> {
    const links = (await this.list({
      where: { ...opts, metaType, metaId, assetId },
    })) as AssetAssociation[];
    for (const link of links) {
      await link.delete();
    }
  }

  /**
   * Replace all associations for a polymorphic owner with the given asset IDs.
   * Not transactional — see `SmrtJunction.setLinks` for caveats.
   */
  // @ts-expect-error — diverges from SmrtJunction.setLinks(leftId, rightIds) by arity.
  async setLinks(
    metaType: string,
    metaId: string,
    assetIds: string[],
    opts: JunctionAttachOptions = {},
  ): Promise<void> {
    // Strip the right-side key (assetId) from snapshot opts — see the
    // base class docstring for the rationale; the same contract applies
    // here.
    const snapshotOpts: JunctionAttachOptions = { ...opts };
    delete snapshotOpts.assetId;

    const existing = (await this.list({
      where: { ...snapshotOpts, metaType, metaId },
    })) as AssetAssociation[];
    for (const link of existing) {
      await link.delete();
    }

    const positionKey = this.positionField;
    for (let i = 0; i < assetIds.length; i++) {
      const rowOpts: JunctionAttachOptions = { ...opts };
      if (positionKey && rowOpts[positionKey] === undefined) {
        rowOpts[positionKey] = i;
      }
      await this.attach(metaType, metaId, assetIds[i], rowOpts);
    }
  }
}
