/**
 * Local MCP client credentials end to end (#3413).
 *
 * The owner mints a scoped token with the real `smrt app token` command; a
 * real MCP client then talks to the real `smrt-mcp-bridge` binary over stdio
 * (`--mcp-path=/mcp`), which forwards to an in-process HTTP server running the
 * real runtime `handle` and the overlay's route shape: `mountMcpAppRoute` with
 * `createHostedMcpResourceAuth({ profile, runtime })` and
 * `bindPrincipal: runtime.runAsPrincipal`. Storage is the local runtime's own
 * SQLite; nothing on the request path is mocked.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHostedMcpResourceAuth } from '@happyvertical/smrt-app-mcp/auth';
import { mountMcpAppRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import {
  createSmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntime,
} from '@happyvertical/smrt-app-runtime/sveltekit';
import { runAppCommand } from '@happyvertical/smrt-cli/app';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { disableTenancy, getCurrentTenant } from '@happyvertical/smrt-tenancy';
import {
  DEFAULT_ROLE_SLUGS,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Handle } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const LOCAL = resolveApplicationRuntime({ profile: 'local' });
const NOTES = 'local_mcp_e2e_notes';
const READ = 'notes.read';
const PREFIX = 'SMRT_LOCAL_MCP_E2E';

const bridgeBin = join(
  dirname(fileURLToPath(import.meta.resolve('@happyvertical/smrt-app-cli'))),
  'bin',
  'smrt-mcp-bridge.js',
);

const clock = { offsetMs: 0 };
const state = {
  root: '',
  sourceRoot: '',
  dataDirectory: '',
  lockPath: '',
  baseUrl: '',
  ownerTenant: '',
  otherTenant: '',
  roleId: '',
  readPermissionId: '',
};
let runtime: SmrtSvelteKitRuntime;
let db: DatabaseInterface;
let server: Server;
const savedEnv: Record<string, string | undefined> = {};

/** Run `smrt app token …` for the test application; returns parsed JSON. */
async function smrtAppToken(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const code = await runAppCommand(['token', ...args], {
    cwd: state.sourceRoot,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
    dependencies: { resolveRuntime: async () => LOCAL as never },
  });
  if (code !== 0) throw new Error(`smrt app token failed: ${stderr.join('')}`);
  return JSON.parse(stdout.join('')) as Record<string, unknown>;
}

/** A real stdio MCP client connected to the real bridge binary. */
async function withBridge<T>(
  token: string,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      bridgeBin,
      `--env-prefix=${PREFIX}`,
      '--mcp-path=/mcp',
      '--name=local-e2e',
      '--version=1.0.0',
    ],
    env: {
      PATH: process.env.PATH ?? '',
      HOME: state.root,
      [`${PREFIX}_SERVER_URL`]: state.baseUrl,
      [`${PREFIX}_TOKEN`]: token,
      [`${PREFIX}_CLI_CONFIG`]: join(state.root, 'bridge-config.json'),
    },
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'local-e2e-host', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  await client.connect(transport);
  try {
    return await run(client);
  } finally {
    await client.close();
    await transport.close();
  }
}

function listNotes(client: Client) {
  return client.callTool({ name: 'notes_list', arguments: {} });
}

