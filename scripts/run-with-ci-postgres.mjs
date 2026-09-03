#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const DEFAULT_URL_FILE = '/var/run/ci-services/postgres/url';

const LIBPQ_PARAMETER_ENV = {
  application_name: 'PGAPPNAME',
  channel_binding: 'PGCHANNELBINDING',
  client_encoding: 'PGCLIENTENCODING',
  connect_timeout: 'PGCONNECT_TIMEOUT',
  dbname: 'PGDATABASE',
  gssencmode: 'PGGSSENCMODE',
  gsslib: 'PGGSSLIB',
  host: 'PGHOST',
  hostaddr: 'PGHOSTADDR',
  keepalives: 'PGKEEPALIVES',
  keepalives_count: 'PGKEEPALIVESCOUNT',
  keepalives_idle: 'PGKEEPALIVESIDLE',
  keepalives_interval: 'PGKEEPALIVESINTERVAL',
  krbsrvname: 'PGKRBSRVNAME',
  load_balance_hosts: 'PGLOADBALANCEHOSTS',
  options: 'PGOPTIONS',
  passfile: 'PGPASSFILE',
  password: 'PGPASSWORD',
  port: 'PGPORT',
  requirepeer: 'PGREQUIREPEER',
  service: 'PGSERVICE',
  servicefile: 'PGSERVICEFILE',
  sslcert: 'PGSSLCERT',
  sslcrl: 'PGSSLCRL',
  sslcrldir: 'PGSSLCRLDIR',
  sslkey: 'PGSSLKEY',
  ssl_max_protocol_version: 'PGSSLMAXPROTOCOLVERSION',
  ssl_min_protocol_version: 'PGSSLMINPROTOCOLVERSION',
  sslmode: 'PGSSLMODE',
  sslrootcert: 'PGSSLROOTCERT',
  sslsni: 'PGSSLSNI',
  target_session_attrs: 'PGTARGETSESSIONATTRS',
  tcp_user_timeout: 'PGTCPUSER_TIMEOUT',
  user: 'PGUSER',
};

export function createDatabaseName({
  epoch = Math.floor(Date.now() / 1000),
  runId = process.env.GITHUB_RUN_ID || 'local',
  attempt = process.env.GITHUB_RUN_ATTEMPT || '1',
  packageName = process.env.npm_package_name || 'package',
  pid = process.pid,
} = {}) {
  const safe = `${packageName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `smrt_ci_${epoch}_${runId}_${attempt}_${safe}_${pid}`.slice(0, 63);
}

export function databaseUrl(baseUrl, databaseName) {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

/**
 * @param testUrl the database URL the child should use.
 * @param environment base environment to extend.
 * @param managed whether this wrapper created a disposable database that it
 *   will drop afterwards. Stamped into the child environment as
 *   `CI_POSTGRES_MANAGED` so a consumer never has to re-derive the decision
 *   from `CI_POSTGRES_BASE_URL`/`CI_POSTGRES_BASE_URL_FILE` and drift from it.
 */
export function databaseEnvironment(
  testUrl,
  environment = process.env,
  managed = false,
) {
  const url = new URL(testUrl);
  const libpqEnvironment = {
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };

  for (const [parameter, value] of url.searchParams) {
    const environmentName = LIBPQ_PARAMETER_ENV[parameter];
    if (environmentName) libpqEnvironment[environmentName] = value;
  }

  return {
    ...environment,
    DATABASE_URL: testUrl,
    TEST_DB_URL: testUrl,
    TEST_DB_ADAPTER: 'postgres',
    SMRT_TEST_POSTGRES_URL: testUrl,
    CI_POSTGRES_MANAGED: managed ? '1' : '',
    ...libpqEnvironment,
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

async function resolveBaseUrl() {
  if (process.env.CI_POSTGRES_BASE_URL) {
    return { managed: true, url: process.env.CI_POSTGRES_BASE_URL };
  }

  const urlFile = process.env.CI_POSTGRES_BASE_URL_FILE || DEFAULT_URL_FILE;
  try {
    const url = readFileSync(urlFile, 'utf8').trim();
    if (url) return { managed: true, url };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (process.env.DATABASE_URL) {
    return { managed: false, url: process.env.DATABASE_URL };
  }

  throw new Error(
    `PostgreSQL tests require CI_POSTGRES_BASE_URL, ${urlFile}, or DATABASE_URL`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const separator = argv.indexOf('--');
  const commandArgs = separator === -1 ? argv : argv.slice(separator + 1);
  if (commandArgs.length === 0) {
    throw new Error('Usage: run-with-ci-postgres.mjs -- <command> [args...]');
  }

  const [command, ...args] = commandArgs;
  const base = await resolveBaseUrl();
  let testUrl = base.url;
  let databaseName;

  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::add-mask::${base.url}`);
  }

  try {
    if (base.managed) {
      databaseName = createDatabaseName();
      const createStatus = run('createdb', [
        `--maintenance-db=${base.url}`,
        databaseName,
      ]);
      if (createStatus !== 0) {
        throw new Error(`createdb failed with status ${createStatus}`);
      }
      testUrl = databaseUrl(base.url, databaseName);
    }

    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::add-mask::${testUrl}`);
    }

    const status = run(command, args, {
      env: databaseEnvironment(testUrl, process.env, base.managed),
    });
    return status;
  } finally {
    if (databaseName) {
      const dropStatus = run('dropdb', [
        '--force',
        `--maintenance-db=${base.url}`,
        databaseName,
      ]);
      if (dropStatus !== 0) {
        console.error(
          `Failed to drop ${databaseName}; the cluster janitor will remove it after six hours`,
        );
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((status) => process.exit(status))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
