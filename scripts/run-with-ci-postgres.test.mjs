import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDatabaseName,
  databaseUrl,
} from './run-with-ci-postgres.mjs';

test('creates a safe, bounded database name with an embedded epoch', () => {
  const name = createDatabaseName({
    epoch: 1_700_000_000,
    runId: '123',
    attempt: '2',
    packageName: '@happyvertical/smrt-core',
    pid: 42,
  });

  assert.equal(
    name,
    'smrt_ci_1700000000_123_2_happyvertical_smrt_core_42',
  );
  assert.match(name, /^[a-z0-9_]+$/);
  assert.ok(name.length <= 63);
});

test('replaces only the database path in a PostgreSQL URL', () => {
  assert.equal(
    databaseUrl(
      'postgresql://ci_runner:secret@ci-postgres-rw.ci-services:5432/ci?sslmode=require',
      'smrt_ci_1_2_3_core_4',
    ),
    'postgresql://ci_runner:secret@ci-postgres-rw.ci-services:5432/smrt_ci_1_2_3_core_4?sslmode=require',
  );
});