beforeAll(async () => {
  for (const key of ['SMRT_DATA_DIR', 'XDG_STATE_HOME', 'SMRT_APP_ID']) {
    savedEnv[key] = process.env[key];
  }
  state.root = await realpath(await mkdtemp(join(tmpdir(), 'smrt-local-mcp-')));
  state.sourceRoot = join(state.root, 'app');
  state.dataDirectory = join(state.root, 'data');
  await mkdir(state.sourceRoot);
  await writeFile(
    join(state.sourceRoot, 'package.json'),
    JSON.stringify({ name: 'local-mcp-e2e' }),
  );
  process.env.SMRT_DATA_DIR = state.dataDirectory;
  process.env.XDG_STATE_HOME = join(state.root, 'state-home');
  delete process.env.SMRT_APP_ID;
  const identity =
    platform() === 'darwin'
      ? state.dataDirectory.toLowerCase()
      : state.dataDirectory;
  state.lockPath = join(
    await realpath('/tmp'),
    `.smrt-${process.getuid?.()}`,
    createHash('sha256').update(identity).digest('hex').slice(0, 32),
    'initialization.sqlite',
  );

  runtime = createSmrtSvelteKitRuntime({
    sourceRoot: state.sourceRoot,
    dataDirectory: state.dataDirectory,
    runtime: LOCAL,
    env: { NODE_ENV: 'development' },
    now: () => new Date(Date.now() + clock.offsetMs),
    // Stands in for `smrt db:migrate` plus one application table.
    prepareDatabase: async (database) => {
      await getTestDatabase({ db: database });
      await database.query(
        `CREATE TABLE IF NOT EXISTS ${NOTES} (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL)`,
      );
    },
  });
  await runtime.init?.({} as never);
  const local = await runtime.localRuntime();
  db = local.db;
  const invitation = await local.rotateBootstrapInvitation();
  const owner = await local.claimOwner({
    token: invitation.token,
    name: 'Owner',
    email: 'owner@example.test',
  });
  state.ownerTenant = owner.tenantId;
  const tenants = await TenantCollection.create({ db });
  const other = await tenants.create({ name: 'Elsewhere', slug: 'elsewhere' });
  await other.save();
  state.otherTenant = other.id as string;
  const role = await (
    await RoleCollection.create({ db })
  ).findSystemRoleBySlug(DEFAULT_ROLE_SLUGS.OWNER);
  state.roleId = role?.id as string;
  const read = await (
    await PermissionCollection.create({ db })
  ).findOrCreate(READ, { name: READ });
  state.readPermissionId = read.id as string;
  await (
    await RolePermissionCollection.create({ db })
  ).addPermission(state.roleId, state.readPermissionId);
  await db.query(
    `INSERT INTO ${NOTES} (id, tenant_id, title) VALUES ('n1', ?, 'Owner note'), ('n2', ?, 'Foreign note')`,
    state.ownerTenant,
    state.otherTenant,
  );

  const POST = mountMcpAppRoute({
    models: [],
    requiredScopes: [READ],
    effects: ['read'],
    smrtOptions: () => ({ db: runtime.databaseConfig() }),
    auth: createHostedMcpResourceAuth({ profile: 'local', runtime }),
    bindPrincipal: runtime.runAsPrincipal,
    workflowTools: [
      {
        name: 'notes_list',
        description: 'List the notes of the active tenant.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        effect: 'read',
        idempotent: true,
        openWorld: false,
        async execute({ principal }) {
          const tenantId = getCurrentTenant()?.tenantId;
          const rows = (
            await db.query(
              `SELECT title FROM ${NOTES} WHERE tenant_id = ? ORDER BY title`,
              tenantId ?? '',
            )
          ).rows as Array<{ title: string }>;
          const result = {
            principal: principal?.id ?? null,
            tenantId: tenantId ?? null,
            scopes: principal?.scopes ?? [],
            titles: rows.map((row) => row.title),
          };
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          };
        },
      },
      {
        name: 'notes_purge',
        description: 'Delete every note.',
        inputSchema: { type: 'object', properties: {} },
        outputSchema: { type: 'object' },
        effect: 'destructive',
        idempotent: false,
        openWorld: false,
        async execute() {
          await db.query(`DELETE FROM ${NOTES}`);
          return { content: [{ type: 'text', text: 'purged' }] };
        },
      },
    ],
  });

  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const url = new URL(req.url ?? '/', state.baseUrl);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(name, value);
        else if (Array.isArray(value)) headers.set(name, value.join(', '));
      }
      const request = new Request(url, {
        method: req.method,
        headers,
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const response = await runtime.handle({
        event: {
          url,
          request,
          cookies: {
            get: () => undefined,
            getAll: () => [],
            set: () => undefined,
            delete: () => undefined,
            serialize: () => '',
          },
          locals: {},
          getClientAddress: () => '127.0.0.1',
          route: { id: url.pathname },
          params: {},
          platform: undefined,
          isDataRequest: false,
          isSubRequest: false,
          setHeaders: () => undefined,
          fetch,
        } as unknown as Parameters<Handle>[0]['event'],
        resolve: async (event) =>
          event.url.pathname === '/mcp'
            ? POST(event as never)
            : new Response(null, { status: 404 }),
      });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await db?.close?.();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(state.root, { recursive: true, force: true });
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    await rm(`${state.lockPath}${suffix}`, { force: true });
  }
  await rmdir(dirname(state.lockPath)).catch(() => undefined);
  disableTenancy();
});

