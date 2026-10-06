/**
 * AssetAssociationCollection - Polymorphic junction collection.
 *
 * Extends `SmrtJunctionBase`: the left side is a mandatory composite key
 * (`metaType` + `metaId`). Owner methods retain both required arguments without
 * pretending to implement the single-owner `SmrtJunction` contract.
 * `byRight(assetId)` and junction registration/positioning are inherited.
 *
 * For non-polymorphic links between two domain models, prefer a dedicated
 * noun-table junction (e.g. `content_assets`, `place_assets`) extending
 * `SmrtJunction` directly. Use `AssetAssociation` only for generic/provenance
 * relationships that aren't worth a dedicated table.
 */

import {
  type JunctionAttachOptions,
  type JunctionFilterOptions,
  ObjectRegistry,
  type SmrtCreateInput,
  SmrtJunctionBase,
  smrt,
} from '@happyvertical/smrt-core';
import { AssetAssociation } from './asset-association';

/**
 * `metaType` filter matching every name stored rows may use for the owner's
 * class: its current qualified name and any deprecated
 * `previousQualifiedNames` (#3338). Rows written before and after a model
 * moved package both match; new rows always store the current name
 * (`SmrtPolymorphicAssociation.save()`).
 */
async function metaTypeFilter(metaType: string): Promise<string | string[]> {
  // Async so an owner class known only from its installed manifest is
  // lazily loaded first; otherwise its old names are invisible here.
  const names = await ObjectRegistry.getEquivalentQualifiedNamesAsync(
    metaType,
    { source: 'AssetAssociationCollection' },
  );
  return names.length === 1 ? names[0] : names;
}

// Decorator with empty config — only needed so the scanner detects the
// class. See FactContentCollection for the full rationale; the short
// version is: api/mcp/cli on a collection decorator clobber the item
// class's own config, so leave them off here.
@smrt()
export class AssetAssociationCollection extends SmrtJunctionBase<AssetAssociation> {
  static readonly _itemClass = AssetAssociation;

  protected rightField = 'assetId';

  /**
   * List associations for a polymorphic owner.
   *
   * Composite left key — pass both halves.
   */
  async byLeft(
    metaType: string,
    metaId: string,
    opts: JunctionFilterOptions = {},
  ): Promise<AssetAssociation[]> {
    return (await this.list({
      // Spread opts first so the fixed polymorphic owner keys always win.
      where: { ...opts, metaType: await metaTypeFilter(metaType), metaId },
      orderBy: 'sort_order ASC',
    })) as AssetAssociation[];
  }

  /**
   * Create an association. Composite left (metaType, metaId) precedes right (assetId).
   */
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
    } as SmrtCreateInput<AssetAssociation>)) as AssetAssociation;
  }

  /**
   * Delete matching associations. Composite left (metaType, metaId) precedes right (assetId).
   */
  async detach(
    metaType: string,
    metaId: string,
    assetId: string,
    opts: JunctionFilterOptions = {},
  ): Promise<void> {
    const links = (await this.list({
      where: {
        ...opts,
        metaType: await metaTypeFilter(metaType),
        metaId,
        assetId,
      },
    })) as AssetAssociation[];
    for (const link of links) {
      await link.delete();
    }
  }

  /**
   * Replace all associations for a polymorphic owner with the given asset IDs.
   * Not transactional — see `SmrtJunction.setLinks` for caveats.
   */
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
      where: {
        ...snapshotOpts,
        metaType: await metaTypeFilter(metaType),
        metaId,
      },
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
