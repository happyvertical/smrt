/**
 * Identity, artifact-path, process-record, redaction, and import-plan
 * primitives behind `smrt app` (#3371). The first cases are ported from
 * packages/template-sveltekit/__tests__/runtimeOperations.test.ts; the rest
 * cover the failure modes the template never exercised. Operation-lock,
 * writer-lease, state-custody, and readiness cases live with their
 * implementation in `@happyvertical/smrt-app-runtime`.
 */

import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as appRuntime from '@happyvertical/smrt-app-runtime';
import {
  acquireWriterLease,
  createProviderReadinessProbe,
  readActiveWriterLease,
  withOperationLock,
} from '@happyvertical/smrt-app-runtime';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { errorEnvelope } from '../cli.js';
import { redactSecrets } from '../errors.js';
import {
  assertExternalArtifactPath,
  prepareApplicationStateRoot,
  resolveApplicationId,
  resolveApplicationStateRoot,
  runtimeConfigurationFingerprint,
} from '../identity.js';
import {
  executeImportPlan,
  planImportTables,
  serializeExportBundle,
  validateImportBundle,
} from '../portability.js';
import {
  matchesApplicationProcess,
  readOwnedProcess,
  sendTerminationSignal,
  writeProcessRecord,
} from '../process-record.js';

const DEAD_PID = 2_147_483_647;
const INSTANCE = '0123456789abcdef0123456789abcdef';
const directories: string[] = [];

function temporary(label: string): string {
  const directory = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), `smrt-app-${label}-`)),
  );
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('managed process record', () => {
  it('treats an already-exited process as successfully terminated', () => {
    expect(
      sendTerminationSignal(123, () => {
        throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      }),
    ).toBe(false);
    expect(() =>
      sendTerminationSignal(123, () => {
        throw Object.assign(new Error('denied'), { code: 'EPERM' });
      }),
    ).toThrow('denied');
  });

  it('rejects records that do not prove application identity', () => {
    const directory = temporary('process');
    const record = join(directory, 'app.pid');
    writeProcessRecord(record, { pid: process.pid, instance: 'invalid' });
    expect(statSync(record).mode & 0o777).toBe(0o600);
    expect(readOwnedProcess(record)).toBeNull();
    expect(existsSync(record)).toBe(false);

    // A live pid whose command line is not the web launcher (pid reuse).
    writeProcessRecord(record, { pid: process.pid, instance: INSTANCE });
    expect(readOwnedProcess(record)).toBeNull();
    expect(existsSync(record)).toBe(false);

    writeProcessRecord(record, { pid: DEAD_PID, instance: INSTANCE });
    expect(readOwnedProcess(record)).toBeNull();
    expect(existsSync(record)).toBe(false);

    expect(
      matchesApplicationProcess(
        { instance: INSTANCE },
        'node other-service.mjs',
      ),
    ).toBe(false);
    expect(
      matchesApplicationProcess(
        { instance: INSTANCE },
        `node /x/bin/smrt-web.mjs --smrt-instance=${INSTANCE}`,
      ),
    ).toBe(true);
    // The template's launcher path keeps matching, so an app started before
    // the switch to `smrt app` can still be stopped by it.
    expect(
      matchesApplicationProcess(
        { instance: INSTANCE },
        `node scripts/smrt-web.mjs --smrt-instance=${INSTANCE}`,
      ),
    ).toBe(true);
  });
});