describe('local MCP client credentials over the stdio bridge', () => {
  it('mints with smrt app token, lists only read tools, and reads only the owner tenant', async () => {
    const issued = await smrtAppToken(['--scopes', READ, '--label', 'e2e']);
    const token = String(issued.token);
    await withBridge(token, async (client) => {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toEqual(['notes_list']);
      const result = await listNotes(client);
      expect(result.structuredContent).toEqual({
        principal: expect.any(String),
        tenantId: state.ownerTenant,
        scopes: [READ],
        titles: ['Owner note'],
      });
      // The destructive tool is unknown to the read-only route (the bridge
      // reports the upstream JSON-RPC error without its details).
      await expect(
        client.callTool({ name: 'notes_purge', arguments: {} }),
      ).rejects.toThrow('MCP upstream request failed.');
    });
    const remaining = await db.query(`SELECT COUNT(*) AS n FROM ${NOTES}`);
    expect(Number((remaining.rows[0] as { n: unknown }).n)).toBe(2);
  });

  it('denies a revoked token on the next request', async () => {
    const issued = await smrtAppToken(['--scopes', READ]);
    await withBridge(String(issued.token), async (client) => {
      await expect(listNotes(client)).resolves.toMatchObject({
        structuredContent: { titles: ['Owner note'] },
      });
      await smrtAppToken(['revoke', String(issued.id)]);
      await expect(listNotes(client)).rejects.toThrow(
        'MCP upstream request failed.',
      );
    });
  });

  it('denies an expired token', async () => {
    const issued = await smrtAppToken(['--scopes', READ, '--expires', '1h']);
    try {
      clock.offsetMs = 2 * 60 * 60 * 1000;
      await withBridge(String(issued.token), async (client) => {
        await expect(client.listTools()).rejects.toThrow(
          'MCP upstream request failed.',
        );
      });
    } finally {
      clock.offsetMs = 0;
    }
  });

  it('denies a token bound to a tenant the owner is not a member of', async () => {
    const issued = await smrtAppToken(['--scopes', READ]);
    await db.query(
      'UPDATE _smrt_local_mcp_tokens SET tenant_id = ? WHERE id = ?',
      state.otherTenant,
      String(issued.id),
    );
    await withBridge(String(issued.token), async (client) => {
      await expect(listNotes(client)).rejects.toThrow(
        'MCP upstream request failed.',
      );
    });
  });

  it('never exceeds the owner’s live permissions', async () => {
    const issued = await smrtAppToken(['--scopes', READ]);
    const rolePermissions = await RolePermissionCollection.create({ db });
    await rolePermissions.removePermission(
      state.roleId,
      state.readPermissionId,
    );
    try {
      await withBridge(String(issued.token), async (client) => {
        expect((await client.listTools()).tools).toEqual([]);
        const denied = await listNotes(client).catch((error: unknown) => error);
        expect(
          denied instanceof Error || (denied as { isError?: boolean }).isError,
        ).toBeTruthy();
      });
    } finally {
      await rolePermissions.addPermission(state.roleId, state.readPermissionId);
    }
  });
});
