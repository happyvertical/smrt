import { AssetCollection, type Asset } from '@happyvertical/smrt-assets';
import { withSystemContext } from '@happyvertical/smrt-tenancy';

// Video roles intentionally allow hyphens for legacy compatibility
// (`seed-image`, `base-motion`, `env-map`, etc.).
const VIDEO_ASSET_ROLE_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_-]*$/;
const VIDEO_ASSET_OWNER_COLUMNS = [
  'character_id',
  'performer_id',
  'scene_id',
  'video_shot_id',
  'video_sequence_id',
  'video_composition_id',
] as const;

export type VideoAssetOwnerColumn = (typeof VIDEO_ASSET_OWNER_COLUMNS)[number];

function getQueryRows(result: any): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[];
  }

  if (Array.isArray(result?.rows)) {
    return result.rows as Record<string, unknown>[];
  }

  return [];
}

function isMissingSchemaError(
  error: unknown,
  target?: string,
): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  const isMissing =
    message.includes('no such table') ||
    message.includes('no such column') ||
    message.includes('does not exist') ||
    message.includes('unknown column');

  if (!isMissing) {
    return false;
  }

  return !target || message.includes(target.toLowerCase());
}

function buildPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function uniqueAssetIds(assetIds: Iterable<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const assetId of assetIds) {
    if (!assetId || seen.has(assetId)) {
      continue;
    }

    seen.add(assetId);
    result.push(assetId);
  }

  return result;
}

export function mergeOwnedAssetIds(
  ...groups: Array<Iterable<string | null | undefined>>
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const group of groups) {
    for (const assetId of group) {
      if (!assetId || seen.has(assetId)) {
        continue;
      }

      seen.add(assetId);
      merged.push(assetId);
    }
  }

  return merged;
}

export function assertValidVideoAssetRole(role: string): void {
  if (!VIDEO_ASSET_ROLE_PATTERN.test(role)) {
    throw new Error(
      `Invalid asset role "${role}"; must start with a letter or underscore and contain only letters, digits, underscores, and hyphens`,
    );
  }
}

export function assertValidVideoAssetSortOrder(sortOrder: number): void {
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 2147483647) {
    throw new Error(
      `Invalid sortOrder "${sortOrder}"; must be a non-negative integer`,
    );
  }
}

export async function resolveOwnedAssets(
  db: any,
  tenantId: string | null | undefined,
  assetIds: Iterable<string | null | undefined>,
): Promise<Asset[]> {
  const orderedIds = uniqueAssetIds(assetIds);
  if (orderedIds.length === 0) {
    return [];
  }

  const assets = await AssetCollection.create({ db });
  let resolved: Asset[];
  try {
    resolved = tenantId
      ? await withSystemContext(async () => assets.listByIds(orderedIds))
      : await assets.listByIds(orderedIds);
  } catch (error) {
    if (isMissingSchemaError(error, 'assets')) {
      return [];
    }

    throw error;
  }

  const visibleAssets = tenantId
    ? resolved.filter(
        (asset) => asset.tenantId === tenantId || asset.tenantId === null,
      )
    : resolved;
  const assetsById = new Map(
    visibleAssets
      .filter((asset) => asset.id)
      .map((asset) => [asset.id as string, asset]),
  );

  return orderedIds
    .map((assetId) => assetsById.get(assetId))
    .filter(Boolean) as Asset[];
}

export async function listCanonicalOwnedAssetIds<T extends { assetId: string }>(
  options: {
    tableName: string;
    loadLinks: () => Promise<T[]>;
  },
): Promise<string[]> {
  try {
    return uniqueAssetIds((await options.loadLinks()).map((link) => link.assetId));
  } catch (error) {
    if (isMissingSchemaError(error, options.tableName)) {
      return [];
    }

    throw error;
  }
}

export async function listLegacyOwnedAssetIds(options: {
  db: any;
  ownerColumn: VideoAssetOwnerColumn;
  ownerId: string;
  role?: string;
  metaTypes: string[];
}): Promise<string[]> {
  const { db, ownerColumn, ownerId, role, metaTypes } = options;
  if (!ownerId || metaTypes.length === 0) {
    return [];
  }

  if (!VIDEO_ASSET_OWNER_COLUMNS.includes(ownerColumn)) {
    throw new Error(`Unsupported video asset owner column "${ownerColumn}"`);
  }

  const params: unknown[] = [ownerId, ...metaTypes];
  const clauses = [
    `${ownerColumn} = ?`,
    `_meta_type IN (${buildPlaceholders(metaTypes.length)})`,
  ];

  if (role) {
    clauses.push('role = ?');
    params.push(role);
  }

  try {
    const result = await db.query(
      `SELECT id
         FROM assets
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at ASC, id ASC`,
      ...params,
    );

    return uniqueAssetIds(
      getQueryRows(result).map((row) => String(row?.id || '')),
    );
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return [];
    }

    throw error;
  }
}

export function legacyVideoAssetMetaTypes(className: string): string[] {
  return [className, `@happyvertical/smrt-video:${className}`];
}
