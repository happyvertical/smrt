import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDatabaseName,
  databaseEnvironment,
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

test('exports the isolated URL for SMRT and libpq clients', () => {
  const url =
    'postgresql://ci_runner:secret%20value@ci-postgres-rw:5433/smrt_ci_1';
  const environment = databaseEnvironment(url, {
    KEEP_ME: 'yes',
    PGDATABASE: 'old-database',
  });

  assert.equal(environment.KEEP_ME, 'yes');
  assert.equal(environment.DATABASE_URL, url);
  assert.equal(environment.TEST_DB_URL, url);
  assert.equal(environment.TEST_DB_ADAPTER, 'postgres');
  assert.equal(environment.SMRT_TEST_POSTGRES_URL, url);
  assert.equal(environment.PGHOST, 'ci-postgres-rw');
  assert.equal(environment.PGPORT, '5433');
  assert.equal(environment.PGUSER, 'ci_runner');
  assert.equal(environment.PGPASSWORD, 'secret value');
  assert.equal(environment.PGDATABASE, 'smrt_ci_1');
});
