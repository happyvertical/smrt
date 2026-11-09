/**
 * Hosted vault-account admin surface (#4841): supersede, un-supersede and
 * restart provisioning are refused for anyone but the tenant owner with a
 * fresh step-up, never reach the relay when refused, and always leave an
 * audit record without secrets.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createVaultRelayAdminClient,
  NOT_OWNER_CODE,
  NotOwnerError,
  provisionRestartAccount,
  StepUpRequiredError,
  supersedeVaultAccount,
  unsupersedeVaultAccount,
  VaultAccountAdminError,
  type VaultAccountAuditEntry,
  type VaultAccountDirectory,
  type VaultRelayAdminPort,
} from '../index.js';

// The system owner / member role ids of @happyvertical/smrt-users.
const OWNER_ROLE = '566aef94-1328-4876-b291-b7cf18d4df01';
const MEMBER_ROLE = '566aef94-1328-4876-b291-b7cf18d4df03';
const NOW = new Date('2026-11-09T12:00:00.000Z');
const SECRET_SESSION_ID = 'bearer-session-id-must-never-be-audited';
const ADMIN_TOKEN = 'admin-token-0123456789-0123456789-0123456789';
const DEVICE_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

type Session = Parameters<typeof supersedeVaultAccount>[0]['session'];

function session(
  extra: Record<string, unknown> = {},
  membership: Record<string, unknown> = {},
): NonNullable<Session> {
  return {
    sessionId: SECRET_SESSION_ID,
    user: { id: 'owner-1' },
    tenantId: 'tenant-1',
    membership: {
      userId: 'owner-1',
      tenantId: 'tenant-1',
      roleId: OWNER_ROLE,
      isActive: () => true,
      ...membership,
    },
    authMethod: 'password',
    parent: null,
    permissionCeiling: null,
    tenantAuthorization: null,
    reauthenticatedAt: new Date(NOW.getTime() - 60_000),
    ...extra,
  } as unknown as NonNullable<Session>;
}

function harness(accounts: Record<string, string> = {}) {
  const linked: Record<string, string> = {
    'old-account': 'tenant-1',
    'new-account': 'tenant-1',
    'foreign-account': 'tenant-2',
    ...accounts,
  };
  const relay: VaultRelayAdminPort & Record<string, ReturnType<typeof vi.fn>> =
    {
      registerDevice: vi.fn(async () => 'registered' as const),
      supersedeAccount: vi.fn(async () => 'superseded' as const),
      clearSupersession: vi.fn(async () => true),
    };
  const directory: VaultAccountDirectory = {
    tenantForAccount: vi.fn(async (id: string) => linked[id] ?? null),
    linkAccount: vi.fn(async (tenantId: string, id: string) => {
      linked[id] = tenantId;
    }),
  };
  const entries: VaultAccountAuditEntry[] = [];
  const audit = { record: vi.fn((entry) => void entries.push(entry)) };
  const deps = { relay, directory, audit, now: () => NOW };
  const relayCalls = () =>
    relay.registerDevice.mock.calls.length +
    relay.supersedeAccount.mock.calls.length +
    relay.clearSupersession.mock.calls.length;
  return { relay, directory, audit, entries, deps, relayCalls, linked };
}

const supersede = (
  h: ReturnType<typeof harness>,
  s: Session,
  extra: Record<string, unknown> = {},
) =>
  supersedeVaultAccount({
    ...h.deps,
    session: s,
    oldAccount: 'old-account',
    newAccount: 'new-account',
    ...extra,
  });
const unsupersede = (h: ReturnType<typeof harness>, s: Session) =>
  unsupersedeVaultAccount({ ...h.deps, session: s, oldAccount: 'old-account' });
const provision = (
  h: ReturnType<typeof harness>,
  s: Session,
  extra: Record<string, unknown> = {},
) =>
  provisionRestartAccount({
    ...h.deps,
    session: s,
    oldAccount: 'old-account',
    deviceId: 'device-1',
    devicePublicKey: DEVICE_KEY,
    newAccountId: () => 'fresh-account',
    ...extra,
  });

const actions = {
  supersede,
  unsupersede,
  provision,
} as const;

const refusals: [string, () => Session, string][] = [
  ['no session', () => null, NOT_OWNER_CODE],
  ['an undefined session', () => undefined, NOT_OWNER_CODE],
  ['a member', () => session({}, { roleId: MEMBER_ROLE }), NOT_OWNER_CODE],
  [
    'a device-only (terminal) session',
    () => session({ authMethod: 'terminal' }),
    NOT_OWNER_CODE,
  ],
  [
    'a layered (PIN) session',
    () => session({ authMethod: 'pin', parent: { sessionId: 'parent' } }),
    NOT_OWNER_CODE,
  ],
  [
    'an owner of another tenant',
    () => session({ tenantId: 'tenant-2' }, { tenantId: 'tenant-2' }),
    NOT_OWNER_CODE,
  ],
  [
    'a stale step-up',
    () => session({ reauthenticatedAt: new Date(NOW.getTime() - 301_000) }),
    'step_up_required',
  ],
  [
    'a missing step-up',
    () => session({ reauthenticatedAt: null }),
    'step_up_required',
  ],
  [
    'a future-dated step-up',
    () => session({ reauthenticatedAt: new Date(NOW.getTime() + 3_600_000) }),
    'step_up_required',
  ],
];

describe('vault account admin actions', () => {
  for (const [name, action] of Object.entries(actions)) {
    describe(name, () => {
      for (const [label, make, code] of refusals) {
        it(`refuses ${label} with ${code}, never calls the relay, and audits the denial`, async () => {
          const h = harness();
          const rejected = await action(h, make()).then(
            () => null,
            (error) => error,
          );
          expect(rejected).toBeInstanceOf(Error);
          expect((rejected as { code: string }).code).toBe(code);
          expect(h.relayCalls()).toBe(0);
          expect(h.directory.linkAccount).not.toHaveBeenCalled();
          expect(h.entries).toHaveLength(1);
          expect(h.entries[0]).toMatchObject({
            outcome: 'denied',
            denial: code,
            oldAccountId: 'old-account',
          });
        });
      }

      it('refuses an account of another tenant as not_owner', async () => {
        const h = harness();
        const call =
          name === 'supersede'
            ? supersede(h, session(), { oldAccount: 'foreign-account' })
            : name === 'unsupersede'
              ? unsupersedeVaultAccount({
                  ...h.deps,
                  session: session(),
                  oldAccount: 'foreign-account',
                })
              : provision(h, session(), { oldAccount: 'foreign-account' });
        await expect(call).rejects.toBeInstanceOf(NotOwnerError);
        expect(h.relayCalls()).toBe(0);
        expect(h.entries.map((e) => e.outcome)).toEqual(['denied']);
      });

      it('still refuses when the audit sink throws on a denial', async () => {
        const h = harness();
        h.audit.record.mockImplementation(() => {
          throw new Error('sink down');
        });
        await expect(action(h, null)).rejects.toBeInstanceOf(NotOwnerError);
        expect(h.relayCalls()).toBe(0);
      });

      it('does not perform the action when the audit record cannot be written', async () => {
        const h = harness();
        h.audit.record.mockImplementation(() => {
          throw new Error('sink down');
        });
        await expect(action(h, session())).rejects.toMatchObject({
          code: 'audit_unavailable',
        });
        expect(h.relayCalls()).toBe(0);
      });

      it('honours a configured step-up max age', async () => {
        const h = harness();
        const s = session({
          reauthenticatedAt: new Date(NOW.getTime() - 120_000),
        });
        const call =
          name === 'supersede'
            ? supersede(h, s, { stepUpMaxAgeSeconds: 60 })
            : name === 'unsupersede'
              ? unsupersedeVaultAccount({
                  ...h.deps,
                  session: s,
                  oldAccount: 'old-account',
                  stepUpMaxAgeSeconds: 60,
                })
              : provision(h, s, { stepUpMaxAgeSeconds: 60 });
        await expect(call).rejects.toBeInstanceOf(StepUpRequiredError);
        expect(h.relayCalls()).toBe(0);
      });
    });
  }

  it('gives the two refusals distinct, stable, non-leaking codes', async () => {
    const h = harness();
    const notOwner = await supersede(h, session({}, { roleId: MEMBER_ROLE }))
      .then(() => null)
      .catch((e) => e);
    const stale = await supersede(h, session({ reauthenticatedAt: null }))
      .then(() => null)
      .catch((e) => e);
    expect(notOwner.code).toBe('not_owner');
    expect(stale.code).toBe('step_up_required');
    expect(notOwner.code).not.toBe(stale.code);
    for (const error of [notOwner, stale]) {
      expect(error.message).not.toMatch(
        /old-account|new-account|tenant|owner-1|session|stale|member|terminal/i,
      );
    }
    // A member learns nothing about the step-up requirement.
    expect(
      await supersede(
        h,
        session({ reauthenticatedAt: null }, { roleId: MEMBER_ROLE }),
      )
        .then(() => null)
        .catch((e) => e.code),
    ).toBe('not_owner');
  });

  it('supersedes for the owner with a fresh step-up: one relay call, audited', async () => {
    const h = harness();
    await expect(supersede(h, session())).resolves.toBe('superseded');
    expect(h.relay.supersedeAccount).toHaveBeenCalledTimes(1);
    expect(h.relay.supersedeAccount).toHaveBeenCalledWith(
      'old-account',
      'new-account',
    );
    expect(h.relayCalls()).toBe(1);
    expect(h.entries.map((e) => e.outcome)).toEqual([
      'authorized',
      'succeeded',
    ]);
    expect(h.entries[1]).toMatchObject({
      action: 'supersede',
      actorUserId: 'owner-1',
      tenantId: 'tenant-1',
      oldAccountId: 'old-account',
      newAccountId: 'new-account',
      result: 'superseded',
      at: NOW.toISOString(),
    });
  });

  it('accepts a step-up exactly at the limit and refuses a second past it', async () => {
    const h = harness();
    await expect(
      supersede(
        h,
        session({ reauthenticatedAt: new Date(NOW.getTime() - 300_000) }),
      ),
    ).resolves.toBe('superseded');
    await expect(
      supersede(
        h,
        session({ reauthenticatedAt: new Date(NOW.getTime() - 300_001) }),
      ),
    ).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it('unsupersedes for the owner with a fresh step-up', async () => {
    const h = harness();
    await expect(unsupersede(h, session())).resolves.toBe(true);
    expect(h.relay.clearSupersession).toHaveBeenCalledTimes(1);
    expect(h.relay.clearSupersession).toHaveBeenCalledWith('old-account');
    expect(h.relayCalls()).toBe(1);
    expect(h.entries.map((e) => e.outcome)).toEqual([
      'authorized',
      'succeeded',
    ]);
  });

  it('provisions the replacement account and registers the device once', async () => {
    const h = harness();
    await expect(provision(h, session())).resolves.toEqual({
      accountId: 'fresh-account',
      deviceId: 'device-1',
      device: 'registered',
    });
    expect(h.directory.linkAccount).toHaveBeenCalledWith(
      'tenant-1',
      'fresh-account',
    );
    expect(h.relay.registerDevice).toHaveBeenCalledTimes(1);
    expect(h.relay.registerDevice).toHaveBeenCalledWith(
      'fresh-account',
      'device-1',
      DEVICE_KEY,
    );
    expect(h.relayCalls()).toBe(1);
    expect(h.entries[1]).toMatchObject({
      action: 'provision_restart_account',
      outcome: 'succeeded',
      newAccountId: 'fresh-account',
      deviceId: 'device-1',
    });
  });

  it('mints a fresh account id by default', async () => {
    const h = harness();
    const result = await provisionRestartAccount({
      ...h.deps,
      session: session(),
      oldAccount: 'old-account',
      deviceId: 'device-1',
      devicePublicKey: DEVICE_KEY,
    });
    expect(result.accountId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
    expect(result.accountId).not.toBe('old-account');
  });

  it('audits a relay failure with a code, not a message, and rethrows', async () => {
    const h = harness();
    h.relay.supersedeAccount.mockRejectedValue(
      Object.assign(new Error(`secret detail ${ADMIN_TOKEN}`), {
        code: 'target_not_ready',
      }),
    );
    await expect(supersede(h, session())).rejects.toThrow();
    expect(h.relay.supersedeAccount).toHaveBeenCalledTimes(1);
    expect(h.entries.map((e) => e.outcome)).toEqual(['authorized', 'failed']);
    expect(h.entries[1]).toMatchObject({ errorCode: 'target_not_ready' });
    expect(JSON.stringify(h.entries)).not.toContain('secret detail');
  });

  it('turns a device conflict into a coded failure', async () => {
    const h = harness();
    h.relay.registerDevice.mockResolvedValue('conflict');
    await expect(provision(h, session())).rejects.toMatchObject({
      code: 'device_conflict',
    });
    expect(h.entries[1]).toMatchObject({
      outcome: 'failed',
      errorCode: 'device_conflict',
    });
  });

  it('rejects malformed input only after the gates pass', async () => {
    const h = harness();
    await expect(
      supersede(h, session(), { newAccount: 'old-account' }),
    ).rejects.toBeInstanceOf(VaultAccountAdminError);
    await expect(
      supersede(h, null, { newAccount: 'old-account' }),
    ).rejects.toBeInstanceOf(NotOwnerError);
    await expect(
      provision(h, session(), { deviceId: 'bad id/../' }),
    ).rejects.toBeInstanceOf(VaultAccountAdminError);
    expect(h.relayCalls()).toBe(0);
  });

  it('writes no secret into any audit record', async () => {
    const h = harness();
    await supersede(h, session());
    await unsupersede(h, session());
    await provision(h, session());
    await supersede(h, session({}, { roleId: MEMBER_ROLE })).catch(() => {});
    await supersede(h, session({ reauthenticatedAt: null })).catch(() => {});
    const text = JSON.stringify(h.entries);
    expect(text).not.toContain(SECRET_SESSION_ID);
    expect(text).not.toContain(DEVICE_KEY);
    expect(text).not.toContain(ADMIN_TOKEN);
    expect(text).not.toMatch(/password|secret|token|publicKey/i);
    for (const entry of h.entries) {
      expect(Object.keys(entry).sort()).toEqual(
        expect.arrayContaining(['action', 'actorUserId', 'at', 'outcome']),
      );
    }
  });
});

describe('createVaultRelayAdminClient', () => {
  function client(
    responder: (url: URL, init: RequestInit) => Response,
    calls: { url: string; init: RequestInit }[] = [],
  ) {
    return {
      calls,
      port: createVaultRelayAdminClient({
        baseUrl: 'http://relay-admin:8081',
        adminToken: ADMIN_TOKEN,
        fetch: (async (url: URL, init: RequestInit) => {
          calls.push({ url: String(url), init });
          return responder(url, init);
        }) as unknown as typeof fetch,
      }),
    };
  }
  const json = (status: number, body: unknown) =>
    new Response(body === null ? null : JSON.stringify(body), { status });

  it('speaks the relay admin routes', async () => {
    const { port, calls } = client((url, init) => {
      if (url.pathname.endsWith('/devices/dev-1'))
        return json(201, { result: 'registered' });
      if (init.method === 'PUT') return json(201, { result: 'superseded' });
      return json(204, null);
    });
    await expect(
      port.registerDevice('acct-2', 'dev-1', DEVICE_KEY),
    ).resolves.toBe('registered');
    await expect(port.supersedeAccount('acct-1', 'acct-2')).resolves.toBe(
      'superseded',
    );
    await expect(port.clearSupersession('acct-1')).resolves.toBe(true);
    expect(
      calls.map((c) => `${c.init.method} ${new URL(c.url).pathname}`),
    ).toEqual([
      'PUT /admin/v1/accounts/acct-2/devices/dev-1',
      'PUT /admin/v1/accounts/acct-1/superseded-by',
      'DELETE /admin/v1/accounts/acct-1/superseded-by',
    ]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      publicKey: DEVICE_KEY,
    });
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      supersededBy: 'acct-2',
    });
    for (const c of calls) {
      expect((c.init.headers as Record<string, string>).authorization).toBe(
        `Bearer ${ADMIN_TOKEN}`,
      );
    }
  });

  it('maps relay answers and never leaks the token in errors', async () => {
    const answers = [
      json(200, { result: 'unchanged' }),
      json(404, { error: 'no_supersession' }),
      json(409, { error: 'target_not_ready' }),
      json(409, {}),
    ];
    const { port } = client(() => answers.shift() as Response);
    await expect(port.supersedeAccount('a', 'b')).resolves.toBe('unchanged');
    await expect(port.clearSupersession('a')).resolves.toBe(false);
    const refused = await port.supersedeAccount('a', 'b').catch((e) => e);
    expect(refused).toBeInstanceOf(VaultAccountAdminError);
    expect(refused.code).toBe('target_not_ready');
    expect(String(refused.message)).not.toContain(ADMIN_TOKEN);
    expect(await port.registerDevice('a', 'd', DEVICE_KEY)).toBe('conflict');
  });

  it('rejects path-shaped ids and a weak token', async () => {
    const { port, calls } = client(() => json(200, {}));
    await expect(port.clearSupersession('../x')).rejects.toBeInstanceOf(
      VaultAccountAdminError,
    );
    expect(calls).toHaveLength(0);
    expect(() =>
      createVaultRelayAdminClient({ baseUrl: 'http://x', adminToken: 'short' }),
    ).toThrow();
  });
});
