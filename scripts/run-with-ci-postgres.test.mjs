import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    'postgresql://ci_runner:secret%20value@authority-host:5433/smrt_ci_1' +
    '?host=query-host&port=6543&sslmode=verify-full&application_name=smrt%20ci';
  const environment = databaseEnvironment(url, {
    KEEP_ME: 'yes',
    PGDATABASE: 'old-database',
  });

  assert.equal(environment.KEEP_ME, 'yes');
  assert.equal(environment.DATABASE_URL, url);
  assert.equal(environment.TEST_DB_URL, url);
  assert.equal(environment.TEST_DB_ADAPTER, 'postgres');
  assert.equal(environment.SMRT_TEST_POSTGRES_URL, url);
  assert.equal(environment.PGHOST, 'query-host');
  assert.equal(environment.PGPORT, '6543');
  assert.equal(environment.PGUSER, 'ci_runner');
  assert.equal(environment.PGPASSWORD, 'secret value');
  assert.equal(environment.PGDATABASE, 'smrt_ci_1');
  assert.equal(environment.PGSSLMODE, 'verify-full');
  assert.equal(environment.PGAPPNAME, 'smrt ci');
});

test('exports a privileged URL only when one is supplied', () => {
  const url = 'postgresql://smrt_ci:secret@db:5432/smrt_ci_1';
  assert.equal(
    databaseEnvironment(url, {}).SMRT_TEST_POSTGRES_ADMIN_URL,
    url,
  );
  const admin = 'postgresql://postgres:secret@db:5432/smrt_ci_1';
  const environment = databaseEnvironment(url, {}, true, admin);
  assert.equal(environment.SMRT_TEST_POSTGRES_ADMIN_URL, admin);
  // libpq clients and every SMRT URL still connect as the unprivileged role.
  assert.equal(environment.DATABASE_URL, url);
  assert.equal(environment.PGUSER, 'smrt_ci');
});

test('builds the vitest PostgreSQL lane manifest fixtures through Turbo', () => {
  const turbo = JSON.parse(
    readFileSync(new URL('../turbo.json', import.meta.url), 'utf8'),
  );

  assert.deepEqual(
    turbo.tasks['@happyvertical/smrt-vitest#test:postgres'].dependsOn,
    [
      'build',
      'generate:test',
      '@happyvertical/smrt-commerce#build',
      '@happyvertical/smrt-marketing#build',
    ],
  );
});
