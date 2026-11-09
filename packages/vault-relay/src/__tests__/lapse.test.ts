/**
 * Lapsed `backup.vault` entitlement (#4819): writes are refused with a
 * distinct code, reads stay open for the retention window measured from the
 * first observed lapse, and an audited operator sweep deletes the account's
 * snapshots after it.
 */
import { readdir } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accountHandle } from '../encoding.js';
import type { VaultRelayEntitlements } from '../relay.js';
import {
  adminRequest,
  createHarness,
  DEFAULT_POLICY,
  type Harness,
  newDevice,
  registerDevice,
  signed,
  stubEntitlements,
  type TestDevice,
  uploadSnapshot,
} from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 30;
const UUID = '00000000-0000-4000-8000-000000000000';

let h: Harness;
let enabled: Set<string>;
let disabledByOperator: Set<string>;
const devices: Record<string, TestDevice> = {};

function entitlements(): VaultRelayEntitlements {
  const base = stubEntitlements(enabled);
  return {
    ...base,
    resolver: {
      findGrantingPlan: base.resolver.findGrantingPlan,
      async explain(key, context) {
        if (context?.tenantId && disabledByOperator.has(context.tenantId)) {
          return { enabled: false, decidedBy: 'tenant_override' };
        }
        return base.resolver.explain(key, context);
      },
    },
  };
}

async function setup(accounts: string[], policyDays?: number): Promise<void> {
  enabled = new Set(accounts);
  disabledByOperator = new Set();
  h = await createHarness({
    entitlements: entitlements(),
    policy: {
      ...DEFAULT_POLICY,
      retention: {
        ...DEFAULT_POLICY.retention,
        lapseRetentionDays: policyDays ?? WINDOW_DAYS,
      },
    },
  });
  for (const account of accounts) {
    devices[account] = newDevice(account, 'device-1');
    await registerDevice(h, devices[account]);
  }
}

async function upload(account: string, sequence: number): Promise<void> {
  const response = await uploadSnapshot(
    h,
    devices[account],
    sequence,
    new Uint8Array(8).fill(sequence),
  );
  expect(response.status).toBe(201);
}

