import {
  getSQLFromDiff,
  getTestDatabase,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  MigrationGenerator,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { learnerClasses, learnerFixture } from './learner-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

it('adds the tutor tables to a populated pre-tutor SQLite database with an additive diff', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [
      ...learnerClasses,
      'TutorSession',
      'TutorSessionClosure',
      'TutorExchange',
    ],
  });
  try {
    await learnerFixture(db);
    const schemas = Object.fromEntries(
      ['TutorSession', 'TutorSessionClosure', 'TutorExchange'].map((name) => {
        const schema = ObjectRegistry.getSchema(name);
        if (!schema) throw new Error(`Missing ${name} schema`);
        return [schema.tableName, schema];
      }),
    );
    const tables = Object.keys(schemas);
    for (const table of tables) await db.query(`DROP TABLE "${table}"`);
    const before = await db.list('enrollments', {});
    expect(before.length).toBeGreaterThan(0);
    const compare = () =>
      new SchemaComparer(db, { engineHint: 'sqlite' }).compare(schemas);
    const diff = await compare();
    expect(diff.added_tables.map((t) => t.tableName).sort()).toEqual(
      [...tables].sort(),
    );
    expect(diff.changes).toEqual([]);
    const generated = new MigrationGenerator({
      engine: 'sqlite',
    }).generateFromDiff(diff, { name: 'tutor_sessions' });
    const applied = await new MigrationTracker({
      db,
      engineHint: 'sqlite',
      useConcurrentIndexes: false,
    }).applyAll(
      [
        createMigrationDefinition(
          '20261102_tutor_sessions',
          generated.up,
          generated.down,
          { packageName: '@happyvertical/smrt-education', version: '0.57.48' },
        ),
      ],
      { postgresSafe: false },
    );
    expect(applied.every((r) => r.success)).toBe(true);
    const second = await compare();
    expect(second.added_tables).toEqual([]);
    expect(getSQLFromDiff(second).filter((v) => !v.startsWith('--'))).toEqual(
      [],
    );
    expect(await db.list('enrollments', {})).toEqual(before);
  } finally {
    await db.close?.();
  }
});
