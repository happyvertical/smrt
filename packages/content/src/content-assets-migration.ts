import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import './content-asset';
import { getQueryRows, isMissingTableError } from './database-utils';

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

function buildPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
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

  let contentsRows: Record<string, unknown>[];
  try {
    contentsRows = getQueryRows(
      await db.query('SELECT id, tenant_id, _meta_type FROM contents'),
    );
  } catch (error) {
    if (isMissingTableError(error, 'contents')) {
      return result;
    }
    throw error;
  }

  const validMetaTypes = new Set(DEFAULT_CONTENT_META_TYPES);
  const contentsById = new Map<string, Record<string, unknown>>();

  for (const row of contentsRows) {
    const id = row?.id ? String(row.id) : '';
    if (id) {
      contentsById.set(id, row);
    }

    const metaType = row?._meta_type || row?.meta_type;
    if (metaType) {
      validMetaTypes.add(String(metaType));
    }
  }

  let legacyRows: Record<string, unknown>[];
  try {
    const legacyMetaTypes = Array.from(validMetaTypes);
    legacyRows =
      legacyMetaTypes.length === 0
        ? []
        : getQueryRows(
            await db.query(
              `SELECT id, asset_id, meta_type, meta_id, role, sort_order
               FROM asset_associations
               WHERE meta_type IN (${buildPlaceholders(legacyMetaTypes.length)})`,
              ...legacyMetaTypes,
            ),
          );
  } catch (error) {
    if (isMissingTableError(error, 'asset_associations')) {
      return result;
    }
    throw error;
  }

  const relevantContentIds = Array.from(
    new Set(
      legacyRows
        .map((row) => String(row?.meta_id || row?.metaId || ''))
        .filter(Boolean),
    ),
  );

  const existingLinkKeys = new Set<string>();
  if (relevantContentIds.length > 0) {
    try {
      const existingLinks = getQueryRows(
        await db.query(
          `SELECT content_id, asset_id, relationship
           FROM content_assets
           WHERE content_id IN (${buildPlaceholders(relevantContentIds.length)})`,
          ...relevantContentIds,
        ),
      );

      for (const row of existingLinks) {
        existingLinkKeys.add(
          `${row.content_id}:${row.asset_id}:${row.relationship}`,
        );
      }
    } catch (error) {
      if (!isMissingTableError(error, 'content_assets')) {
        throw error;
      }
    }
  }

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
