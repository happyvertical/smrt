// The change-queue entry points take a caller (#5609): `execute`, `forkDraft`,
// `publishDraft` and `restoreSnapshot` refuse a call with no principal, a
// look-alike, another tenant's, a guest, or a member who is not the owner, and
// refuse before anything is queued, written or created. The owner passes.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostOwner } from '../test/engine-principal.ts';
import {
  AppHost,
  appPermissionSlugs,
  type Command,
  EngineError,
  enginePrincipal,
  MemoryVersionStore,
  NoPrincipalError,
  OWNER_SLUG,
  PermissionDeniedError,
} from './index.ts';
import { onPglite } from './pglite-env.ts';

const TENANT = '00000000-0000-4000-8000-0000000000b1';
const dir = mkdtempSync(join(tmpdir(), 'change-principal-'));
let host: AppHost;

const define: Command = {
  type: 'defineModel',
  name: 'Chore',
  fields: { title: { type: 'text' } },
};
const OK = { author: 't', approved: true };

beforeAll(async () => {
  host = await AppHost.open(join(dir, 'live'), {
    store: new MemoryVersionStore(),
    tenantId: TENANT,
  });
  await host.execute(hostOwner(host), define, OK);
});
afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const member = () =>
  enginePrincipal({
    kind: 'user',
    tenantId: TENANT,
    userId: 'member',
    permissions: appPermissionSlugs(host.def),
  });
const callers: [string, () => unknown, new (...a: never[]) => Error][] = [
  ['no principal', () => undefined, NoPrincipalError],
  [
    'a look-alike copy',
    () => ({ ...hostOwner(host), permissions: [OWNER_SLUG] }),
    NoPrincipalError,
  ],
  [
    "another tenant's owner",
    () =>
      enginePrincipal({
        kind: 'user',
        tenantId: 'another-tenant',
        userId: 'x',
        permissions: [OWNER_SLUG],
      }),
    PermissionDeniedError,
  ],
  [
    'a guest',
    () =>
      enginePrincipal({
        kind: 'guest',
        tenantId: TENANT,
        permissions: [OWNER_SLUG],
      }),
    PermissionDeniedError,
  ],
  [
    'a member who is not the owner',
    member as () => unknown,
    PermissionDeniedError,
  ],
];

const h = () => host as any;
const entries: [string, (p: unknown) => Promise<unknown>][] = [
  ['execute', (p) => h().execute(p, { ...define, name: 'Other' }, OK)],
  [
    'forkDraft',
    (p) =>
      h().forkDraft(p, join(dir, 'refused-draft'), {
        store: new MemoryVersionStore(),
      }),
  ],
  [
    'publishDraft',
    // The draft is never read: the caller is refused first.
    (p) => h().publishDraft(p, host, { ...OK, expect: 'digest' }),
  ],
  ['restoreSnapshot', (p) => h().restoreSnapshot(p, 'none.pgdump', OK)],
];

describe.each(entries)('%s', (_name, call) => {
  it.each(callers)('refuses %s', async (_who, caller, error) => {
    const version = host.version;
    const rejection = call(caller());
    await expect(rejection).rejects.toBeInstanceOf(error);
    expect(host.version).toBe(version);
    expect(existsSync(join(dir, 'refused-draft'))).toBe(false);
    expect(Object.keys(host.def.models)).toEqual(['Chore']);
  });
});

describe('the owner', () => {
  it('executes a command', async () => {
    const before = host.version;
    await host.execute(
      hostOwner(host),
      {
        type: 'addField',
        model: 'Chore',
        field: 'notes',
        definition: { type: 'text' },
      },
      OK,
    );
    expect(host.version).toBeGreaterThan(before);
  });

  it('forks a draft, which executes as the owner and publishes into live', async () => {
    const draft = await host.forkDraft(hostOwner(host), join(dir, 'draft'), {
      store: new MemoryVersionStore(),
    });
    try {
      // The draft's own entry point refuses what live's refuses.
      await expect(
        (draft as any).execute(undefined, define, OK),
      ).rejects.toBeInstanceOf(NoPrincipalError);
      await draft.execute(
        hostOwner(draft),
        { type: 'defineModel', name: 'Extra', fields: { n: { type: 'text' } } },
        OK,
      );
      const preview = await host.previewPublish(draft);
      host.setFrozen(true);
      const published = await host.publishDraft(hostOwner(host), draft, {
        ...OK,
        expect: preview.digest,
      });
      expect(published.versions.length).toBeGreaterThan(0);
      expect(Object.keys(host.def.models)).toContain('Extra');
    } finally {
      host.setFrozen(false);
    }
  });

  it('is let through by restoreSnapshot, which then refuses on SQLite', {
    skip: onPglite,
  }, async () => {
    const e = await host
      .restoreSnapshot(hostOwner(host), 'none.pgdump')
      .catch((x) => x);
    expect(e).toBeInstanceOf(EngineError);
    expect(e).not.toBeInstanceOf(PermissionDeniedError);
    expect(e).not.toBeInstanceOf(NoPrincipalError);
    expect(String(e.message)).toMatch(/PostgreSQL/);
  });
});

describe('the shell owner of another tenant (authorCaller, #5609)', () => {
  it('is refused by the host that belongs to a different tenant', async () => {
    const { authorCaller } = await import('../lib/server/owner.ts');
    const foreignOwner = authorCaller(
      { id: 'owner', tenantId: 'not-this-hosts-tenant' },
      host,
    );
    await expect(
      host.execute(foreignOwner, { ...define, name: 'Foreign' }, OK),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(Object.keys(host.def.models)).not.toContain('Foreign');
  });
});
