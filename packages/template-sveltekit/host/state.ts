/** Local host persistence. Cookbook publication and its audit share one SQLite transaction. */
import { randomUUID } from 'node:crypto';
import {
  type CookbookEngine,
  coveredModels,
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
    async enabledModelUnion(
      historyFor?: (tenantId: string) => Promise<Cookbook | undefined>,
    ) {
      const rows = (
        await db.query(
          `SELECT tenant_id, state FROM ${TABLE} WHERE user_id = ''`,
        )
      ).rows;
      const documents = rows.length
        ? await Promise.all(
            rows.map(
              async (r) =>
                (await historyFor?.(String(r.tenant_id))) ??
                (JSON.parse(String(r.state)) as EngineState).cookbook,
            ),
          )
        : [cookbook];
      return [
        ...new Set(
          documents.flatMap((doc) => {
            const custom = new Set(
              Object.keys(doc.models?.lists ?? {}).map(
                (name) => `${doc.models!.packageName}:${name}`,
              ),
            );
            return [...coveredModels(catalog, doc)].filter(
              (id) => !custom.has(id),
            );
          }),
        ),
      ];
    },
    async publishModels(
      tenantId: string,
      document: Cookbook,
      revision: number,
    ) {
      const before = engines.get(tenantId)?.state();
      if (!before) throw new Error('Cookbook unavailable');
      const changed =
        JSON.stringify(before.cookbook) !== JSON.stringify(document);
      const nextRevision = Math.max(
        before.revision + (changed ? 1 : 0),
        revision,
      );
      if (!changed && before.revision === nextRevision) return;
      const after = createCookbookEngine({
        catalog,
        cookbook: document,
      }).state();
      after.revision = nextRevision;
      await this.commit({
        context: { surface: 'assistant', tenantId },
        before,
        after,
        audit: {
          context: { surface: 'assistant', tenantId },
          tool: 'cookbook.apply',
          outcome: 'changed',
          summary: 'Published app model definitions.',
        },
      });
    },
    engineFor: ({ tenantId }: { tenantId?: string | null }) =>
      tenantId ? engines.get(tenantId) : undefined,
    async commit(change: Parameters<CookbookToolOptions['commit']>[0]) {
      const tenantId = change.context.tenantId;
      if (!tenantId || !db.transaction)
        throw new Error(
          'Local cookbook needs a tenant and SQLite transactions',
        );
      await db.transaction(async (tx) => {
        const row = (
          await tx.query(
            `SELECT state FROM ${TABLE} WHERE tenant_id = ? AND user_id = ''`,
            tenantId,
          )
        ).rows[0];
        // Hydration can add required recipe dependencies from the current catalog.
        // Compare logical snapshots, then CAS against the exact bytes observed.
        const raw = row && String(row.state);
        if (
          !raw ||
          JSON.stringify(
            createCookbookEngine({
              catalog,
              state: JSON.parse(raw) as EngineState,
            }).state(),
          ) !== JSON.stringify(change.before)
        )
          throw new Error('Cookbook changed; refresh and try again');
        const changed = await tx.query(
          `UPDATE ${TABLE} SET state = ? WHERE tenant_id = ? AND user_id = '' AND state = ? RETURNING tenant_id`,
          JSON.stringify(change.after),
          tenantId,
          raw,
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
    /** Persistent fallback memo; identity and connection generation are host-bound. */
    fallbackStore(tenantId: string) {
      const key = (
        ownerId: string,
        engine: string,
        requested: string,
        connection: string,
      ) =>
        `work-model:${JSON.stringify([ownerId, engine, requested, connection])}`;
      return {
        async read(
          ownerId: string,
          engine: string,
          requested: string,
          connection: string,
        ) {
          const row = (
            await db.query(
              `SELECT state FROM ${TABLE} WHERE tenant_id = ? AND user_id = ?`,
              tenantId,
              key(ownerId, engine, requested, connection),
            )
          ).rows[0];
          if (!row) return undefined;
          const saved = JSON.parse(String(row.state));
          return typeof saved.model === 'string' ? saved.model : undefined;
        },
        async write(
          ownerId: string,
          engine: string,
          requested: string,
          connection: string,
          model: string,
        ) {
          await db.query(
            `INSERT INTO ${TABLE} (tenant_id, user_id, state) VALUES (?, ?, ?) ON CONFLICT(tenant_id,user_id) DO UPDATE SET state = excluded.state`,
            tenantId,
            key(ownerId, engine, requested, connection),
            JSON.stringify({ model }),
          );
        },
      };
    },
    async engineGeneration(tenantId: string, userId: string) {
      const row = (
        await db.query(
          `SELECT state FROM ${TABLE} WHERE tenant_id = ? AND user_id = ?`,
          tenantId,
          userId,
        )
      ).rows[0];
      return row
        ? (JSON.parse(String(row.state)).generation ?? 'initial')
        : 'initial';
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
      if (saved.engine === undefined) return null;
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
        `INSERT INTO ${TABLE} (tenant_id, user_id, state) VALUES (?, ?, ?) ON CONFLICT(tenant_id, user_id) DO UPDATE SET state = json_set(${TABLE}.state, '$.engine', json_extract(excluded.state, '$.engine'))`,
        tenantId,
        userId,
        JSON.stringify({ engine, generation: randomUUID() }),
      );
    },
    async embed(tenantId: string, userId: string): Promise<boolean> {
      const row = (
        await db.query(
          `SELECT state FROM ${TABLE} WHERE tenant_id = ? AND user_id = ?`,
          tenantId,
          userId,
        )
      ).rows[0];
      const value = row ? JSON.parse(String(row.state)).embed : false;
      return value === true || value === 1;
    },
    async setEmbed(tenantId: string, userId: string, embed: boolean) {
      await db.query(
        `INSERT INTO ${TABLE} (tenant_id, user_id, state) VALUES (?, ?, ?) ON CONFLICT(tenant_id, user_id) DO UPDATE SET state = json_set(${TABLE}.state, '$.embed', json_extract(excluded.state, '$.embed'))`,
        tenantId,
        userId,
        JSON.stringify({ embed }),
      );
    },
  };
}
