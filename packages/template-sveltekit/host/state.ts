/** Local host persistence. Cookbook publication and its audit share one SQLite transaction. */
import {
  type CookbookEngine,
  createCookbookEngine,
  type EngineState,
} from '@happyvertical/smrt-core/cookbook/engine';
import type { CookbookToolOptions } from '@happyvertical/smrt-core/cookbook/tools';
import { notifyRuntimeExposureChanged } from '@happyvertical/smrt-core/runtime-exposure';
import type { InferenceEngineId } from '@happyvertical/smrt-inference/server';
import type { Cookbook } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';

const TABLE = '_smrt_cookbook_host';
const AUDIT = '_smrt_cookbook_host_audit';

/** Host system schema only; application models still require ordinary migrations. */
export async function createCookbookHostState(
  db: DatabaseInterface,
  catalog: CookbookToolOptions['catalog'],
  cookbook: Cookbook,
) {
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${TABLE} (tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY (tenant_id, user_id))`,
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS ${AUDIT} (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, event TEXT NOT NULL)`,
  );
  const engines = new Map<string, CookbookEngine>();
  const initial = createCookbookEngine({ catalog, cookbook }).state();
  const audit = async (event: unknown, tenantId: string, executor = db) => {
    await executor.query(
      `INSERT INTO ${AUDIT} (tenant_id, event) VALUES (?, ?)`,
      tenantId,
      JSON.stringify(event),
    );
  };
  async function refresh(tenantId: string) {
    try {
      await db.query(
        `INSERT INTO ${TABLE} (tenant_id, user_id, state) VALUES (?, '', ?) ON CONFLICT DO NOTHING`,
        tenantId,
        JSON.stringify(initial),
      );
      const row = (
        await db.query(
          `SELECT state FROM ${TABLE} WHERE tenant_id = ? AND user_id = ''`,
          tenantId,
        )
      ).rows[0];
      if (!row) throw new Error('Cookbook state unavailable');
      const saved = JSON.parse(String(row.state)) as EngineState;
      if (
        JSON.stringify(engines.get(tenantId)?.state()) !== JSON.stringify(saved)
      ) {
        engines.set(tenantId, createCookbookEngine({ catalog, state: saved }));
        notifyRuntimeExposureChanged();
      }
    } catch (error) {
      engines.delete(tenantId);
      notifyRuntimeExposureChanged();
      throw error;
    }
  }
  return {
    refresh,
    engineFor: ({ tenantId }: { tenantId?: string | null }) =>
      tenantId ? engines.get(tenantId) : undefined,
    async commit(change: Parameters<CookbookToolOptions['commit']>[0]) {
      const tenantId = change.context.tenantId;
      if (!tenantId || !db.transaction)
        throw new Error(
          'Local cookbook needs a tenant and SQLite transactions',
        );
      await db.transaction(async (tx) => {
        const changed = await tx.query(
          `UPDATE ${TABLE} SET state = ? WHERE tenant_id = ? AND user_id = '' AND state = ? RETURNING tenant_id`,
          JSON.stringify(change.after),
          tenantId,
          JSON.stringify(change.before),
        );
        if (changed.rows.length !== 1)
          throw new Error('Cookbook changed; refresh and try again');
        await audit(change.audit, tenantId, tx);
      });
      await refresh(tenantId);
    },
    async audit(event: Parameters<CookbookToolOptions['audit']>[0]) {
      if (event.context.tenantId) await audit(event, event.context.tenantId);
    },
    async engine(
      tenantId: string,
      userId: string,
    ): Promise<InferenceEngineId | null> {
      const row = (
        await db.query(
          `SELECT state FROM ${TABLE} WHERE tenant_id = ? AND user_id = ?`,
          tenantId,
          userId,
        )
      ).rows[0];
      if (!row) return null;
      const saved = JSON.parse(String(row.state));
      if (!['api', 'chatgpt', 'claude-code', 'codex'].includes(saved.engine))
        throw new Error('Invalid saved engine');
      return saved.engine;
    },
    async select(tenantId: string, userId: string, engine: InferenceEngineId) {
      if (
        !userId ||
        !['api', 'chatgpt', 'claude-code', 'codex'].includes(engine)
      )
        throw new Error('Invalid engine');
      await db.query(
        `INSERT INTO ${TABLE} (tenant_id, user_id, state) VALUES (?, ?, ?) ON CONFLICT(tenant_id, user_id) DO UPDATE SET state = excluded.state`,
        tenantId,
        userId,
        JSON.stringify({ engine }),
      );
    },
  };
}
