// The real local runtime on SQLite: the shell's assistant permission reaches
// the owner on a fresh install AND on an install whose owner predates it, and
// a minted agent token works only because the owner holds it.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntime,
} from '@happyvertical/smrt-app-runtime/sveltekit';
import { resolveApplicationRuntime } from '@happyvertical/smrt-config';
import {
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { tokenCredentials } from './agent-cli/credentials.ts';
import { ASSISTANT_USE_PERMISSION } from './agent-cli/settings.ts';
import './registry.ts';

const roots: string[] = [];
const open: SmrtSvelteKitRuntime[] = [];

afterEach(async () => {
  for (const runtime of open.splice(0)) {
    try {
      await (await runtime.localRuntime()).db.close?.();
    } catch {
      // never started
    }
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function directories() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'shell-perm-seed-')));
  roots.push(root);
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot);
  writeFileSync(
    join(sourceRoot, 'package.json'),
    JSON.stringify({ name: '@acme/shell-perm-seed' }),
  );
  return { sourceRoot, dataDirectory: join(root, 'data') };
}

type Local = Awaited<ReturnType<typeof start>>['local'];

async function start(dirs: ReturnType<typeof directories>) {
  const runtime = createSmrtSvelteKitRuntime({
    ...dirs,
    runtime: resolveApplicationRuntime({ profile: 'local' }),
    env: { NODE_ENV: 'development' },
  });
  open.push(runtime);
  await runtime.init();
  return { runtime, local: await runtime.localRuntime() };
}

async function claim(local: Local) {
  const invitation = await local.rotateBootstrapInvitation();
  await local.claimOwner({
    token: invitation.token,
    name: 'Owner',
    email: 'owner@example.test',
  });
}

const mint = (local: Local) =>
  tokenCredentials(async () => local.mcpTokens).mint();

/** Rewind to a database from before the assistant permissions existed. */
async function forgetAssistantPermissions(db: DatabaseInterface) {
  await db.query(
    `DELETE FROM role_permissions WHERE permission_id IN
       (SELECT id FROM permissions WHERE slug LIKE 'assistant.%')`,
  );
  await db.query(`DELETE FROM permissions WHERE slug LIKE 'assistant.%'`);
}

async function holds(db: DatabaseInterface, role: string) {
  const roles = await RoleCollection.create({ db });
  const found = await roles.findSystemRoleBySlug(role);
  const permission = await (
    await PermissionCollection.create({ db })
  ).findBySlug(ASSISTANT_USE_PERMISSION);
  if (!found?.id || !permission?.id) return false;
  const ids = await (
    await RolePermissionCollection.create({ db })
  ).getPermissionIds(found.id);
  return ids.includes(permission.id);
}

describe('shell assistant permission seeding', () => {
  it('fresh install: the owner holds assistant.use and mint() works', async () => {
    const { local } = await start(directories());
    await claim(local);
    expect(await holds(local.db, 'owner')).toBe(true);
    await expect(mint(local)).resolves.toMatch(/^smrt_mcp_/);
  });

  it('upgrade: an owner whose database predates assistant.use gains it on the next start', async () => {
    const dirs = directories();
    const first = await start(dirs);
    await claim(first.local);
    await forgetAssistantPermissions(first.local.db);
    await expect(mint(first.local)).rejects.toMatchObject({
      code: 'invalid_scope',
    });
    await first.local.db.close?.();

    const second = await start(dirs);
    expect(await holds(second.local.db, 'owner')).toBe(true);
    await expect(mint(second.local)).resolves.toMatch(/^smrt_mcp_/);
  });

  it('only the owner role gains it on upgrade, so no other role can mint', async () => {
    const dirs = directories();
    const first = await start(dirs);
    await claim(first.local);
    await forgetAssistantPermissions(first.local.db);
    await first.local.db.close?.();

    const second = await start(dirs);
    for (const role of ['admin', 'member', 'viewer'])
      expect(await holds(second.local.db, role)).toBe(false);
  });
});
