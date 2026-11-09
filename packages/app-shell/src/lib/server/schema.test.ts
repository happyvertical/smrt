import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import '../models/index.ts';
import { prepareShellSchema } from './schema.ts';

const dir = mkdtempSync(join(tmpdir(), 'shell-schema-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// The vitest setup pre-creates registered tables in every database it opens;
// the real driver gives a truly empty one, like a first run.
async function emptyDb() {
  const actual =
    await vi.importActual<typeof import('@happyvertical/sql')>(
      '@happyvertical/sql',
    );
  return actual.getDatabase({
    type: 'sqlite',
    url: join(dir, 'shell.db'),
  } as never);
}

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
      expect.arrayContaining(['apps', 'app_versions', 'approvals']),
    );
    const wanted = Object.values(
      ObjectRegistry.getAllSchemasAsDefinitions(),
    ).map((s) => s.tableName);
    for (const t of wanted) expect(have).toContain(t);
    expect(created.length).toBe(wanted.length);
    expect(have).toContain('users');
    expect(await prepareShellSchema(db)).toEqual([]);
    expect(await tables(db)).toEqual(have);
  });
});
