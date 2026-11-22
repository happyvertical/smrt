import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import '@happyvertical/smrt-features';
import '@happyvertical/smrt-subscriptions';
import '../objects/index.ts';
import { hostedOnlyTables, prepareShellSchema } from './schema.ts';

const dir = mkdtempSync(join(tmpdir(), 'shell-schema-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The vitest setup pre-creates registered tables in every database it opens;
// the real driver gives a truly empty one, like a first run.
async function actualDb(file: string) {
  const actual =
    await vi.importActual<typeof import('@happyvertical/sql')>(
      '@happyvertical/sql',
    );
  return actual.getDatabase({
    type: 'sqlite',
    url: join(dir, file),
  } as never);
}
const emptyDb = () => actualDb('shell.db');

async function tables(db: Awaited<ReturnType<typeof emptyDb>>) {
  const r = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return r.rows.map((x) => String(x.name));
}

describe('prepareShellSchema', () => {
  it('creates every registered table on an empty database, then is a no-op', async () => {
    const db = await emptyDb();
    expect(await tables(db)).toEqual([]);
    const created = await prepareShellSchema(db);
    const have = await tables(db);
    expect(have).toEqual(
      expect.arrayContaining([
        'apps',
        'app_versions',
        'approvals',
        'assistant_threads',
        'assistant_messages',
      ]),
    );
    const hostedOnly = hostedOnlyTables();
    const wanted = Object.values(ObjectRegistry.getAllSchemasAsDefinitions())
      .map((s) => s.tableName)
      .filter((t) => !hostedOnly.has(t));
    for (const t of wanted) expect(have).toContain(t);
    expect(created.length).toBe(wanted.length);
    expect(have).toContain('users');
    expect(await prepareShellSchema(db)).toEqual([]);
    expect(await tables(db)).toEqual(have);
  });

  it('the desktop gets no hosted-only tables (#5194), the cloud harness does', async () => {
    const hostedOnly = hostedOnlyTables();
    // The packages are registered in this process, as the build manifest does.
    expect(hostedOnly.has('_smrt_tenant_subscriptions')).toBe(true);
    expect(hostedOnly.has('_smrt_feature_overrides')).toBe(true);
    const local = await tables(await emptyDb());
    for (const t of hostedOnly) expect(local).not.toContain(t);
    const hosted = await actualDb('shell-hosted.db');
    await prepareShellSchema(hosted, { hosted: true });
    const have = await tables(hosted);
    for (const t of hostedOnly) expect(have).toContain(t);
  });
});
