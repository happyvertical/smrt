import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getPendingSchemaStatements } from '@happyvertical/smrt-core/migrations';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserCollection } from '../collections/UserCollection.js';

// Runs against SQLite locally and PostgreSQL when DATABASE_URL is supplied.
describe('ordinary username persistence', () => {
  let isolated: IsolatedTestDbResult | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('allows absent usernames and atomically rejects canonical collisions across concurrent writes', async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['User'],
    });
    // Use the base executor deliberately: each save commits independently, so
    // the uniqueness check is exercised across concurrent autocommit writes.
    const users = await UserCollection.create({ db: isolated.baseDb });
    const suffix = randomUUID();
    const records = await Promise.all(
      [0, 1, 2, 3].map(() => users.create({ id: randomUUID() })),
    );
    records[2].username = `Learner-${suffix}`;
    records[3].username = ` LEARNER-${suffix} `;
    try {
      await records[0].save();
      await records[1].save();
      expect(records[0].usernameKey).toBeNull();
      expect(records[1].usernameKey).toBeNull();
      const outcomes = await Promise.allSettled(
        records.slice(2).map((user) => user.save()),
      );
      expect(
        outcomes.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      expect(
        outcomes.filter((result) => result.status === 'rejected'),
      ).toHaveLength(1);
      const matches = await users.list({
        where: { usernameKey: `learner-${suffix}` },
      });
      expect(matches).toHaveLength(1);
      expect(matches[0].emailKey).toBeNull();
      expect(matches[0].username).toBe(`learner-${suffix}`);
    } finally {
      for (const record of records)
        await isolated.baseDb.query(
          'DELETE FROM users WHERE id = ?',
          record.id,
        );
    }
  });

  it('persists canonical username keys and nullable identities on DuckDB', async () => {
    const db = await getDatabase({ type: 'duckdb', url: ':memory:' });
    try {
      const ddl = ObjectRegistry.getSchemaDDL('User', 'duckdb');
      if (!ddl) throw new Error('missing DuckDB User schema');
      await db.query(ddl);
      const users = await UserCollection.create({ db });
      const first = await users.create({ username: 'Duck.Learner' });
      expect(first.usernameKey).toBe('duck.learner');
      await expect(
        users.create({ username: ' DUCK.LEARNER ' }),
      ).rejects.toThrow();
      const absent = await users.create({});
      const secondAbsent = await users.create({});
      expect(absent.usernameKey).toBeNull();
      expect(secondAbsent.usernameKey).toBeNull();
      await verifyMigration(db, 'duckdb');
    } finally {
      await db.close?.();
    }
  });

  it('upgrades existing users with nullable username columns idempotently without inventing identities', async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['User'],
    });
    const db = isolated.baseDb;
    await verifyMigration(db, isolated.config.type);
  });
});

async function verifyMigration(
  db: DatabaseInterface,
  engine: 'sqlite' | 'postgres' | 'duckdb',
) {
  const schema = ObjectRegistry.getSchema('User');
  if (!schema) throw new Error('missing User schema');
  const tableName = `username_migration_${randomUUID().replaceAll('-', '')}`;
  const target = { ...schema, tableName, indexes: [] };
  const ddl = ObjectRegistry.getSchemaDDL('User', engine);
  if (!ddl) throw new Error('missing User DDL');
  const legacyDdl = ddl
    .replaceAll('"users"', `"${tableName}"`)
    .split('\n')
    .filter(
      (line) =>
        !line.includes('"username"') && !line.includes('"username_key"'),
    )
    .join('\n');
  await db.query(legacyDdl);
  const id = randomUUID();
  try {
    await db.query(
      `INSERT INTO "${tableName}" (id, slug, email) VALUES (?, ?, ?)`,
      id,
      id,
      'legacy@example.com',
    );
    vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
      [tableName]: target,
    });
    const pending = await getPendingSchemaStatements(db, {
      engineHint: engine,
    });
    expect(pending.statements.join('\n')).toContain('username_key');
    for (const statement of pending.statements) await db.query(statement);
    const restored = await db.query(
      `SELECT email, username, username_key FROM "${tableName}" WHERE id = ?`,
      id,
    );
    expect(restored.rows[0]).toEqual({
      email: 'legacy@example.com',
      username: null,
      username_key: null,
    });
    const again = await getPendingSchemaStatements(db, {
      engineHint: engine,
    });
    expect(again.statements.filter((sql) => sql.includes('username'))).toEqual(
      [],
    );
  } finally {
    await db.query(`DROP TABLE "${tableName}"`);
  }
}
