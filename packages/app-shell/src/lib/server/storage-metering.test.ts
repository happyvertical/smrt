// Storage metering (#5199, storage half): one gauge row per tenant per bucket,
// cloud only, tenant from the verified context, one read for storage and the
// request-count seam. SQLite shell database, a fake size probe: no server. The
// PostgreSQL catalog query itself is in storage-metering-postgres.test.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TenantUsageMetricCollection } from '@happyvertical/smrt-subscriptions';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { AppCollection } from '../objects/App.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { appSchemaName, tenantAppDirs } from './host.ts';
import { runAs } from './owner.ts';
import { toolsFor } from './policy.ts';
import {
  type CatalogQuery,
  measureSqliteBytes,
  monthWindow,
  PG_SCHEMA_BYTES_SQL,
  REQUEST_COUNT_METRIC,
  STORAGE_BYTES_METRIC,
  StorageMeter,
  type StorageProbe,
  shellStorageProbe,
} from './storage-metering.ts';
import { APP_SLUG } from './version-store.ts';

let h: CloudHarness;
const appIds = new Map<string, string>();
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 10, 12, 0, 0);

beforeAll(async () => {
  h = await openCloudShell();
  await TenantUsageMetricCollection.create({ db: h.db }); // the migrated table
  for (const p of [h.a, h.b])
    appIds.set(
      p.tenantId,
      await runAs(p, async () => {
        const apps = await AppCollection.create({ db: h.db });
        const row = await apps.create({
          slug: APP_SLUG,
          name: 'My app',
          currentVersion: -1,
          definition: '',
        });
        await row.save();
        return row.id as string;
      }),
    );
});
afterAll(async () => {
  await h.close();
});

let clock = T0;
const meters: StorageMeter[] = [];
afterEach(() => {
  for (const m of meters.splice(0)) m.stop();
  clock = T0;
});

function meterWith(bytesOf: (tenantId: string) => number) {
  const calls: string[] = [];
  const probe: StorageProbe = {
    async measure({ tenantId }) {
      calls.push(tenantId);
      return { bytes: bytesOf(tenantId), backend: 'sqlite' };
    },
  };
  const meter = new StorageMeter({
    probe,
    intervalMs: HOUR,
    now: () => clock,
    db: async () => h.db,
  });
  meters.push(meter);
  return { meter, calls };
}

const rowsOf = async (tenantId: string) =>
  runAs({ id: 'x', tenantId }, async () =>
    (await TenantUsageMetricCollection.create({ db: h.db })).list({
      where: { tenantId, metricKey: STORAGE_BYTES_METRIC },
      limit: 100,
    }),
  );

