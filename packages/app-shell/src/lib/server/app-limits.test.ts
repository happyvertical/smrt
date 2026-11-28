// Per-app caps in a running cloud shell (#5503): the shell passes `appLimits`
// to the live host and to a draft host it reopens, per tenant; the desktop
// passes none. SQLite, two tenants, no containers.

import { afterEach, describe, expect, it } from 'vitest';
import { hostOwner } from '../../test/engine-principal.ts';
import { App } from '../objects/App.ts';
import {
  appLimitsFromEnv,
  cloudLimitsFromEnv,
  workerLimitsFromEnv,
} from './app-limits-env.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { startDraftWith } from './drafts.ts';
import { getDraftSlot, getHost, hostMetrics, sweepIdleHosts } from './host.ts';
import { runAs } from './owner.ts';
import { applyWaiting, openShell, type ShellHarness } from './test-support.ts';

let clock = 1_000_000;
let cloud: CloudHarness | null = null;
let local: ShellHarness | null = null;
afterEach(async () => {
  await cloud?.close();
  await local?.close();
  cloud = null;
  local = null;
});

const seen: string[] = [];
async function openCapped() {
  seen.length = 0;
  clock = 1_000_000;
  cloud = await openCloudShell({
    // Ann's app holds 2 records per model; Bob's is uncapped.
    appLimits: async (tenantId) => {
      seen.push(tenantId);
      return tenantId === cloud?.a.tenantId
        ? { maxRowsPerModel: 2 }
        : undefined;
    },
    lifecycle: {
      idleMs: 60_000,
      minIdleMs: 0,
      handoutMs: 20,
      now: () => clock,
    },
  });
  for (const o of [cloud.a, cloud.b]) {
    await runAs(o, () => App.defineModel('Chore', { title: { type: 'text' } }));
    await applyWaiting(o);
  }
  return cloud;
}
const add = (o: CloudHarness['a'], title: string) =>
  runAs(o, async () =>
    (await getHost()).create(hostOwner(await getHost()), 'Chore', { title }),
  );

describe('app limits in the cloud shell', () => {
  it("caps the live app of a tenant its plan caps, and only that tenant's", async () => {
    const { a, b } = await openCapped();
    await add(a, '1');
    await add(a, '2');
    await expect(add(a, '3')).rejects.toThrow(
      /app limit reached \(maxRowsPerModel\)/,
    );
    for (const t of ['1', '2', '3']) await add(b, t);
    expect(seen).toContain(a.tenantId);
    expect(seen).toContain(b.tenantId);
  });

  it('caps a draft reopened after the app slept', async () => {
    const { a } = await openCapped();
    await add(a, '1');
    await runAs(a, () =>
      startDraftWith(
        async ({ dir, store, live }) =>
          live.forkDraft(hostOwner(live), dir, { store }),
        'd',
        a.id,
      ),
    );
    // Put every app to sleep, then wake the draft: the shell reopens it.
    await new Promise((r) => setTimeout(r, 80));
    clock += 120_000;
    await sweepIdleHosts();
    expect(hostMetrics().open).toBe(0);
    const draft = (await runAs(a, () => getDraftSlot()))?.host;
    expect(draft).toBeTruthy();
    await draft?.create(hostOwner(draft!), 'Chore', { title: 'd1' });
    await expect(
      draft?.create(hostOwner(draft!), 'Chore', { title: 'd2' }),
    ).rejects.toThrow(/app limit reached \(maxRowsPerModel\)/);
  });

  it('the desktop passes none and never asks', async () => {
    let asked = 0;
    local = await openShell({
      appLimits: () => {
        asked++;
        return { maxRows: 1 };
      },
    });
    const { owner } = local;
    await runAs(owner, () =>
      App.defineModel('Chore', { title: { type: 'text' } }),
    );
    await applyWaiting(owner);
    const host = await runAs(owner, () => getHost());
    for (const t of ['1', '2', '3'])
      await host.create(hostOwner(host), 'Chore', { title: t });
    expect(await host.list(hostOwner(host), 'Chore')).toHaveLength(3);
    expect(asked).toBe(0);
  });
});

