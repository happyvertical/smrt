import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { ContentAssetCollection } from './content-assets';

const DEFAULT_CONTENT_META_TYPES = [
  'Content',
  'Article',
  'ContentDocument',
  'Mirror',
  '@happyvertical/smrt-content:Content',
  '@happyvertical/smrt-content:Article',
  '@happyvertical/smrt-content:ContentDocument',
  '@happyvertical/smrt-content:Mirror',
];

function isMissingTableError(error: unknown, tableName: string): boolean {
  const message = String(
    (error as Error)?.message || error || '',
  ).toLowerCase();
  return (
    message.includes(tableName.toLowerCase()) &&
    (message.includes('no such table') ||
      message.includes('does not exist') ||
      message.includes('relation'))
  );
}

function normalizeLegacyRelationship(value: unknown): string {
  const relationship = String(value || '').trim();
  if (!relationship || relationship === 'default') {
    return 'attachment';
  }
  return relationship;
}

function normalizeSortOrder(value: unknown): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export interface BackfillContentAssetsOptions {
  db: DatabaseInterface;
  deleteLegacy?: boolean;
  dryRun?: boolean;
}

export interface BackfillContentAssetsResult {
  scanned: number;
  migrated: number;
  skipped: number;
  duplicate: number;
  missingContent: number;
  deletedLegacy: number;
}

export async function backfillContentAssetsFromAssetAssociations(
  options: BackfillContentAssetsOptions,
): Promise<BackfillContentAssetsResult> {
  const { db, deleteLegacy = false, dryRun = false } = options;
  const result: BackfillContentAssetsResult = {
    scanned: 0,
    migrated: 0,
    skipped: 0,
    duplicate: 0,
    missingContent: 0,
    deletedLegacy: 0,
  };

  const { ensureSchema } = await import(
    '@happyvertical/smrt-core/schema/utils'
  );
  await ensureSchema(db, 'ContentAsset');

  let legacyRows: any[];
  try {
    legacyRows = await db.list('asset_associations', {});
  } catch (error) {
    if (isMissingTableError(error, 'asset_associations')) {
      return result;
    }
    throw error;
  }

  const contentsRows = await db.list('contents', {});
  const contentsById = new Map(
    contentsRows
      .filter((row: any) => row?.id)
      .map((row: any) => [String(row.id), row]),
  );
  const validMetaTypes = new Set(DEFAULT_CONTENT_META_TYPES);

  for (const row of contentsRows) {
    const metaType = row?._meta_type || row?.meta_type;
    if (metaType) {
      validMetaTypes.add(String(metaType));
    }
  }

  const contentAssets = await ContentAssetCollection.create({ db });
  const existingLinks = await contentAssets.list();
  const existingLinkKeys = new Set(
    existingLinks.map(
      (link) => `${link.contentId}:${link.assetId}:${link.relationship}`,
    ),
  );

  for (const row of legacyRows) {
    const metaType = String(row?.metaType || row?.meta_type || '');
    if (!validMetaTypes.has(metaType)) {
      continue;
    }

    result.scanned += 1;

    const contentId = String(row?.metaId || row?.meta_id || '');
    const assetId = String(row?.assetId || row?.asset_id || '');
    const relationship = normalizeLegacyRelationship(row?.role);
    const sortOrder = normalizeSortOrder(row?.sortOrder ?? row?.sort_order);

    if (!contentId || !assetId) {
      result.skipped += 1;
      continue;
    }

    const contentRow = contentsById.get(contentId);
    if (!contentRow) {
      result.missingContent += 1;
      continue;
    }

    const linkKey = `${contentId}:${assetId}:${relationship}`;
    if (existingLinkKeys.has(linkKey)) {
      result.duplicate += 1;
      if (deleteLegacy && row?.id) {
        result.deletedLegacy += 1;
        if (!dryRun) {
          await db.delete('asset_associations', { id: row.id });
        }
      }
      continue;
    }

    result.migrated += 1;
    existingLinkKeys.add(linkKey);

    if (!dryRun) {
      // The migration already de-duplicates links in-memory, so a direct insert
      // keeps the backfill robust even when a legacy database only has the base
      // table shape and not the full upsert conflict index yet.
      await db.insert('content_assets', {
        id: randomUUID(),
        slug: `content-asset-${randomUUID()}`,
        context: '',
        created_at: new Date(),
        updated_at: new Date(),
        tenant_id: contentRow?.tenantId ?? contentRow?.tenant_id ?? null,
        content_id: contentId,
        asset_id: assetId,
        relationship,
        sort_order: sortOrder,
      });
    }

    if (deleteLegacy && row?.id) {
      result.deletedLegacy += 1;
      if (!dryRun) {
        await db.delete('asset_associations', { id: row.id });
      }
    }
  }

  return result;
}
