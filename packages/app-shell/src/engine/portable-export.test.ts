// Full-fidelity export/import of app.db (#5193).
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AppHost,
  checkUserAppBundle,
  exportUserApp,
  importUserApp,
  MemoryVersionStore,
  type PortableUserApp,
  verifyUserApp,
} from './index.ts';

const root = mkdtempSync(join(tmpdir(), 'engine-portable-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const AUTHOR = { author: 't' };
const OK = { author: 't', approved: true };
let n = 0;
const dir = () => join(root, `d${n++}`);

/** v1 Chore(title, notes, secret hidden), 2 rows, then v2 removes notes (archive). */
async function build() {
  const store = new MemoryVersionStore();
  const dataDir = dir();
  const host = await AppHost.open(dataDir, { store });
  await host.execute(
    {
      type: 'defineModel',
      name: 'Chore',
      fields: {
        title: { type: 'text' },
        notes: { type: 'text' },
        secret: { type: 'text' },
      },
    },
    AUTHOR,
  );
  await host.create('Chore', { title: 'a', notes: 'note a', secret: 's-a' });
  await host.create('Chore', { title: 'b', notes: 'note b', secret: 's-b' });
  await host.execute(
    { type: 'hideField', model: 'Chore', field: 'secret' },
    AUTHOR,
  );
  await host.execute(
    { type: 'removeField', model: 'Chore', field: 'notes' },
    OK,
  );
  return { host, store, dataDir };
}

async function exportOf(store: MemoryVersionStore, dataDir: string) {
  return exportUserApp({ dataDir, versions: await store.list() });
}

/** JSON round trip, as a bundle file would. */
const viaJson = (b: PortableUserApp) => JSON.parse(JSON.stringify(b));

async function raw(dataDir: string, model: string) {
  const bundle = await exportUserApp({ dataDir, versions: [] }).catch(
    () => null,
  );
  return bundle;
}

describe('portable user app', () => {
  it('round trips hidden fields, timestamps, history and undo', async () => {
    const { host, store, dataDir } = await build();
    const bundle = await exportOf(store, dataDir);
    await host.close();

    const chore = bundle.tables.find((t) => t.name.includes('chore'));
    expect(chore?.rows).toHaveLength(2);
    expect(chore?.columns).toContain('secret');
    expect(chore?.columns).toContain('created_at');
    expect(bundle.tables.some((t) => t.name === '_archive')).toBe(true);
    expect(bundle.versions.length).toBeGreaterThanOrEqual(4);
    expect(checkUserAppBundle(viaJson(bundle))).toEqual([]);

    const target = dir();
    const result = await importUserApp({
      dataDir: target,
      bundle: viaJson(bundle),
    });
    expect(result.status).toBe('imported');
    expect(existsSync(join(target, 'snapshots'))).toBe(true);
    expect(readdirSync(root).some((f) => f.includes('.import-'))).toBe(false);

    const verified = await verifyUserApp({ dataDir: target, bundle });
    expect(verified.ok).toBe(true);
    const again = await exportUserApp({
      dataDir: target,
      versions: bundle.versions,
    });
    expect(again.digest).toBe(bundle.digest);
    expect(again.tables.find((t) => t.name.includes('chore'))?.rows).toEqual(
      chore?.rows,
    );

    // The history rides in the caller's store; undo works on the copy.
    const store2 = new MemoryVersionStore();
    for (const v of bundle.versions) await store2.append(v);
    await store2.setCurrent(bundle.version);
    const host2 = await AppHost.open(target, { store: store2 });
    const before = await host2.list('Chore');
    expect(before).toHaveLength(2);
    const undone = await host2.execute({ type: 'undo' }, OK);
    expect(undone).toBeTruthy();
    const after = await host2.list('Chore');
    expect(after.map((r: any) => r.notes).sort()).toEqual(['note a', 'note b']);
    await host2.close();
  });

  it('is idempotent: a matching target is left alone, another is refused', async () => {
    const { host, store, dataDir } = await build();
    const bundle = viaJson(await exportOf(store, dataDir));
    await host.close();
    const target = dir();
    await importUserApp({ dataDir: target, bundle });
    const second = await importUserApp({ dataDir: target, bundle });
    expect(second.status).toBe('already-imported');

    const other = await build();
    await other.host.close();
    await expect(
      importUserApp({ dataDir: other.dataDir, bundle }),
    ).rejects.toThrow(/different user app database/);
  });

  it('resumes after a crash before the swap without duplicates', async () => {
    const { host, store, dataDir } = await build();
    const bundle = viaJson(await exportOf(store, dataDir));
    await host.close();
    const target = dir();
    await expect(
      importUserApp({
        dataDir: target,
        bundle,
        onPhase: (p) => {
          if (p === 'verified') throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(existsSync(join(target, 'app.db'))).toBe(false);
    const done = await importUserApp({ dataDir: target, bundle });
    expect(done.status).toBe('imported');
    const found = await verifyUserApp({ dataDir: target, bundle });
    expect(found.ok).toBe(true);
    expect(found.tables.every((t) => t.expectedRows === t.actualRows)).toBe(
      true,
    );
  });

  it('detects a tampered bundle and a verification mismatch', async () => {
    const { host, store, dataDir } = await build();
    const bundle = viaJson(await exportOf(store, dataDir)) as PortableUserApp;
    await host.close();
    const tampered = viaJson(bundle) as PortableUserApp;
    const chore = tampered.tables.find((t) => t.name.includes('chore'));
    (chore?.rows[0] as Record<string, unknown>).title = 'changed';
    expect(checkUserAppBundle(tampered).join(' ')).toMatch(/digest/);
    await expect(
      importUserApp({ dataDir: dir(), bundle: tampered }),
    ).rejects.toThrow(/not usable/);

    // A copy that drifted from the bundle fails verification.
    const target = dir();
    await importUserApp({ dataDir: target, bundle });
    const drifted = viaJson(bundle) as PortableUserApp;
    const t = drifted.tables.find((x) => x.name.includes('chore'));
    (t?.rows[0] as Record<string, unknown>).title = 'drift';
    t!.digest = 'x';
    const result = await verifyUserApp({ dataDir: target, bundle: drifted });
    expect(result.ok).toBe(false);
    expect(result.tables.find((x) => x.name === t?.name)?.digestMatches).toBe(
      false,
    );
  });

  it('refuses table definitions that were changed or are not one statement', async () => {
    const { host, store, dataDir } = await build();
    const bundle = viaJson(await exportOf(store, dataDir)) as PortableUserApp;
    await host.close();
    const chore = (b: PortableUserApp) =>
      b.tables.find((t) => t.name.includes('chore'));

    const injected = viaJson(bundle) as PortableUserApp;
    chore(injected)!.createSql += '; DROP TABLE _archive';
    expect(checkUserAppBundle(injected).join(' ')).toMatch(/not usable/);

    const renamed = viaJson(bundle) as PortableUserApp;
    chore(renamed)!.createSql = chore(renamed)!.createSql.replace(
      /CREATE TABLE "?\w+"?/i,
      'CREATE TABLE other',
    );
    expect(checkUserAppBundle(renamed).join(' ')).toMatch(/not usable/);

    const edited = viaJson(bundle) as PortableUserApp;
    chore(edited)!.createSql = chore(edited)!.createSql.replace(
      /\)\s*$/,
      ', extra TEXT)',
    );
    expect(checkUserAppBundle(edited).join(' ')).toMatch(/definitions/);
    await expect(
      importUserApp({ dataDir: dir(), bundle: edited }),
    ).rejects.toThrow(/not usable/);
  });

  it('refuses a history that does not hold the current definition', async () => {
    const { host, store, dataDir } = await build();
    await host.close();
    const versions = (await store.list()).filter((v) => v.version === 0);
    await expect(exportUserApp({ dataDir, versions })).rejects.toThrow(
      /current version/,
    );
    void raw;
  });
});
