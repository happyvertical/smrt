// `_events` on the engine's schema-scoped database (#5291): the statement-
// scoped root `scopeDatabase` returns is a supported handle for core's change
// feed (`buildChangeEventStream`, `getChangesSince`) WITHOUT an ownership
// `fence`: a fenced handle stages every append and its drains allocate
// nothing, so nothing written through it is framed (#5570); these tests pin
// the unfenced proxy only. Registered in
// `vitest.postgres.config.ts`: it runs on an in-process PGlite everywhere and
// also on a real PostgreSQL server when `SMRT_TEST_POSTGRES_URL` is set.
//
// One pooled connection on the server, so every scoped statement and every
// unscoped check below reuses the same session.
import { randomUUID } from 'node:crypto';
import {
  appendChange,
  declareChangeFeedSensitiveTable,
  ensureChangeFeedTable,
  registerChangeFeedWriter,
  resetChangeSignals,
} from '@happyvertical/smrt-core';
import {
  buildChangeEventStream,
  resolveChangeEventStartCursor,
} from '@happyvertical/smrt-core/generators';
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { scopeDatabase } from './db/postgres.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const backends = ['pglite', ...(serverUrl ? ['postgres'] : [])] as const;
const TABLE = 'feed_scope_items';
const SECRET = 'feed_scope_secrets';
const UNENFORCED = { enforced: false, tenantId: null } as const;

/** Ordered `id:` values of the `change` frames in an SSE transcript. */
function changeIds(text: string): number[] {
  const ids: number[] = [];
  for (const block of text.split('\n\n')) {
    const match = /^id: (\d+)\nevent: change/m.exec(block);
    if (match) ids.push(Number(match[1]));
  }
  return ids;
}

