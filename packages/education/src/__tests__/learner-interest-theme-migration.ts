import {
  getSQLFromDiff,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import {
  createMigrationDefinition,
  MigrationGenerator,
  MigrationTracker,
} from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { LearnerService } from '../learner-service.js';
import { learnerFixture } from './learner-workflows.js';

/**
 * A populated pre-theme learners table gains the two interest-theme columns and
 * the change table through the canonical additive manifest diff, keeping every
 * existing row and answering as "no theme" before and after.
 */
export async function assertLearnerInterestThemeMigration(
  db: DatabaseInterface,
  engine: 'sqlite' | 'postgres',
) {
  const f = await learnerFixture(db);
  const learners = ObjectRegistry.getSchema('Learner');
  const changes = ObjectRegistry.getSchema('LearnerInterestThemeChange');
  if (!learners || !changes) throw new Error('Missing theme schemas');
  // Synthetic pre-theme deployment: no columns and no change table.
  await db.query(`DROP TABLE "${changes.tableName}"`);
  for (const column of ['interest_theme_label', 'interest_theme_key'])
    await db.query(
      `ALTER TABLE "${learners.tableName}" DROP COLUMN "${column}"`,
    );
  const before = await db.list('learners', {});
  expect(before.length).toBeGreaterThan(0);
  expect('interest_theme_label' in before[0]).toBe(false);
  const diff = await new SchemaComparer(db, { engineHint: engine }).compare({
    [learners.tableName]: learners,
    [changes.tableName]: changes,
  });
  expect(diff.added_tables.map((table) => table.tableName)).toEqual([
    changes.tableName,
  ]);
  expect(
    diff.changes
      .filter((change) => change.type === 'add_column')
      .map((change) => [change.table, change.name])
      .sort(),
  ).toEqual([
    [learners.tableName, 'interest_theme_key'],
    [learners.tableName, 'interest_theme_label'],
  ]);
  const generated = new MigrationGenerator({ engine }).generateFromDiff(diff, {
    name: 'learner_interest_theme',
  });
  const migration = createMigrationDefinition(
    '20261103_learner_interest_theme',
    generated.up,
    generated.down,
    { packageName: '@happyvertical/smrt-education', version: '0.57.51' },
  );
  const applied = await new MigrationTracker({
    db,
    engineHint: engine,
    useConcurrentIndexes: false,
  }).applyAll([migration], { postgresSafe: false });
  expect(applied.every((result) => result.success)).toBe(true);
  const second = await new SchemaComparer(db, { engineHint: engine }).compare({
    [learners.tableName]: learners,
    [changes.tableName]: changes,
  });
  expect(second.added_tables).toEqual([]);
  expect(
    getSQLFromDiff(second).filter((value) => !value.startsWith('--')),
  ).toEqual([]);
  // Existing rows survive and read as "no theme".
  const after = await db.list('learners', {});
  expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
  expect(after.every((row) => !row.interest_theme_label)).toBe(true);
  const service = new LearnerService(
    db,
    ({ own, relationshipTypeId }) =>
      own || relationshipTypeId === f.guardianType.id,
    () => true,
  );
  expect(
    (await f.as(f.own, () => service.getLearner(f.own))).interestTheme,
  ).toBeNull();
  const result = await f.as(f.parent, () =>
    service.setInterestTheme({
      ...f.parent,
      theme: { label: 'Roman', key: 'roman' },
      policyBasis: 'migration',
    }),
  );
  expect(result.interestTheme).toEqual({ label: 'Roman', key: 'roman' });
  expect(
    (await f.as(f.own, () => service.getLearner(f.own))).interestTheme,
  ).toEqual({ label: 'Roman', key: 'roman' });
  expect(
    await db.list('learner_interest_theme_changes', {
      learner_id: f.learner.id,
    }),
  ).toHaveLength(1);
}
