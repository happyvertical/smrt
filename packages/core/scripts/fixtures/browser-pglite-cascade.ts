import * as core from '../../dist/browser.js';
import { usesPostgresDialect } from '../../dist/embedded-write-queue.js';
import { getDatabase } from '../../dist/host.browser.js';

const { SmrtObject, smrt } = core;

// Exercise the complete model delete through the SDK's PGlite transaction.
@smrt()
class BrowserCascadeParent extends SmrtObject {}

@smrt()
class BrowserCascadeChild extends SmrtObject {
  @core.foreignKey(BrowserCascadeParent, { onDelete: 'SET NULL' })
  parentId;
}

export async function runPgliteCascade(dataDir: string): Promise<void> {
  const db = await getDatabase({ type: 'pglite', dataDir });
  try {
    const assertEmbeddedPostgres = (handle: typeof db) => {
      if (
        handle.url !== dataDir ||
        !usesPostgresDialect(handle) ||
        !core.isEmbeddedDatabase(handle) ||
        core.isPostgresDatabase(handle)
      ) {
        throw new Error(
          'PGlite handle must use PostgreSQL syntax as an embedded database',
        );
      }
    };
    assertEmbeddedPostgres(db);
    await db.transaction(async (tx) => assertEmbeddedPostgres(tx));
    await core.ensureSystemTables(db, 'postgres');
    const parent = new BrowserCascadeParent({ db, id: crypto.randomUUID() });
    const child = new BrowserCascadeChild({ db });
    const localDeviceId = crypto.randomUUID();
    const trackedId = crypto.randomUUID();
    const untrackedId = crypto.randomUUID();
    const before = new Date(Date.now() + 86_400_000).toISOString();
    core.setDatabaseSyncDeviceId(db, localDeviceId);
    await db.query(`
      CREATE TABLE ${parent.tableName} (
        id UUID PRIMARY KEY, slug TEXT NOT NULL, context TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMP NOT NULL, updated_at TIMESTAMP NOT NULL,
        _sync_origin_device_id TEXT, _sync_revision BIGINT
      );
      CREATE TABLE ${child.tableName} (
        id UUID PRIMARY KEY, updated_at TIMESTAMP NOT NULL,
        _sync_origin_device_id TEXT, _sync_revision BIGINT,
        parent_id UUID REFERENCES ${parent.tableName}(id) ON DELETE SET NULL
      );
    `);
    await db.query(
      `INSERT INTO ${parent.tableName} (id, slug, created_at, updated_at)
       VALUES ($1, 'parent', $2, $2)`,
      parent.id,
      before,
    );
    await db.query(
      `INSERT INTO ${child.tableName}
         (id, parent_id, updated_at, _sync_origin_device_id, _sync_revision)
       VALUES ($1, $2, $3, 'remote', 21), ($4, $2, $3, NULL, NULL)`,
      trackedId,
      parent.id,
      before,
      untrackedId,
    );

    await parent.initialize();
    await parent.delete();

    const { rows } = await db.query(
      `SELECT *, updated_at = $3::timestamp AS unchanged,
          updated_at = $3::timestamp + INTERVAL '1 millisecond' AS advanced
       FROM ${child.tableName} WHERE id IN ($1, $2)`,
      trackedId,
      untrackedId,
      before,
    );
    const tracked = rows.find((row) => row.id === trackedId);
    const untracked = rows.find((row) => row.id === untrackedId);
    if (await db.get(parent.tableName, { id: parent.id })) {
      throw new Error('PGlite cascade left the parent row');
    }
    if (
      tracked?.parent_id !== null ||
      tracked._sync_origin_device_id !== localDeviceId ||
      Number(tracked._sync_revision) !== 22 ||
      tracked.advanced !== true
    ) {
      throw new Error(
        'PGlite SET NULL did not advance the tracked row revision',
      );
    }
    if (
      untracked?.parent_id !== null ||
      untracked._sync_origin_device_id !== null ||
      untracked._sync_revision !== null ||
      untracked.unchanged !== true
    ) {
      throw new Error('PGlite SET NULL changed the untracked row revision');
    }
  } finally {
    await db.close?.();
  }
}