async function readUntil(
  stream: ReadableStream<Uint8Array>,
  predicate: (text: string) => boolean,
  ms = 5000,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline && !predicate(text)) {
      const result = await Promise.race([
        reader.read(),
        new Promise<'timeout'>((resolve) =>
          setTimeout(
            () => resolve('timeout'),
            Math.max(1, deadline - Date.now()),
          ),
        ),
      ]);
      if (result === 'timeout' || result.done) break;
      text += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

describe.each(
  backends,
)('_events on a schema-scoped database (%s)', (backend) => {
  const tag = randomUUID().replace(/-/g, '').slice(0, 6);
  const A = `app_fs_a_${tag}`;
  const B = `app_fs_b_${tag}`;
  const D = `app_fs_d_${tag}`;
  let pglite: any;
  /** Unscoped, qualified statements: the host's view of every schema. */
  let admin: { query(sql: string): Promise<any> };
  /** The raw handle under the scope: ONE connection on the server. */
  let raw: any;
  /** A second raw handle (its own connection on the server). */
  let raw2: any;
  let a: any;
  const closers: Array<() => Promise<unknown>> = [];

  const count = async (schema: string, table: string, where = '') =>
    Number(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM "${schema}".${table} ${where}`,
        )
      ).rows[0].n,
    );
  const stage = (schema: string, table: string, rowId: string) =>
    admin.query(
      `INSERT INTO "${schema}"._smrt_changes_pending (table_name, row_id, operation, created_at) VALUES ('${table}', '${rowId}', 'update', now())`,
    );
  const unscopedPath = async () =>
    (await raw.query('SHOW search_path')).rows[0].search_path as string;

  beforeAll(async () => {
    if (backend === 'pglite') {
      const { PGlite } = await importPGlite();
      pglite = await PGlite.create();
      admin = { query: (sql) => pglite.query(sql) };
      raw = await getDatabase({ type: 'pglite', client: pglite } as any);
      raw2 = await getDatabase({ type: 'pglite', client: pglite } as any);
      closers.push(() => pglite.close());
    } else {
      const open = (max: number) =>
        getDatabase({
          type: 'postgres',
          url: serverUrl,
          max,
          idleTimeoutMillis: 0,
          cache: false,
        } as any);
      const adminDb: any = await open(2);
      admin = adminDb;
      raw = await open(1);
      raw2 = await open(1);
      closers.push(
        () => raw.close(),
        () => raw2.close(),
        () => adminDb.close(),
      );
    }
    for (const schema of [A, B, D]) {
      await admin.query(`CREATE SCHEMA "${schema}"`);
      // Provisioned in each app's own schema, through its scope.
      await ensureChangeFeedTable(scopeDatabase(raw, schema));
    }
    a = scopeDatabase(raw, A);
    declareChangeFeedSensitiveTable(SECRET);
    registerChangeFeedWriter();
  });

  beforeEach(async () => {
    resetChangeSignals();
    for (const schema of [A, B, D]) {
      await admin.query(`DELETE FROM "${schema}"._smrt_changes_pending`);
      await admin.query(`DELETE FROM "${schema}"._smrt_changes`);
    }
  });

  afterAll(async () => {
    for (const schema of [A, B, D])
      await admin
        ?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        .catch(() => {});
    for (const close of closers) await close().catch(() => {});
  });

  it("frames only its own schema's committed rows, whatever the session's default path", async () => {
    const b = scopeDatabase(raw, B);
    const d = scopeDatabase(raw, D);
    for (let i = 1; i <= 3; i++)
      await appendChange(b, { table: TABLE, rowId: `b-${i}` });
    for (let i = 1; i <= 2; i++)
      await appendChange(d, { table: TABLE, rowId: `d-${i}` });
    const seqs: number[] = [];
    for (let i = 1; i <= 2; i++)
      seqs.push(
        (await appendChange(a, { table: TABLE, rowId: `a-${i}` })) as number,
      );
    await stage(B, TABLE, 'b-staged');
    await stage(D, TABLE, 'd-staged');
    // A session default with several entries, `$user` first, naming the
    // other schemas.
    await raw.query(`SET search_path TO "$user", "${B}", "${D}"`);
    try {
      expect((await a.query('SELECT current_schema() AS s')).rows[0].s).toBe(A);
      const stream = buildChangeEventStream(a, {
        cursor: 0,
        tenantScope: UNENFORCED,
        heartbeatMs: 50,
      });
      const text = await readUntil(stream, (t) => t.includes('"a-2"'));
      // A few idle heartbeats, each with a drain.
      const later = await readUntil(stream, () => false, 300);
      await stream.cancel().catch(() => {});
      expect(text + later).not.toMatch(/"(b|d)-/);
      expect(changeIds(text + later)).toEqual(seqs);
      // The other schemas' staged and sequenced rows are untouched.
      expect(await count(B, '_smrt_changes_pending')).toBe(1);
      expect(await count(D, '_smrt_changes_pending')).toBe(1);
      expect(await count(B, '_smrt_changes')).toBe(3);
      expect(await count(D, '_smrt_changes')).toBe(2);
    } finally {
      await raw.query('RESET search_path');
    }
  });

  it('frames only the committed change when a rolled-back one held its sequence', async () => {
    const stream = buildChangeEventStream(a, {
      cursor: 0,
      tenantScope: UNENFORCED,
      heartbeatMs: 50,
    });
    await readUntil(stream, (t) => t.includes('retry:'), 2000);
    let heldSeq: unknown;
    await expect(
      scopeDatabase(raw2, A).transaction(async (tx: any) => {
        heldSeq = await appendChange(tx, {
          table: TABLE,
          rowId: 'rolled-back',
        });
        // Heartbeat reads come due while the transaction is open.
        await new Promise((resolve) => setTimeout(resolve, 200));
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    // The rolled-back append held sequence 1 (its transaction's first
    // statement allocates inline), so the committed write below reuses it.
    expect(heldSeq).toBe(1);
    const seq = (await appendChange(a, {
      table: TABLE,
      rowId: 'committed',
    })) as number;
    const text = await readUntil(stream, (t) => t.includes('"committed"'));
    await stream.cancel().catch(() => {});
    expect(seq).toBe(1);
    expect(text).not.toContain('rolled-back');
    expect(changeIds(text)).toEqual([1]);
  });

  it('leaves no setting on the pooled connection, after a stream read or a failed statement', async () => {
    const before = await unscopedPath();
    expect(before).not.toContain(A);
    await appendChange(a, { table: TABLE, rowId: 'one' });
    const stream = buildChangeEventStream(a, {
      cursor: 0,
      tenantScope: UNENFORCED,
    });
    await readUntil(stream, (t) => t.includes('"one"'));
    await stream.cancel().catch(() => {});
    expect(await unscopedPath()).toBe(before);
    await expect(
      a.query('SELECT * FROM feed_scope_missing_relation'),
    ).rejects.toThrow();
    expect(await unscopedPath()).toBe(before);
  });

  it('a temporary relation of the same name on the session never stands in for the feed', async () => {
    const seq = (await appendChange(a, {
      table: TABLE,
      rowId: 'real',
    })) as number;
    await raw.query(
      `CREATE TEMP TABLE _smrt_changes (seq BIGINT, table_name TEXT, row_id TEXT, operation TEXT, tenant_id TEXT, created_at TIMESTAMPTZ)`,
    );
    await raw.query(
      `CREATE TEMP TABLE _smrt_changes_pending (pending_id BIGINT, table_name TEXT, row_id TEXT, operation TEXT, tenant_id TEXT, created_at TIMESTAMPTZ)`,
    );
    try {
      await raw.query(
        `INSERT INTO pg_temp._smrt_changes VALUES (1, '${TABLE}', 'decoy', 'update', NULL, now()), (2, '${TABLE}', 'decoy-2', 'update', NULL, now())`,
      );
      await raw.query(
        `INSERT INTO pg_temp._smrt_changes_pending VALUES (1, '${TABLE}', 'decoy-staged', 'update', NULL, now())`,
      );
      // Both feed relations resolve to the app's schema through the scope.
      for (const rel of ['_smrt_changes', '_smrt_changes_pending'])
        expect(
          (
            await a.query(
              `SELECT n.nspname AS s FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = to_regclass('${rel}')`,
            )
          ).rows[0]?.s,
          rel,
        ).toBe(A);
      const stream = buildChangeEventStream(a, {
        cursor: 0,
        tenantScope: UNENFORCED,
        heartbeatMs: 50,
      });
      const text = await readUntil(stream, (t) => t.includes('"real"'));
      const later = await readUntil(stream, () => false, 200);
      await stream.cancel().catch(() => {});
      expect(text + later).not.toContain('decoy');
      expect(changeIds(text + later)).toEqual([seq]);
      expect(
        Number(
          (
            await raw.query(
              'SELECT count(*)::int AS n FROM pg_temp._smrt_changes',
            )
          ).rows[0].n,
        ),
      ).toBe(2);
      expect(
        Number(
          (
            await raw.query(
              'SELECT count(*)::int AS n FROM pg_temp._smrt_changes_pending',
            )
          ).rows[0].n,
        ),
      ).toBe(1);
    } finally {
      await raw.query('DROP TABLE IF EXISTS pg_temp._smrt_changes');
      await raw.query('DROP TABLE IF EXISTS pg_temp._smrt_changes_pending');
    }
  });

  it('a live-forward stream starts at the head and delivers a later commit that no signal announces', async () => {
    for (let i = 1; i <= 2; i++)
      await appendChange(a, { table: TABLE, rowId: `before-${i}` });
    // Another connection of the app. The assertions hold whether or not its
    // commits' signals reach this stream: the heartbeat read delivers them.
    const writer = scopeDatabase(raw2, A);
    // As the generated routes open it (the start fixed before the response),
    // and as a direct build without a cursor (the head sampled in start()).
    const routeStart = await resolveChangeEventStartCursor(a, null);
    expect(routeStart).toBe(2);
    for (const cursor of [routeStart, null]) {
      const stream = buildChangeEventStream(a, {
        cursor,
        tenantScope: UNENFORCED,
        heartbeatMs: 50,
      });
      const opening = await readUntil(
        stream,
        (t) => t.includes('retry:'),
        2000,
      );
      const head = Number(/^retry: 3000\nid: (\d+)\n\n/.exec(opening)?.[1]);
      const rowId = `after-open-${cursor ?? 'direct'}`;
      const seq = (await appendChange(writer, {
        table: TABLE,
        rowId,
      })) as number;
      const text = await readUntil(stream, (t) => t.includes(rowId), 3000);
      await stream.cancel().catch(() => {});
      expect(seq).toBe(head + 1);
      expect(opening + text).not.toContain('before-');
      expect(changeIds(opening + text)).toEqual([seq]);
    }
  });

  it('delivers staged work an app transaction committed, with no later writer, within a heartbeat', async () => {
    const head = (await appendChange(a, {
      table: TABLE,
      rowId: 'head',
    })) as number;
    const stream = buildChangeEventStream(a, {
      cursor: head,
      tenantScope: UNENFORCED,
      heartbeatMs: 50,
    });
    await readUntil(stream, (t) => t.includes('retry:'), 2000);
    await scopeDatabase(raw2, A).transaction(async (tx: any) => {
      await tx.query(
        `INSERT INTO _smrt_changes_pending (table_name, row_id, operation, created_at) VALUES ('${TABLE}', 'staged', 'update', now())`,
      );
    });
    const text = await readUntil(stream, (t) => t.includes('"staged"'), 2000);
    await stream.cancel().catch(() => {});
    expect(changeIds(text)).toEqual([head + 1]);
  });

  it('a staged row for a sensitive table is purged by the drain and never framed', async () => {
    const head = (await appendChange(a, {
      table: TABLE,
      rowId: 'head',
    })) as number;
    await stage(A, SECRET, 'secret-row');
    await stage(A, TABLE, 'after-secret');
    const stream = buildChangeEventStream(a, {
      cursor: head,
      tenantScope: UNENFORCED,
      heartbeatMs: 50,
    });
    const text = await readUntil(stream, (t) => t.includes('"after-secret"'));
    await stream.cancel().catch(() => {});
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('secret-row');
    expect(changeIds(text)).toEqual([head + 1]);
    // The durable feed holds no entry for it, and nothing is left staged.
    expect(
      await count(A, '_smrt_changes', `WHERE table_name = '${SECRET}'`),
    ).toBe(0);
    expect(await count(A, '_smrt_changes_pending')).toBe(0);
  });
});
