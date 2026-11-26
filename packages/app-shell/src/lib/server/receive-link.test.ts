// The link token of the CLI's receive transport (#5638): minted by the owner,
// one tenant, one action, short-lived, spent by its first use, stored hashed.
// SQLite stands in for the shell database (the conditional UPDATE is the same
// statement on PostgreSQL, as approvals use it).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as receive } from '../../routes/api/shell/app/receive/+server.ts';
import { POST as mint } from '../../routes/api/shell/app/receive-link/+server.ts';
import { POST as decide } from '../../routes/api/shell/approvals/[id]/+server.ts';
import { ReceiveLinkCollection } from '../objects/ReceiveLink.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { configureShell, getShellDb } from './host.ts';
import { type Principal, runAs, setOwnerCheck } from './owner.ts';
import {
  mintReceiveLink,
  RECEIVE_LINK_MAX_TTL_SECONDS,
  RECEIVE_SCOPE,
  spendReceiveLink,
  verifyReceiveLink,
} from './receive-link.ts';

let h: CloudHarness;
beforeAll(async () => {
  h = await openCloudShell();
});
afterAll(async () => {
  await h.close();
});

const ORIGIN = 'http://localhost:5173';
const locals = (who: Principal | null) =>
  who ? { user: { id: who.id }, tenantId: who.tenantId, permissions: [] } : {};