describe('route limits from the environment', () => {
  it('reads the client limit, the optional tenant limit and refuses a half set', () => {
    expect(
      appLimitsFromEnv({
        SMRT_APP_SHELL_ROUTE_LIMIT_MAX: '60',
        SMRT_APP_SHELL_ROUTE_LIMIT_WINDOW_MS: '60000',
        SMRT_APP_SHELL_ROUTE_LIMIT_TENANT_MAX: '600',
      }),
    ).toEqual({
      routeLimits: {
        client: { maxEvents: 60, windowMs: 60_000 },
        tenant: { maxEvents: 600, windowMs: 60_000 },
      },
    });
    expect(() =>
      appLimitsFromEnv({ SMRT_APP_SHELL_ROUTE_LIMIT_MAX: '60' }),
    ).toThrow(/needs SMRT_APP_SHELL_ROUTE_LIMIT_WINDOW_MS/);
    expect(() =>
      appLimitsFromEnv({
        SMRT_APP_SHELL_ROUTE_LIMIT_TENANT_MAX: '6',
        SMRT_APP_SHELL_ROUTE_LIMIT_WINDOW_MS: '1000',
      }),
    ).toThrow(/needs SMRT_APP_SHELL_ROUTE_LIMIT_MAX/);
  });
});

describe('appLimitsFromEnv', () => {
  it('is undefined when nothing is set, reads each cap, and refuses a bad one', () => {
    expect(appLimitsFromEnv({})).toBeUndefined();
    expect(
      appLimitsFromEnv({
        SMRT_APP_SHELL_MAX_MODELS: '5',
        SMRT_APP_SHELL_MAX_ROWS: '1000',
        SMRT_APP_SHELL_MAX_ROWS_PER_MODEL: '200',
        SMRT_APP_SHELL_MAX_METHOD_RUNS: '50',
        SMRT_APP_SHELL_METHOD_RUN_PERIOD_MS: '3600000',
      }),
    ).toEqual({
      maxModels: 5,
      maxRows: 1000,
      maxRowsPerModel: 200,
      maxMethodRuns: 50,
      methodRunPeriodMs: 3600000,
    });
    expect(() => appLimitsFromEnv({ SMRT_APP_SHELL_MAX_ROWS: '-1' })).toThrow(
      /SMRT_APP_SHELL_MAX_ROWS/,
    );
    expect(() =>
      appLimitsFromEnv({ SMRT_APP_SHELL_MAX_ROWS: '1.5' }),
    ).toThrow();
    expect(() =>
      appLimitsFromEnv({ SMRT_APP_SHELL_MAX_METHOD_RUNS: '5' }),
    ).toThrow(/PERIOD_MS/);
  });
});

describe('workerLimitsFromEnv', () => {
  it('reads the statement timeout, is undefined when unset, refuses a bad one', () => {
    expect(workerLimitsFromEnv({})).toBeUndefined();
    expect(
      workerLimitsFromEnv({ SMRT_APP_SHELL_STATEMENT_TIMEOUT_MS: '5000' }),
    ).toEqual({ statementTimeoutMs: 5000 });
    for (const bad of ['0', '-1', '2.5', 'soon'])
      expect(() =>
        workerLimitsFromEnv({ SMRT_APP_SHELL_STATEMENT_TIMEOUT_MS: bad }),
      ).toThrow(/STATEMENT_TIMEOUT_MS/);
  });
});

describe('strict numbers', () => {
  it('rejects hex, exponent, padded and signed values', () => {
    for (const bad of ['0x10', '1e3', ' 5 ', '+5', '5.0', '', ' '])
      if (bad.trim() !== '')
        expect(() =>
          appLimitsFromEnv({ SMRT_APP_SHELL_MAX_ROWS: bad }),
        ).toThrow(/SMRT_APP_SHELL_MAX_ROWS/);
    expect(appLimitsFromEnv({ SMRT_APP_SHELL_MAX_ROWS: '0' })).toEqual({
      maxRows: 0,
    });
  });
});

describe('cloudLimitsFromEnv', () => {
  const env = {
    SMRT_APP_SHELL_MAX_ROWS: 'bad',
    SMRT_APP_SHELL_STATEMENT_TIMEOUT_MS: 'bad',
  };
  it('never parses on the desktop or before the profile is known', () => {
    for (const p of ['local', null]) {
      const l = cloudLimitsFromEnv(() => p, env);
      expect(l.workerLimits).toBeUndefined();
      expect(l.appLimits()).toBeUndefined();
    }
  });
  it('reads both in cloud and refuses a bad value there', () => {
    const l = cloudLimitsFromEnv(() => 'cloud', {
      SMRT_APP_SHELL_MAX_ROWS: '7',
      SMRT_APP_SHELL_STATEMENT_TIMEOUT_MS: '900',
    });
    expect(l.appLimits()).toEqual({ maxRows: 7 });
    expect(l.workerLimits).toEqual({ statementTimeoutMs: 900 });
    expect(() => cloudLimitsFromEnv(() => 'cloud', env).appLimits()).toThrow();
  });
});