async function call(
  account: string,
  method: string,
  path: string,
  body?: string,
) {
  const response = await h.relay.handle(
    signed(h, devices[account], method, path, body ? { body } : {}),
  );
  const text = await response.text();
  const json = response.headers.get('content-type')?.includes('json');
  return {
    status: response.status,
    body: json && text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

function lapse(account: string): void {
  enabled.delete(account);
}

async function listObjects(): Promise<number> {
  const entries = await readdir(h.storeRoot, { recursive: true });
  return entries.filter((entry) => /\.[0-9a-f]{32}$/.test(entry)).length;
}

afterEach(async () => {
  await h.close();
});

describe('writes refused while lapsed', () => {
  beforeEach(async () => {
    await setup(['acct-a']);
    await upload('acct-a', 1);
    await upload('acct-a', 2);
  });

  it('refuses begin, chunk upload, commit and device delete with entitlement_lapsed', async () => {
    // A pending upload begun while entitled.
    const token = (await (
      await h.relay.handle(
        signed(h, devices['acct-a'], 'POST', '/v1/lease/acquire', {
          body: JSON.stringify({ baseSequence: 2 }),
        }),
      )
    ).json()) as { fencingToken: number };
    const begin = await call(
      'acct-a',
      'POST',
      '/v1/uploads',
      JSON.stringify({
        fencingToken: token.fencingToken,
        sequence: 3,
        byteSize: 8,
        chunkSize: 4096,
        sha256: '0'.repeat(64),
      }),
    );
    expect(begin.status).toBe(201);
    const uploadId = begin.body.uploadId as string;

    lapse('acct-a');
    const refused = [
      await call(
        'acct-a',
        'POST',
        '/v1/uploads',
        JSON.stringify({
          fencingToken: token.fencingToken,
          sequence: 4,
          byteSize: 8,
          chunkSize: 4096,
          sha256: '0'.repeat(64),
        }),
      ),
      await call('acct-a', 'PUT', `/v1/uploads/${uploadId}/chunks/0`, 'x'),
      await call('acct-a', 'POST', `/v1/uploads/${uploadId}/commit`),
      await call('acct-a', 'DELETE', '/v1/snapshots/1'),
    ];
    for (const response of refused) {
      expect(response.status).toBe(402);
      expect(response.body).toMatchObject({ error: 'entitlement_lapsed' });
      expect(typeof response.body.restoreAvailableUntil).toBe('string');
    }
    // Distinct from a missing entitlement and from authentication.
    expect(refused[0].body.code).toBeUndefined();

    // Aborting the pending upload is allowed.
    expect(
      (await call('acct-a', 'DELETE', `/v1/uploads/${uploadId}`)).status,
    ).toBe(204);
  });

  it('keeps list, latest, download, lease and abort open inside the window', async () => {
    lapse('acct-a');
    expect((await call('acct-a', 'GET', '/v1/snapshots')).status).toBe(200);
    const latest = await call('acct-a', 'GET', '/v1/snapshots/latest');
    expect(latest.body).toMatchObject({ sequence: 2 });
    expect((await call('acct-a', 'GET', '/v1/snapshots/1')).status).toBe(200);
    expect(
      (await call('acct-a', 'GET', '/v1/snapshots/1/chunks/0')).status,
    ).toBe(200);
    expect((await call('acct-a', 'GET', '/v1/lease')).status).toBe(200);
    // Restore-latest holds the lease while it downloads.
    const acquire = await call(
      'acct-a',
      'POST',
      '/v1/lease/acquire',
      JSON.stringify({ baseSequence: 2 }),
    );
    expect(acquire.status).toBe(200);
    expect((await call('acct-a', 'DELETE', `/v1/uploads/${UUID}`)).status).toBe(
      404,
    );
    // Still open late in the window.
    h.clock.now += (WINDOW_DAYS - 1) * DAY;
    expect((await call('acct-a', 'GET', '/v1/snapshots/latest')).status).toBe(
      200,
    );
  });

  it('refuses reads with retention_expired once the window has passed', async () => {
    lapse('acct-a');
    expect((await call('acct-a', 'GET', '/v1/snapshots')).status).toBe(200);
    h.clock.now += WINDOW_DAYS * DAY;
    for (const [method, path] of [
      ['GET', '/v1/snapshots'],
      ['GET', '/v1/snapshots/latest'],
      ['GET', '/v1/snapshots/1'],
      ['GET', '/v1/snapshots/1/chunks/0'],
      ['GET', '/v1/lease'],
      ['DELETE', `/v1/uploads/${UUID}`],
    ] as const) {
      const response = await call('acct-a', method, path);
      expect(response.status).toBe(410);
      expect(response.body).toMatchObject({ error: 'retention_expired' });
    }
    // Writes keep the lapsed answer.
    expect((await call('acct-a', 'POST', '/v1/uploads', '{}')).status).toBe(
      402,
    );
  });

  it('records the lapse once and resets it on reactivation', async () => {
    const store = h.relay.operatorView.bind(h.relay);
    expect((await store('acct-a')).lapsedAt).toBeNull();
    const first = h.clock.now;
    lapse('acct-a');
    await call('acct-a', 'GET', '/v1/snapshots');
    const view = await store('acct-a');
    expect(view.lapsedAt).toBe(new Date(first).toISOString());
    expect(view.lapseRetentionEndsAt).toBe(
      new Date(first + WINDOW_DAYS * DAY).toISOString(),
    );
    // Later requests do not slide the window.
    h.clock.now += 5 * DAY;
    await call('acct-a', 'GET', '/v1/snapshots');
    expect((await store('acct-a')).lapsedAt).toBe(
      new Date(first).toISOString(),
    );

    enabled.add('acct-a');
    expect((await call('acct-a', 'GET', '/v1/snapshots')).status).toBe(200);
    expect((await store('acct-a')).lapsedAt).toBeNull();
    await upload('acct-a', 3);

    // A new lapse starts a new window.
    const second = h.clock.now;
    lapse('acct-a');
    await call('acct-a', 'GET', '/v1/snapshots');
    expect((await store('acct-a')).lapsedAt).toBe(
      new Date(second).toISOString(),
    );
  });
});

describe('denials that are not a lapse', () => {
  beforeEach(async () => {
    await setup(['acct-a', 'acct-fresh']);
  });

  it('keeps the upgrade answer for an account with no snapshots', async () => {
    lapse('acct-fresh');
    const response = await call('acct-fresh', 'GET', '/v1/snapshots');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'feature_upgrade_required' });
    expect((await h.relay.operatorView('acct-fresh')).lapsedAt).toBeNull();
  });

  it('keeps the disabled answer when an operator override turned it off', async () => {
    await upload('acct-a', 1);
    disabledByOperator.add('acct-a');
    const response = await call('acct-a', 'GET', '/v1/snapshots');
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'feature_disabled' });
    expect((await h.relay.operatorView('acct-a')).lapsedAt).toBeNull();
  });
});