describe('application identity and state custody', () => {
  it('uses app-runtime as the single identity implementation (golden vectors)', () => {
    // One implementation, not two copies kept in step: the web health route
    // and `smrt app start` compare these values byte for byte.
    expect(resolveApplicationId).toBe(appRuntime.resolveApplicationId);
    expect(runtimeConfigurationFingerprint).toBe(
      appRuntime.runtimeConfigurationFingerprint,
    );
    // Same vectors as app-runtime's sveltekit.test.ts, computed with the
    // template's former scripts/smrt-runtime-identity.mjs.
    const runtime = {
      profile: 'local',
      providers: {
        database: { provider: 'sqlite' },
        jobs: { topology: 'embedded' },
      },
    };
    expect(
      runtimeConfigurationFingerprint(runtime, {
        DATABASE_URL:
          'postgres://user:secret@db.example:5432/app?sslmode=require&password=x#frag',
        HOST: '127.0.0.1',
        PORT: '5173',
        ORIGIN: 'http://127.0.0.1:5173/',
        SMRT_BACKGROUND_JOBS: 'true',
        SMRT_MCP_SCOPES: 'read',
      }),
    ).toBe('1082a7948f012507750cd6811e66a314cc88c5071d1ee2401fd544e3768aa4ba');
    expect(runtimeConfigurationFingerprint(runtime, {})).toBe(
      '2823bad362649569b8ef2bf2f8a66e349e510875fe7a0c2fc5831c995bf4a987',
    );
    expect(resolveApplicationId({ packageName: '@acme/My App' })).toBe(
      'acme-my-app-1e1f533d66',
    );
  });

  it('uses one package-derived application identity by default', () => {
    const directory = temporary('identity');
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: '@smrt-app/My Project' }),
    );
    expect(resolveApplicationId({ sourceRoot: directory })).toMatch(
      /^smrt-app-my-project-[a-f0-9]{10}$/,
    );
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ name: '@smrt-app/My_Project' }),
    );
    expect(resolveApplicationId({ sourceRoot: directory })).toMatch(
      /^[a-z0-9][a-z0-9.-]{0,62}$/,
    );
    expect(
      resolveApplicationId({
        sourceRoot: directory,
        explicitId: 'Explicit-App',
      }),
    ).toBe('explicit-app');
    expect(() =>
      resolveApplicationId({ sourceRoot: directory, explicitId: '../escape' }),
    ).toThrow();
    writeFileSync(join(directory, 'package.json'), '{}');
    expect(() => resolveApplicationId({ sourceRoot: directory })).toThrow(
      'package.json must declare a non-empty package name.',
    );
  });

  it('keeps operator-created data artifacts outside the checkout', () => {
    const directory = temporary('artifact');
    const sourceRoot = join(directory, 'source');
    const redirected = join(directory, 'redirected-source');
    mkdirSync(sourceRoot);
    symlinkSync(sourceRoot, redirected);
    expect(() =>
      assertExternalArtifactPath({
        sourceRoot,
        path: join(sourceRoot, 'backup'),
        label: 'Backup destination',
      }),
    ).toThrow('Backup destination must remain outside the source tree');
    expect(() =>
      assertExternalArtifactPath({
        sourceRoot,
        path: join(redirected, 'export.json'),
        label: 'Export destination',
      }),
    ).toThrow('Export destination must remain outside the source tree');
    expect(() =>
      assertExternalArtifactPath({
        sourceRoot,
        path: join(directory, 'outside', '..', 'source', 'nested', 'x.json'),
        label: 'Import source',
      }),
    ).toThrow('Import source must remain outside the source tree');
    expect(() =>
      assertExternalArtifactPath({ sourceRoot, path: directory }),
    ).toThrow('Artifact must remain outside the source tree');
    expect(
      assertExternalArtifactPath({
        sourceRoot,
        path: join(directory, 'external', 'export.json'),
      }),
    ).toBe(join(directory, 'external', 'export.json'));
  });

  it('fingerprints runtime configuration without coupling identity to passwords', () => {
    const runtime = {
      profile: 'self-hosted',
      providers: { database: { engine: 'postgres' } },
    };
    const base = {
      DATABASE_URL: 'postgresql://user:first@db.example/app',
      HOST: '0.0.0.0',
      PORT: '3000',
    };
    const initial = runtimeConfigurationFingerprint(runtime, base);
    expect(
      runtimeConfigurationFingerprint(runtime, {
        ...base,
        DATABASE_URL: 'postgresql://other:second@db.example/app',
      }),
    ).toBe(initial);
    expect(
      runtimeConfigurationFingerprint(runtime, {
        ...base,
        DATABASE_URL: 'postgresql://user:second@other.example/app',
      }),
    ).not.toBe(initial);
    expect(
      runtimeConfigurationFingerprint(runtime, {
        ...base,
        ORIGIN: 'https://trusted.example',
      }),
    ).not.toBe(initial);
    expect(
      runtimeConfigurationFingerprint(runtime, {
        ...base,
        SMRT_MCP_JWKS_URI: 'https://issuer.example/keys-b.json',
      }),
    ).not.toBe(initial);
    const sslRequired = runtimeConfigurationFingerprint(runtime, {
      ...base,
      DATABASE_URL:
        'postgresql://user:first@db.example/app?sslmode=require&password=hidden',
    });
    expect(sslRequired).not.toBe(initial);
    expect(
      runtimeConfigurationFingerprint(runtime, {
        ...base,
        DATABASE_URL:
          'postgresql://other:changed@db.example/app?password=different&sslmode=require',
      }),
    ).toBe(sslRequired);
    expect(
      runtimeConfigurationFingerprint(runtime, {
        ...base,
        SMRT_AUTH_READINESS_MODULE: '@example/auth-readiness-v2',
      }),
    ).not.toBe(initial);
    expect(initial).toMatch(/^[a-f0-9]{64}$/);
    expect(initial).not.toContain('first');
  });
});

