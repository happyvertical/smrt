import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';

/**
 * Seed a `_smrt_ui_preferences` row with raw SQL, bypassing the model and
 * its store-only write capability: the way corrupt or outdated storage
 * (an old release, a manual edit) reaches the store in production.
 */
export async function insertRawPreference(
  db: DatabaseInterface,
  row: {
    tenantId: string;
    kind: string;
    surfaceId: string;
    scopeType: 'tenant' | 'user';
    userId?: string | null;
    payloadJson: string;
    formatVersion?: number;
  },
): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  await db.insert('_smrt_ui_preferences', {
    id,
    slug: id,
    context: '',
    created_at: now,
    updated_at: now,
    tenant_id: row.tenantId,
    kind: row.kind,
    surface_id: row.surfaceId,
    scope_type: row.scopeType,
    user_id: row.userId ?? null,
    scope_key: row.scopeType === 'user' ? row.userId : '__tenant__',
    payload_json: row.payloadJson,
    format_version: row.formatVersion ?? 1,
    updated_by: null,
  });
  return id;
}