const post = (
  handler: (e: never) => Promise<Response>,
  path: string,
  who: Principal | null,
  body: unknown = {},
  headers: Record<string, string> = {},
) =>
  handler({
    request: new Request(`${ORIGIN}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(who ? { origin: ORIGIN } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    url: new URL(`${ORIGIN}${path}`),
    locals: locals(who),
    params: {},
  } as never);
const minted = async (who: Principal, body: unknown = {}) => {
  const res = await post(
    mint as never,
    '/api/shell/app/receive-link',
    who,
    body,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    token: string;
    expiresAt: string;
    scope: string;
  };
};
const present = (
  token: string,
  body: unknown = { bundle: {} },
  path = '/api/shell/app/receive',
) =>
  post(receive as never, path, null, body, {
    authorization: `Bearer ${token}`,
  });
const rows = (who: Principal) =>
  runAs(who, async () =>
    (await ReceiveLinkCollection.create({ db: await getShellDb() })).list({
      limit: 100,
    }),
  );

describe('minting', () => {
  it('is the owner only, returns the token once and stores only its hash', async () => {
    expect(
      (await post(mint as never, '/api/shell/app/receive-link', null)).status,
    ).toBe(401);
    const link = await minted(h.a);
    expect(link.scope).toBe(RECEIVE_SCOPE);
    const [row] = (await rows(h.a)).filter((r) => r.usedAt === '');
    expect(row.ownerId).toBe(h.a.id);
    expect(row.scope).toBe(RECEIVE_SCOPE);
    expect(row.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const secret = link.token.split('.')[2];
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(link.token).toContain(h.a.tenantId);
    // a link token cannot mint another one
    const viaToken = await post(
      mint as never,
      '/api/shell/app/receive-link',
      null,
      {},
      {
        authorization: `Bearer ${link.token}`,
      },
    );
    expect(viaToken.status).toBe(401);
  });

  it('is short-lived: 10 minutes by default, never past the cap', async () => {
    const before = Date.now();
    const link = await minted(h.a);
    const ms = Date.parse(link.expiresAt) - before;
    expect(ms).toBeGreaterThan(9 * 60_000);
    expect(ms).toBeLessThanOrEqual(10 * 60_000 + 5_000);
    const short = await minted(h.a, { ttlSeconds: 30 });
    expect(Date.parse(short.expiresAt) - Date.now()).toBeLessThanOrEqual(
      30_000,
    );
    for (const bad of [RECEIVE_LINK_MAX_TTL_SECONDS + 1, 0, -5, 1.5]) {
      const res = await post(
        mint as never,
        '/api/shell/app/receive-link',
        h.a,
        { ttlSeconds: bad },
      );
      expect(res.status).toBe(400);
    }
    expect(
      (
        await post(mint as never, '/api/shell/app/receive-link', h.a, {
          ttlSeconds: '60',
        })
      ).status,
    ).toBe(400);
  });

  it('a new token revokes the earlier unspent one', async () => {
    const first = await minted(h.a);
    const second = await minted(h.a);
    expect(await verifyReceiveLink(first.token)).toBeNull();
    expect(await verifyReceiveLink(second.token)).not.toBeNull();
  });

  it('is refused for a non-owner', async () => {
    setOwnerCheck(async () => false);
    try {
      expect(
        (await post(mint as never, '/api/shell/app/receive-link', h.a)).status,
      ).toBe(403);
    } finally {
      setOwnerCheck(null);
    }
  });
});

describe('presenting', () => {
  it('a missing, malformed or tampered token is one 401 and spends nothing', async () => {
    const link = await minted(h.a);
    const [prefix, tenant, secret] = link.token.split('.');
    const flipped = secret.slice(0, -1) + (secret.endsWith('A') ? 'B' : 'A');
    const cases = [
      // no header at all falls to the owner-session path: nobody signed in
      null,
      'Bearer',
      'Bearer ',
      'Basic abc',
      'Bearer nonsense',
      `Bearer ${prefix}.${tenant}.${flipped}`,
      `Bearer ${prefix}.${tenant}.${secret.slice(1)}`,
      `Bearer ${prefix}x.${tenant}.${secret}`,
      `Bearer ${link.token}.extra`,
      `Bearer ${prefix}.not-a-uuid.${secret}`,
    ];
    for (const header of cases) {
      const res = await post(
        receive as never,
        '/api/shell/app/receive',
        null,
        { bundle: {} },
        header === null ? {} : { authorization: header },
      );
      expect(res.status, String(header)).toBe(401);
    }
    expect(await verifyReceiveLink(link.token)).not.toBeNull();
  });

  it("another tenant's token, or this secret under another tenant, is refused", async () => {
    const a = await minted(h.a);
    const b = await minted(h.b);
    const [prefix, , secretA] = a.token.split('.');
    const [, tenantB, secretB] = b.token.split('.');
    // A's secret under B's tenant, and B's secret under A's tenant
    expect((await present(`${prefix}.${tenantB}.${secretA}`)).status).toBe(401);
    expect((await present(`${prefix}.${h.a.tenantId}.${secretB}`)).status).toBe(
      401,
    );
    // an unknown tenant
    expect(
      (
        await present(
          `${prefix}.00000000-0000-4000-8000-000000000000.${secretA}`,
        )
      ).status,
    ).toBe(401);
    // both still good: nothing was spent by the refusals
    expect(await verifyReceiveLink(a.token)).toMatchObject({
      tenantId: h.a.tenantId,
      ownerId: h.a.id,
    });
    expect(await verifyReceiveLink(b.token)).toMatchObject({
      tenantId: h.b.tenantId,
      ownerId: h.b.id,
    });
  });

  it('expires', async () => {
    const link = await minted(h.a, { ttlSeconds: 60 });
    expect(
      await verifyReceiveLink(link.token, () => Date.now() + 30_000),
    ).not.toBeNull();
    expect(
      await verifyReceiveLink(link.token, () => Date.now() + 61_000),
    ).toBeNull();
    // and through the route, with the row's own expiry in the past
    await runAs(h.a, async () => {
      const [row] = (await rows(h.a)).filter((r) => r.usedAt === '');
      row.expiresAt = new Date(Date.now() - 1000).toISOString();
      await row.save();
    });
    expect((await present(link.token)).status).toBe(401);
  });

  it('cannot be spent once it has expired, even after it verified', async () => {
    const link = await minted(h.a, { ttlSeconds: 60 });
    const verified = await verifyReceiveLink(link.token);
    expect(verified).not.toBeNull();
    const late = () => Date.now() + 61_000;
    expect(
      await spendReceiveLink(verified as NonNullable<typeof verified>, late),
    ).toBe(false);
    // still unspent: a spend inside its lifetime works
    expect(
      await spendReceiveLink(verified as NonNullable<typeof verified>),
    ).toBe(true);
  });

  it('is spent by its first use, even when that receive fails, and is never reusable', async () => {
    const link = await minted(h.a);
    // no body to speak of: refused before the token is spent
    expect((await present(link.token, {})).status).toBe(400);
    expect(await verifyReceiveLink(link.token)).not.toBeNull();
    // a bundle that does not check: the receive fails (400) AFTER the token is spent
    expect(
      (await present(link.token, { bundle: { not: 'a bundle' } })).status,
    ).toBe(400);
    expect(await verifyReceiveLink(link.token)).toBeNull();
    expect(
      (await present(link.token, { bundle: { not: 'a bundle' } })).status,
    ).toBe(401);
  });

  it('only one of two concurrent redemptions wins', async () => {
    const link = await minted(h.b);
    const verified = await verifyReceiveLink(link.token);
    expect(verified).not.toBeNull();
    const won = await Promise.all([
      spendReceiveLink(verified as NonNullable<typeof verified>),
      spendReceiveLink(verified as NonNullable<typeof verified>),
    ]);
    expect(won.filter(Boolean)).toHaveLength(1);
  });

  it('acts only while the minter still owns the tenant', async () => {
    const link = await minted(h.a);
    setOwnerCheck(async () => false);
    try {
      expect((await present(link.token, { bundle: { x: 1 } })).status).toBe(
        401,
      );
    } finally {
      setOwnerCheck(null);
    }
    expect(await verifyReceiveLink(link.token)).toBeNull(); // spent
  });

  it('never rides in a URL', async () => {
    const link = await minted(h.a);
    const res = await post(
      receive as never,
      '/api/shell/app/receive?token=x',
      null,
      { bundle: {} },
      { authorization: `Bearer ${link.token}` },
    );
    expect(res.status).toBe(400);
    expect(await verifyReceiveLink(link.token)).not.toBeNull();
  });

  it('is not an owner session anywhere else', async () => {
    const link = await minted(h.a);
    const res = await post(
      decide as never,
      '/api/shell/approvals/x',
      null,
      {},
      { authorization: `Bearer ${link.token}` },
    );
    expect(res.status).toBe(401);
    expect(await verifyReceiveLink(link.token)).not.toBeNull();
  });

  it('is cloud-profile only', async () => {
    const link = await minted(h.a);
    configureShell({
      profile: async () => 'local' as const,
      db: async () => h.db,
      dataRoot: async () => h.dir,
    });
    try {
      expect(await verifyReceiveLink(link.token)).toBeNull();
      await expect(runAs(h.a, () => mintReceiveLink())).rejects.toThrow();
    } finally {
      configureShell({
        profile: async () => 'cloud' as const,
        db: async () => h.db,
        dataRoot: async () => h.dir,
      });
    }
  });
});