describe('secret redaction', () => {
  it('removes credentials, tokens, and secret environment values', () => {
    const message = redactSecrets(
      'connect postgresql://admin:hunter22@db.example/app failed; open http://127.0.0.1:5173/setup?token=abcDEF123456 with Bearer abcdefghijklmnop and value s3cr3t-value-123',
      {
        DATABASE_URL: 'unused',
        APP_SECRET: 's3cr3t-value-123',
        PATH: '/usr/bin',
      },
    );
    expect(message).not.toContain('hunter22');
    expect(message).not.toContain('admin');
    expect(message).not.toContain('abcDEF123456');
    expect(message).not.toContain('abcdefghijklmnop');
    expect(message).not.toContain('s3cr3t-value-123');
    expect(message).toContain('db.example/app');
  });

  it('strict mode redacts short secret values and short bearer tokens; the default keeps its floor', () => {
    const environment = { SMRT_SECRET_KEY: 'abc123', SMRT_AUTH: '', PATH: 'x' };
    const text = 'key abc123, Bearer x7k2, path x';
    expect(redactSecrets(text, environment, { strict: true })).toBe(
      'key [redacted], Bearer [redacted], path x',
    );
    // Unchanged default: an empty value is never a match, short values pass.
    expect(redactSecrets(text, environment)).toBe(text);
    // A short value that is URL syntax (Vite's BASE_URL=/) must not break the
    // userinfo pattern: patterns run before the short-value pass.
    const url = redactSecrets(
      'connect postgres://smrt:pw-must-not-print@db.internal/app',
      { BASE_URL: '/', SMRT_PORT_KEY: ':', SMRT_SECRET_KEY: 'ab' },
      { strict: true },
    );
    expect(url).not.toContain('pw-must-not-print');
    expect(url).not.toContain('smrt:');
    // Markers are never re-scanned for a shorter value.
    expect(
      redactSecrets(
        'a Bearer x',
        { SMRT_KEY: 'a', SMRT_TOKEN: 'e' },
        {
          strict: true,
        },
      ),
    ).toBe('[redacted] B[redacted]r[redacted]r [redacted]');
    // Strict never redacts less than the default.
    const long =
      'postgresql://admin:hunter22@db/app?token=abcDEF123456 Bearer abcdefghijklmnop';
    expect(redactSecrets(long, {}, { strict: true })).toBe(
      redactSecrets(long, {}),
    );
  });

  describe('structural credentials are masked before literal values (#3410 review G1/G2)', () => {
    const PASSWORD = 'pw-must-not-print';
    // The pre-fix sequential algorithm, kept only as the "never redact less
    // than today" reference for the default mode.
    function legacyDefault(
      message: string,
      environment: Record<string, string>,
    ) {
      let text = message;
      for (const value of Object.entries(environment)
        .filter(
          ([name, value]) =>
            value.length >= 8 &&
            /(?:^|_)(?:DATABASE_URL|URL|DSN|TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIALS?|AUTH)(?:_|$)/i.test(
              name,
            ),
        )
        .map(([, value]) => value)
        .sort((left, right) => right.length - left.length)) {
        text = text.replaceAll(value, '[redacted]');
      }
      return text
        .replace(
          /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]*(?::[^\s/@'"]*)?@/gi,
          '$1[redacted]@',
        )
        .replace(
          /([?&;](?:token|password|secret|key|access_token)=)[^&\s"'<>]+/gi,
          '$1[redacted]',
        )
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer [redacted]');
    }

    const cases: Array<{
      label: string;
      text: string;
      environment: Record<string, string>;
      secrets: string[];
    }> = [
      {
        label: 'G1: an env value that is a prefix of a Bearer token',
        text: 'Authorization: Bearer abcdefghXYZ123',
        environment: { SMRT_TOKEN: 'abcdefgh' },
        secrets: ['abcdefgh', 'XYZ123'],
      },
      {
        label: 'G2: an env value equal to a URL scheme and host',
        text: `connect postgres://smrt:${PASSWORD}@db/app`,
        environment: { BASE_URL: 'postgres://smrt' },
        secrets: [PASSWORD],
      },
      {
        label: 'an env value inside a query credential',
        text: 'GET /setup?token=abcdefghXYZ123&next=/',
        environment: { SMRT_TOKEN: 'abcdefgh' },
        secrets: ['abcdefgh', 'XYZ123'],
      },
      {
        label: 'an env value straddling the userinfo boundary',
        text: `postgresql://admin:${PASSWORD}@db.example/app`,
        environment: { SMRT_DSN: `${PASSWORD}@db.example` },
        secrets: ['admin', PASSWORD],
      },
      {
        label: 'a literal that exposes a host to the userinfo pattern',
        text: 'open http://host/abc/def@x and ftp://@y',
        environment: { SMRT_KEY: '/abc/def' },
        secrets: ['/abc/def', 'host'],
      },
      {
        label: 'a whole env URL still masks host and path, as before',
        text: `connect postgres://smrt:${PASSWORD}@db.internal/app failed`,
        environment: {
          DATABASE_URL: `postgres://smrt:${PASSWORD}@db.internal/app`,
        },
        secrets: [PASSWORD, 'db.internal'],
      },
    ];

    it.each(cases)('$label', ({ text, environment, secrets }) => {
      for (const strict of [false, true]) {
        const redacted = redactSecrets(text, environment, { strict });
        for (const secret of secrets) expect(redacted).not.toContain(secret);
      }
    });

    it.each(cases)('never redacts less than the previous default ($label)', ({
      text,
      environment,
    }) => {
      const legacy = legacyDefault(text, environment);
      for (const segment of redactSecrets(text, environment).split(
        '[redacted]',
      )) {
        expect(legacy).toContain(segment);
      }
    });

    it('keeps the short-value and BASE_URL=/ cases in strict mode', () => {
      const redacted = redactSecrets(
        `key abc123 at postgres://smrt:${PASSWORD}@db.internal/app with Bearer x7k2`,
        { BASE_URL: '/', SMRT_SECRET_KEY: 'abc123' },
        { strict: true },
      );
      for (const secret of ['abc123', PASSWORD, 'x7k2', 'smrt:']) {
        expect(redacted).not.toContain(secret);
      }
    });

    it('keeps the envelope claim truthful for a message carrying both shapes', () => {
      const saved = {
        SMRT_TOKEN: process.env.SMRT_TOKEN,
        BASE_URL: process.env.BASE_URL,
      };
      process.env.SMRT_TOKEN = 'abcdefgh';
      process.env.BASE_URL = 'postgres://smrt';
      try {
        const envelope = errorEnvelope(
          new Error(
            `Bearer abcdefghXYZ123 rejected by postgres://smrt:${PASSWORD}@db/app`,
          ),
        );
        expect(envelope.secretValuesIncluded).toBe(false);
        for (const secret of ['abcdefgh', 'XYZ123', PASSWORD]) {
          expect(JSON.stringify(envelope)).not.toContain(secret);
        }
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
    });
  });

  it('renders a secret-free envelope and surfaces stable runtime codes', () => {
    const failure = Object.assign(
      new Error(
        'The application migration step failed; run pnpm app:setup and inspect the private migration logs.',
      ),
      { name: 'LocalRuntimeError', code: 'migration_failed' },
    );
    expect(errorEnvelope(failure)).toEqual({
      schemaVersion: 1,
      status: 'error',
      code: 'operation-failed',
      runtimeCode: 'migration_failed',
      message: failure.message,
      recovery: 'Run pnpm app:doctor and follow its recovery instructions.',
      secretValuesIncluded: false,
    });
    expect(errorEnvelope('opaque')).toMatchObject({
      message: 'Application operation failed.',
    });
    expect(errorEnvelope(new Error('x')).runtimeCode).toBeUndefined();
  });
});

describe('import plan', () => {
  it('rejects truncated and incomplete logical exports before import', () => {
    const expected = new Map([
      ['items', { name: 'items', columns: ['id', 'title'] }],
      ['owners', { name: 'owners', columns: ['id', 'name'] }],
    ]);
    expect(() =>
      validateImportBundle(
        {
          tables: [
            {
              name: 'items',
              columns: ['id', 'title'],
              rows: [{ id: '1', title: 'Proof' }],
            },
          ],
        },
        expected,
      ),
    ).toThrow('complete application schema');
    expect(() =>
      validateImportBundle(
        {
          tables: [
            { name: 'items', columns: ['id', 'title'], rows: [{ id: '1' }] },
            { name: 'owners', columns: ['id', 'name'], rows: [] },
          ],
        },
        expected,
      ),
    ).toThrow('incomplete columns');
  });

  it('serializes lossless SQLite integers as portable decimal strings', () => {
    expect(
      JSON.parse(
        serializeExportBundle({ rows: [{ count: 9_007_199_254_740_993n }] }),
      ),
    ).toEqual({ rows: [{ count: '9007199254740993' }] });
  });

  const table = (
    name: string,
    foreignKeys: Array<{ column: string; referencesTable: string }>,
    notNull = false,
  ) => ({
    name,
    columns: ['id', ...foreignKeys.map((fk) => fk.column)],
    columnDefinitions: {
      id: { primaryKey: true, notNull: true },
      ...Object.fromEntries(
        foreignKeys.map((fk) => [
          fk.column,
          { notNull, foreignKey: { table: fk.referencesTable } },
        ]),
      ),
    },
    foreignKeys,
    primaryKeys: ['id'],
  });

  it('orders parents first and defers nullable cyclic references', () => {
    const parent = table('z_parents', []);
    const child = table('a_children', [
      { column: 'parent_id', referencesTable: 'z_parents' },
    ]);
    expect(
      planImportTables([child, parent]).map((entry) => entry.name),
    ).toEqual(['z_parents', 'a_children']);
    const cycle = planImportTables([
      table('right', [{ column: 'left_id', referencesTable: 'left' }]),
      table('left', [{ column: 'right_id', referencesTable: 'right' }]),
    ]);
    expect(cycle[0].deferredColumns.size).toBe(1);
    expect(cycle[1].deferredColumns.size).toBe(0);
  });

  it('executes parent/cycle imports and rolls failures back atomically', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    expect(db.transaction).toBeDefined();
    try {
      await db.query('PRAGMA foreign_keys = ON');
      await db.query('CREATE TABLE parents (id TEXT PRIMARY KEY)');
      await db.query(
        'CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parents(id))',
      );
      const plan = planImportTables([
        table(
          'children',
          [{ column: 'parent_id', referencesTable: 'parents' }],
          true,
        ),
        table('parents', []),
      ]);
      await db.transaction?.((tx) =>
        executeImportPlan(
          tx,
          plan,
          new Map([
            ['parents', { rows: [{ id: 'parent-1' }] }],
            ['children', { rows: [{ id: 'child-1', parent_id: 'parent-1' }] }],
          ]),
        ),
      );
      expect((await db.query('SELECT parent_id FROM children')).rows).toEqual([
        { parent_id: 'parent-1' },
      ]);
      // A non-empty target is refused rather than merged into.
      await expect(
        db.transaction?.((tx) =>
          executeImportPlan(
            tx,
            plan,
            new Map([
              ['parents', { rows: [{ id: 'parent-2' }] }],
              ['children', { rows: [] }],
            ]),
          ),
        ),
      ).rejects.toThrow('Import target table parents is not empty.');

      await db.query(
        'CREATE TABLE left_nodes (id TEXT PRIMARY KEY, right_id TEXT REFERENCES right_nodes(id))',
      );
      await db.query(
        'CREATE TABLE right_nodes (id TEXT PRIMARY KEY, left_id TEXT REFERENCES left_nodes(id))',
      );
      await db.transaction?.((tx) =>
        executeImportPlan(
          tx,
          planImportTables([
            table('right_nodes', [
              { column: 'left_id', referencesTable: 'left_nodes' },
            ]),
            table('left_nodes', [
              { column: 'right_id', referencesTable: 'right_nodes' },
            ]),
          ]),
          new Map([
            ['left_nodes', { rows: [{ id: 'left-1', right_id: 'right-1' }] }],
            ['right_nodes', { rows: [{ id: 'right-1', left_id: 'left-1' }] }],
          ]),
        ),
      );
      expect((await db.query('SELECT right_id FROM left_nodes')).rows).toEqual([
        { right_id: 'right-1' },
      ]);

      await db.query('CREATE TABLE rollback_items (id TEXT PRIMARY KEY)');
      await expect(
        db.transaction?.((tx) =>
          executeImportPlan(
            tx,
            [{ ...table('rollback_items', []), deferredColumns: new Set() }],
            new Map([
              ['rollback_items', { rows: [{ id: 'same' }, { id: 'same' }] }],
            ]),
          ),
        ),
      ).rejects.toThrow();
      expect(
        Number(
          (await db.query('SELECT COUNT(*) AS count FROM rollback_items'))
            .rows[0]?.count || 0,
        ),
      ).toBe(0);
    } finally {
      await db.close?.();
    }
  });
});
