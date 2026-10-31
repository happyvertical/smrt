/**
 * Consumer regression gate for #3956 (duplicate #4181): a clean
 * smrt-messages build must not make `AccountCollection` or
 * `EmailAccountCollection` independent owners of the `accounts` table its
 * `Account` / `EmailAccount` STI family owns, and `getTestDatabase({ classes })`
 * must create the requested commerce and messages schema through the real
 * DDL path even when an unrelated table-ownership collision exists elsewhere
 * in the registry.
 *
 * Packages are imported from their published dist surface (inline manifests),
 * as a consumer's test setup imports them; smrt-ledgers is loaded too because
 * it declares its own `Account` and `AccountCollection` (#3098).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  getTestDatabase,
  ObjectRegistry,
  type SmartObjectManifest,
  SmrtObject,
} from '@happyvertical/smrt-core';
import { beforeAll, describe, expect, it } from 'vitest';

const MESSAGES = '@happyvertical/smrt-messages';
const COMMERCE = '@happyvertical/smrt-commerce';
const require = createRequire(import.meta.url);

async function tableNames(classes?: string[]): Promise<string[]> {
  const db = await getTestDatabase({
    ...(classes ? { classes } : {}),
    includeSystemTables: false,
  });
  const result = await db.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return result.rows.map((row) => String(row.name));
}

describe('clean smrt-messages build: collections never own accounts (#3956)', () => {
  let commerceClasses: string[];

  beforeAll(async () => {
    await import('@happyvertical/smrt-ledgers');
    await import('@happyvertical/smrt-commerce');
    await import('@happyvertical/smrt-messages');
    commerceClasses = ObjectRegistry.getQualifiedClassNames().filter(
      (name) =>
        name.startsWith(`${COMMERCE}:`) &&
        !ObjectRegistry.isCollectionClass(name),
    );
  });

  it('classifies each account collection with its model in the built manifest', () => {
    const manifest = JSON.parse(
      readFileSync(require.resolve(`${MESSAGES}/manifest.json`), 'utf8'),
    ) as SmartObjectManifest;
    const entry = (name: string) => manifest.objects[`${MESSAGES}:${name}`];

    expect(entry('AccountCollection')?.collectionOf).toBe(
      `${MESSAGES}:Account`,
    );
    expect(entry('EmailAccountCollection')?.collectionOf).toBe(
      `${MESSAGES}:EmailAccount`,
    );
    expect(entry('Account')?.collectionOf).toBeUndefined();
    expect(entry('EmailAccount')?.collectionOf).toBeUndefined();
    // Collection metadata (routes, storage naming) is preserved.
    expect(entry('EmailAccountCollection')?.collection).toBe('accounts');
  });

  it('registers both collections as collections and keeps accounts to one family', () => {
    for (const name of ['AccountCollection', 'EmailAccountCollection']) {
      expect(ObjectRegistry.isCollectionClass(`${MESSAGES}:${name}`)).toBe(
        true,
      );
    }
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(Object.keys(schemas.accounts?.columns ?? {})).toEqual(
      expect.arrayContaining(['provider_type', 'email', 'workspace_id']),
    );
    expect(schemas.ledger_accounts).toBeDefined();
  });

  it('creates the requested commerce and messages schema through the real DDL path', async () => {
    expect(commerceClasses.length).toBeGreaterThan(0);
    const names = await tableNames([
      ...commerceClasses,
      `${MESSAGES}:Account`,
      `${MESSAGES}:EmailAccount`,
      `${MESSAGES}:AccountCollection`,
      `${MESSAGES}:EmailAccountCollection`,
    ]);
    expect(names).toContain('accounts');
    for (const className of commerceClasses) {
      const tableName = ObjectRegistry.getTableName(className);
      if (tableName) expect(names).toContain(tableName);
    }
  });

  // Last: it leaves an unrelated collision registered for the process.
  it('scopes ownership checks to the requested tables, and stays strict otherwise', async () => {
    class Clash3956A extends SmrtObject {}
    class Clash3956B extends SmrtObject {}
    ObjectRegistry.register(Clash3956A, {
      packageName: '@fixture/clash3956-a',
      tableName: 'clash_3956',
    });
    ObjectRegistry.register(Clash3956B, {
      packageName: '@fixture/clash3956-b',
      tableName: 'clash_3956',
    });
    const names = await tableNames([
      ...commerceClasses,
      `${MESSAGES}:Account`,
      `${MESSAGES}:EmailAccount`,
    ]);
    expect(names).toContain('accounts');
    expect(names).not.toContain('clash_3956');
    await expect(tableNames()).rejects.toThrow(
      /Table 'clash_3956' is claimed by unrelated classes/,
    );
    await expect(
      tableNames(['@fixture/clash3956-a:Clash3956A']),
    ).rejects.toThrow(/Table 'clash_3956' is claimed by unrelated classes/);
  });
});