describe('lapse retention configuration', () => {
  it('defaults to 90 days and validates the setting', async () => {
    await setup(['acct-a']);
    expect(h.relay.policy.retention.lapseRetentionDays).toBe(WINDOW_DAYS);
    await h.close();
    h = await createHarness({ policy: DEFAULT_POLICY });
    expect(h.relay.policy.retention.lapseRetentionDays).toBe(90);
    expect(h.relay.policy.retention.lapseRetentionMs).toBe(90 * DAY);
    for (const days of [0, -1, 1.5, 3651, Number.NaN]) {
      await expect(
        createHarness({
          policy: {
            ...DEFAULT_POLICY,
            retention: {
              ...DEFAULT_POLICY.retention,
              lapseRetentionDays: days,
            },
          },
        }),
      ).rejects.toThrow('lapseRetentionDays');
    }
  });
});

describe('lapse sweep', () => {
  const accounts = ['acct-old', 'acct-old2', 'acct-in', 'acct-ok', 'acct-back'];

  beforeEach(async () => {
    await setup(accounts);
    for (const account of accounts) {
      await upload(account, 1);
      await upload(account, 2);
    }
    // Two accounts lapse and are seen by the relay; one lapses and returns.
    for (const account of ['acct-old', 'acct-old2', 'acct-back']) {
      lapse(account);
      await call(account, 'GET', '/v1/snapshots');
    }
    h.clock.now += (WINDOW_DAYS + 1) * DAY;
    lapse('acct-in');
    await call('acct-in', 'GET', '/v1/snapshots');
    enabled.add('acct-back');
  });

  async function sweep(options: Record<string, unknown> = {}) {
    return h.relay.sweepLapsedAccounts({ operator: 'ops@test', ...options });
  }

  it('dry run reports the due accounts and changes nothing', async () => {
    const before = await listObjects();
    const result = await sweep({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.swept.map((entry) => entry.account).sort()).toEqual(
      [accountHandle('acct-old'), accountHandle('acct-old2')].sort(),
    );
    expect(result.swept[0]).toMatchObject({ snapshots: 2, bytes: 16 });
    expect(await listObjects()).toBe(before);
    expect(await h.relay.operatorView('acct-old')).toMatchObject({
      snapshots: [{}, {}],
    });
    expect(
      await new (await import('../metadata-store.js')).VaultRelayStore(
        h.db,
      ).listAudit(10),
    ).toEqual([]);
  });

  it('deletes only lapsed accounts past the window, with an audit trail', async () => {
    const result = await sweep();
    expect(result.swept).toHaveLength(2);
    const skipped = Object.fromEntries(
      result.skipped.map((entry) => [entry.account, entry.reason]),
    );
    expect(skipped[accountHandle('acct-back')]).toBe('entitled');

    for (const account of ['acct-old', 'acct-old2']) {
      const view = await h.relay.operatorView(account);
      expect(view.snapshots).toEqual([]);
      expect(view.usage).toMatchObject({ usedBytes: 0, usedSnapshots: 0 });
    }
    // Entitled, in-window and returned accounts keep every snapshot.
    for (const account of ['acct-ok', 'acct-in', 'acct-back']) {
      expect((await h.relay.operatorView(account)).snapshots).toHaveLength(2);
    }
    expect(await listObjects()).toBe(6);

    const { VaultRelayStore } = await import('../metadata-store.js');
    const audit = await new VaultRelayStore(h.db).listAudit(20);
    expect(audit).toHaveLength(4);
    const completed = audit.filter(
      (entry) => entry.action === 'lapse_sweep_completed',
    );
    expect(completed).toHaveLength(2);
    for (const entry of completed) {
      expect(entry.operator).toBe('ops@test');
      expect(entry.snapshots).toBe(2);
      expect(entry.bytes).toBe(16);
      expect(entry.at).toBe(h.clock.now);
      expect(entry.accountHandle).toMatch(/^[0-9a-f]+$/);
      expect(JSON.stringify(entry)).not.toContain('acct-old');
    }
    expect(
      audit.filter((entry) => entry.action === 'lapse_sweep_started'),
    ).toHaveLength(2);

    // Reads of a swept account stay refused; the returned account is intact.
    expect((await call('acct-old', 'GET', '/v1/snapshots')).status).toBe(410);
    expect((await call('acct-back', 'GET', '/v1/snapshots')).status).toBe(200);
  });

  it('is idempotent and never re-audits a swept account', async () => {
    await sweep();
    const { VaultRelayStore } = await import('../metadata-store.js');
    const second = await sweep();
    expect(second.swept).toEqual([]);
    expect(await new VaultRelayStore(h.db).listAudit(20)).toHaveLength(4);
  });

  it('is bounded per run and resumes where the last run stopped', async () => {
    const swept: string[] = [];
    let runs = 0;
    for (;;) {
      const run = await sweep({ limit: 1 });
      expect(run.swept.length).toBeLessThanOrEqual(1);
      swept.push(...run.swept.map((entry) => entry.account));
      runs += 1;
      if (!run.more) break;
      expect(runs).toBeLessThan(10);
    }
    expect(runs).toBeGreaterThan(1);
    expect(swept.sort()).toEqual(
      [accountHandle('acct-old'), accountHandle('acct-old2')].sort(),
    );
  });

  it('starts the window for a lapse the relay never observed', async () => {
    // acct-ok lapses, but none of its devices call again.
    lapse('acct-ok');
    const run = await sweep({ limit: 100 });
    expect(run.discovered).toBeGreaterThanOrEqual(1);
    expect((await h.relay.operatorView('acct-ok')).lapsedAt).toBe(
      new Date(h.clock.now).toISOString(),
    );
    // Discovery does not delete: the window starts now.
    expect((await h.relay.operatorView('acct-ok')).snapshots).toHaveLength(2);
    h.clock.now += (WINDOW_DAYS + 1) * DAY;
    const later = await sweep();
    expect(later.swept.map((entry) => entry.account)).toContain(
      accountHandle('acct-ok'),
    );
  });

  it('a dry run records no lapse', async () => {
    lapse('acct-ok');
    const run = await sweep({ dryRun: true, limit: 100 });
    expect(run.discovered).toBeGreaterThanOrEqual(1);
    expect((await h.relay.operatorView('acct-ok')).lapsedAt).toBeNull();
  });

  it('rejects invalid options', async () => {
    await expect(sweep({ limit: 0 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(sweep({ limit: 101 })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(sweep({ cursor: 'a b' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    await expect(
      h.relay.sweepLapsedAccounts({ operator: '' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('is an admin route that records the operator from the token context', async () => {
    const unauthorized = await h.relay.handleAdmin(
      adminRequest('POST', '/admin/v1/lapse-sweep', {}, 'wrong-token'),
    );
    expect(unauthorized.status).toBe(401);

    const bad = await h.relay.handleAdmin(
      adminRequest('POST', '/admin/v1/lapse-sweep', { limit: 'x' }),
    );
    expect(bad.status).toBe(400);

    const dry = await h.relay.handleAdmin(
      adminRequest('POST', '/admin/v1/lapse-sweep', { dryRun: true }),
    );
    expect(dry.status).toBe(200);
    expect(((await dry.json()) as { swept: unknown[] }).swept).toHaveLength(2);

    const request = adminRequest('POST', '/admin/v1/lapse-sweep', {});
    request.headers.set('x-vault-operator', 'will');
    const real = await h.relay.handleAdmin(request);
    expect(real.status).toBe(200);
    const body = (await real.json()) as { operator: string; swept: unknown[] };
    expect(body.swept).toHaveLength(2);
    expect(body.operator).toMatch(/^will\/token:[0-9a-f]{12}$/);
    expect(body.operator).not.toContain('test-admin-token');
  });
});