describe('sampling', () => {
  it('writes one gauge row for the tenant, and a second sample in the same bucket adds none', async () => {
    const { meter, calls } = meterWith(() => 1000);
    expect(await meter.sample(h.a.tenantId)).toBe(true);
    clock += 5 * 60 * 1000;
    expect(await meter.sample(h.a.tenantId)).toBe(false);
    expect(calls).toEqual([h.a.tenantId]); // not even measured again
    const rows = await rowsOf(h.a.tenantId);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(1000);
    expect(rows[0].source).toBe('app-shell.storage');
    expect(rows[0].getDimensions()).toMatchObject({
      backend: 'sqlite',
      assets: 'not-measured',
    });
    // the next bucket is a new row (history), not an overwrite
    clock += HOUR;
    expect(await meter.sample(h.a.tenantId)).toBe(true);
    expect(await rowsOf(h.a.tenantId)).toHaveLength(2);
  });

  it('noteRequest samples the ambient tenant once per interval, not per request', async () => {
    const { meter, calls } = meterWith(() => 5);
    const sampled = vi.spyOn(meter, 'sample');
    clock += 10 * HOUR;
    const burst = async (p: typeof h.a) =>
      runAs(p, async () => {
        for (let i = 0; i < 20; i++) meter.noteRequest();
        await vi.waitFor(() => expect(calls.length).toBeGreaterThan(0));
      });
    await burst(h.a);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual([h.a.tenantId]);
    expect(sampled).toHaveBeenCalledTimes(1); // the throttle, not just the bucket
    // a request with no tenant context (guest, signed out) measures nothing
    meter.noteRequest();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toHaveLength(1);
    // due again after the interval: the sweep samples the tenant it saw
    clock += 2 * HOUR;
    expect(await meter.sweep()).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('records the tenant of the context only; another tenant is never sampled for it', async () => {
    const { meter, calls } = meterWith(() => 7);
    clock += 20 * HOUR;
    await runAs(h.b, async () => {
      meter.noteRequest();
      await vi.waitFor(() => expect(calls).toEqual([h.b.tenantId]));
    });
    expect((await rowsOf(h.b.tenantId)).at(-1)?.tenantId).toBe(h.b.tenantId);
  });

  it('skips quietly while the usage table has not been migrated', async () => {
    const { meter, calls } = meterWith(() => 1);
    const noTable = {
      tableExists: async () => false,
    } as unknown as DatabaseInterface;
    const bare = new StorageMeter({
      probe: { measure: async () => ({ bytes: 1, backend: 'sqlite' }) },
      now: () => clock,
      db: async () => noTable,
    });
    meters.push(bare);
    expect(await bare.sample(h.a.tenantId)).toBe(false);
    expect(calls).toEqual([]);
    void meter;
  });
});

describe('the one read', () => {
  it('returns the latest sample and the peak (never a sum), per tenant', async () => {
    const sizes = [4000, 9000, 6000];
    let i = 0;
    const { meter } = meterWith((t) => (t === h.a.tenantId ? sizes[i++] : 11));
    const base = Date.UTC(2026, 11, 3, 0, 0, 0); // a month nobody sampled yet
    for (let n = 0; n < 3; n++) {
      clock = base + n * HOUR + 59 * 60 * 1000; // measured late in its bucket
      await meter.sample(h.a.tenantId);
    }
    await meter.sample(h.b.tenantId);
    const win = monthWindow(new Date(clock));
    const a = await runAs(h.a, () => meter.read(win));
    expect(a.storage).toMatchObject({
      bytes: 6000,
      peakBytes: 9000,
      samples: 3,
      backend: 'sqlite',
    });
    const b = await runAs(h.b, () => meter.read(win));
    // the measurement time, not the bucket start
    expect(a.storage.sampledAt).toEqual(new Date(base + 2 * HOUR + 59 * 60000));
    expect(a.storage.bucketStart).toEqual(new Date(base + 2 * HOUR));
    expect(b.storage.bytes).toBe(11);
    expect(b.storage.samples).toBe(1);
    expect(b.tenantId).toBe(h.b.tenantId);
  });

  it('refuses without a tenant context, and has no tenant parameter', async () => {
    const { meter } = meterWith(() => 1);
    expect(meter.read.length).toBe(1);
    await expect(meter.read(monthWindow())).rejects.toThrow('sign in first');
  });

  it('reads the request counter: summed, unmetered until a row exists', async () => {
    const { meter } = meterWith(() => 1);
    const win = {
      start: new Date(Date.UTC(2027, 0, 1)),
      end: new Date(Date.UTC(2027, 1, 1)),
    };
    expect((await runAs(h.a, () => meter.read(win))).requests).toEqual({
      count: 0,
      metered: false,
      limited: 0,
      refused: {},
      byCallerKind: {},
    });
    await runAs(h.a, async () => {
      const metrics = await TenantUsageMetricCollection.create({ db: h.db });
      for (const [n, q] of [
        [1, 40],
        [2, 2],
      ] as const)
        await metrics.recordUsage({
          tenantId: h.a.tenantId,
          metricKey: REQUEST_COUNT_METRIC,
          quantity: q,
          windowStart: new Date(Date.UTC(2027, 0, n)),
          windowEnd: new Date(Date.UTC(2027, 0, n + 1)),
        });
    });
    expect((await runAs(h.a, () => meter.read(win))).requests).toEqual({
      count: 42,
      metered: true,
      limited: 0,
      refused: {},
      byCallerKind: { unknown: 42 },
    });
    // tenant B sees none of A's
    expect((await runAs(h.b, () => meter.read(win))).requests.count).toBe(0);
  });
});

describe('measuring', () => {
  it('SQLite: app.db plus its -wal, never opened; missing files count 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'meter-sqlite-'));
    try {
      expect(await measureSqliteBytes(dir)).toBe(0);
      writeFileSync(join(dir, 'app.db'), Buffer.alloc(4096));
      writeFileSync(join(dir, 'app.db-wal'), Buffer.alloc(1000));
      writeFileSync(join(dir, 'snapshot.db'), Buffer.alloc(99999)); // not counted
      expect(await measureSqliteBytes(dir)).toBe(5096);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('shell probe: a SQLite app is its directory; a PostgreSQL app is its derived schema, bound', async () => {
    const root = mkdtempSync(join(tmpdir(), 'meter-root-'));
    try {
      const tenant = h.a.tenantId;
      const app = appIds.get(tenant) as string;
      const query = vi.fn<CatalogQuery>(async () => [
        { bytes: '123456789012' },
      ]);
      const probe = shellStorageProbe({
        postgres: () => true,
        catalog: async () => query,
        root: async () => root,
      });
      // no app.db: PostgreSQL
      expect(await probe.measure({ tenantId: tenant, appId: app })).toEqual({
        bytes: 123456789012,
        backend: 'postgres',
      });
      expect(query).toHaveBeenCalledWith(
        PG_SCHEMA_BYTES_SQL,
        appSchemaName(tenant, app),
      );
      // an app.db in the directory: SQLite, the catalog is not asked
      const { live } = tenantAppDirs(root, tenant, app);
      mkdirSync(live, { recursive: true });
      writeFileSync(join(live, 'app.db'), Buffer.alloc(2048));
      query.mockClear();
      expect(await probe.measure({ tenantId: tenant, appId: app })).toEqual({
        bytes: 2048,
        backend: 'sqlite',
      });
      expect(query).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the catalog query counts tables and materialized views only (indexes and TOAST are inside the total)', () => {
    expect(PG_SCHEMA_BYTES_SQL).toContain("relkind IN ('r', 'm')");
    expect(PG_SCHEMA_BYTES_SQL).toContain('pg_total_relation_size');
    expect(PG_SCHEMA_BYTES_SQL).toContain('nspname = ?');
  });
});

describe('exposure', () => {
  it('no usage-metric tool or route reaches the owner through the shell', async () => {
    const names = (await runAs(h.a, () => toolsFor(h.a as never))).map(
      (t) => t.name,
    );
    expect(names.filter((n) => /usage|metric/i.test(n))).toEqual([]);
  });
});

describe('local profile', () => {
  it('records nothing and measures nothing on the local profile', async () => {
    const local = await import('./test-support.ts').then((m) => m.openShell());
    try {
      // everything a cloud sample needs is present: only the profile says no
      await TenantUsageMetricCollection.create({ db: local.db });
      await runAs(local.owner, async () => {
        const apps = await AppCollection.create({ db: local.db });
        await (
          await apps.create({
            slug: APP_SLUG,
            name: 'My app',
            currentVersion: -1,
            definition: '',
          })
        ).save();
      });
      const probe = { measure: vi.fn() } as unknown as StorageProbe;
      const meter = new StorageMeter({
        probe,
        now: () => clock,
        db: async () => local.db,
      });
      meters.push(meter);
      expect(await meter.sample(local.owner.tenantId)).toBe(false);
      expect(probe.measure).not.toHaveBeenCalled();
    } finally {
      await local.close();
    }
  });
});
