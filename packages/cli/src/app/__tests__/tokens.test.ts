/**
 * `smrt app token` (#3413) end to end in-process against a real local
 * application: real storage custody, a real claimed owner, and the real
 * `openLocalMcpTokenStore` the command uses.
 */

import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  initializeLocalApplicationRuntime,
  LOCAL_MCP_TOKEN_TABLE,
} from '@happyvertical/smrt-app-runtime';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  DEFAULT_ROLE_SLUGS,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
} from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAppCommand } from '../cli.js';
import { parseTokenLifetime } from '../tokens.js';

const ENV_KEYS = ['SMRT_DATA_DIR', 'XDG_STATE_HOME', 'SMRT_APP_ID'] as const;
const saved: Record<string, string | undefined> = {};
const roots: string[] = [];
const lockPaths: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const lockPath of lockPaths.splice(0)) {
    for (const suffix of ['', '-journal', '-shm', '-wal']) {
      rmSync(`${lockPath}${suffix}`, { force: true });
    }
    try {
      rmdirSync(dirname(lockPath));
    } catch {
      // Shared or already removed.
    }
  }
});

/** A set-up local app whose owner holds `notes.read`. */
async function ownedApplication(profile: 'local' | 'cloud' = 'local') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-app-token-')));
  roots.push(root);
  const app = join(root, 'app');
  const data = join(root, 'data');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'tok-app' }));
  process.env.SMRT_DATA_DIR = data;
  process.env.XDG_STATE_HOME = join(root, 'state-home');
  delete process.env.SMRT_APP_ID;
  const identity = platform() === 'darwin' ? data.toLowerCase() : data;
  lockPaths.push(
    join(
      realpathSync('/tmp'),
      `.smrt-${process.getuid?.()}`,
      createHash('sha256').update(identity).digest('hex').slice(0, 32),
      'initialization.sqlite',
    ),
  );

  const { runtime } = await initializeLocalApplicationRuntime({
    appId: 'tok-app',
    dataDirectory: data,
    sourceRoot: app,
    bindHost: '127.0.0.1',
    // Stands in for `smrt db:migrate`: the registered framework schema.
    prepareDatabase: async (db) => {
      await getTestDatabase({ db });
    },
  });
  const invitation = await runtime.rotateBootstrapInvitation();
  await runtime.claimOwner({
    token: invitation.token,
    name: 'Owner',
    email: 'owner@example.test',
  });
  const roles = await RoleCollection.create({ db: runtime.db });
  const owner = await roles.findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
  const permissions = await PermissionCollection.create({ db: runtime.db });
  const read = await permissions.findOrCreate('notes.read', {
    name: 'notes.read',
  });
  await (
    await RolePermissionCollection.create({ db: runtime.db })
  ).addPermission(owner?.id as string, read.id as string);

  const output = { stdout: [] as string[], stderr: [] as string[] };
  const run = async (argv: string[]) => {
    output.stdout.length = 0;
    output.stderr.length = 0;
    const code = await runAppCommand(['token', ...argv], {
      cwd: app,
      io: {
        stdout: (text) => output.stdout.push(text),
        stderr: (text) => output.stderr.push(text),
      },
      dependencies: {
        resolveRuntime: async () =>
          resolveApplicationRuntime({ profile }) as never,
      },
    });
    return {
      code,
      stdout: output.stdout.join(''),
      stderr: output.stderr.join(''),
    };
  };
  return { runtime, run };
}

describe('smrt app token', () => {
  it('issues once, lists without secrets, verifies, and revokes', async () => {
    const { runtime, run } = await ownedApplication();
    const issued = await run([
      '--scopes',
      'notes.read',
      '--expires',
      '2h',
      '--label',
      'Claude Desktop',
    ]);
    expect(issued.code).toBe(0);
    expect(issued.stderr).toBe('');
    const document = JSON.parse(issued.stdout) as Record<string, unknown>;
    expect(document).toMatchObject({
      schemaVersion: 1,
      status: 'issued',
      scopes: ['notes.read'],
      label: 'Claude Desktop',
      secretValuesIncluded: true,
    });
    const token = String(document.token);
    expect(token).toMatch(/^smrt_mcp_[A-Za-z0-9_-]{43}$/);
    expect(
      Date.parse(String(document.expiresAt)) -
        Date.parse(String(document.createdAt)),
    ).toBe(2 * 60 * 60 * 1000);
    const rows = await runtime.db.query(
      `SELECT * FROM ${LOCAL_MCP_TOKEN_TABLE}`,
    );
    expect(JSON.stringify(rows.rows)).not.toContain(token);

    expect(await runtime.mcpTokens?.verify(token)).toMatchObject({
      scopes: ['notes.read'],
    });

    const listed = await run(['list']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).not.toContain(token);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      status: 'ok',
      secretValuesIncluded: false,
      tokens: [{ id: document.id, status: 'active', label: 'Claude Desktop' }],
    });

    const revoked = await run(['revoke', String(document.id)]);
    expect(revoked.code).toBe(0);
    expect(JSON.parse(revoked.stdout)).toMatchObject({
      status: 'revoked',
      id: document.id,
      secretValuesIncluded: false,
    });
    expect(await runtime.mcpTokens?.verify(token)).toBeNull();
    expect(
      JSON.parse((await run(['revoke', String(document.id)])).stdout),
    ).toMatchObject({ status: 'already-revoked' });
    await runtime.db.close?.();
  });

  it('refuses scopes the owner does not hold with a stable code and no token', async () => {
    const { runtime, run } = await ownedApplication();
    const failed = await run(['create', '--scopes=notes.read,notes.delete']);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe('');
    expect(JSON.parse(failed.stderr)).toMatchObject({
      status: 'error',
      runtimeCode: 'invalid_scope',
      secretValuesIncluded: false,
    });
    expect(failed.stderr).not.toMatch(/smrt_mcp_/);
    expect(
      (await runtime.db.query(`SELECT id FROM ${LOCAL_MCP_TOKEN_TABLE}`)).rows,
    ).toEqual([]);
    await runtime.db.close?.();
  });

  it.each([
    [[], 'At least one scope'],
    [['--scopes'], 'requires a value'],
    [['--scopes', 'a', '--expires', '30x'], 'Invalid --expires'],
    [['--scopes', 'a', '--bogus', '1'], 'Unknown token option'],
    [['list', 'extra'], 'takes no arguments'],
    [['revoke'], 'exactly one token id'],
    [['rotate'], 'Unknown token operation'],
  ])('rejects usage %j before touching state', async (argv, message) => {
    const { runtime, run } = await ownedApplication();
    const failed = await run(argv);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr).message).toContain(message);
    await runtime.db.close?.();
  });

  it('is local-profile only', async () => {
    const { runtime, run } = await ownedApplication('cloud');
    const failed = await run(['list']);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr).message).toContain('local-profile only');
    await runtime.db.close?.();
  });

  it('parses lifetimes', () => {
    expect(parseTokenLifetime('30d')).toBe(30 * 24 * 60 * 60);
    expect(parseTokenLifetime('12h')).toBe(12 * 60 * 60);
    expect(parseTokenLifetime('90m')).toBe(90 * 60);
    expect(parseTokenLifetime('3600')).toBe(3600);
    for (const value of ['0d', '-1d', '1.5d', 'd', '1w']) {
      expect(() => parseTokenLifetime(value)).toThrow('Invalid --expires');
    }
  });
});
