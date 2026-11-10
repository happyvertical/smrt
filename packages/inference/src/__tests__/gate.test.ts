/**
 * The hosted inference gate (`./gate`, #4760) over fake kill-switch and
 * spend stores: order of checks, per-user scope, warnings, registration.
 * End-to-end runs over real plans and override rows live in
 * smrt-subscriptions' `hosted-ai-spend*.test.ts`.
 */
import {
  getAiUsageUserResolver,
  getInferenceGate,
  type InferenceGateRequest,
  InferenceUnavailableError,
  setAiUsageUserResolver,
  setInferenceGate,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHostedInferenceGate,
  getHostedInferenceSwitch,
  HOSTED_INFERENCE_KILL_SWITCH,
  type HostedKillSwitchStore,
  type HostedSpendDecision,
  registerHostedInferenceGate,
  setHostedInferenceEnabled,
} from '../gate.js';

const REQUEST: InferenceGateRequest = {
  tierRequested: 'auto',
  tier: 'good',
  target: { provider: 'openai', source: 'hosted' },
};

function switches(
  state: { enabled: boolean; disabledBy?: 'global' | 'tenant' } = {
    enabled: true,
  },
): HostedKillSwitchStore & { read: ReturnType<typeof vi.fn> } {
  return {
    read: vi.fn(async (key: string) => ({ key, ...state })),
    set: vi.fn(async (key: string, options: { enabled: boolean }) => ({
      key,
      enabled: options.enabled,
    })),
  };
}

function spendAnswering(decision: Partial<HostedSpendDecision> = {}) {
  return {
    evaluate: vi.fn(async (_input: { tenantId: string; userId?: string }) => ({
      state: 'ok' as const,
      entitled: true,
      decidedBy: null,
      ...decision,
    })),
    invalidate: vi.fn(),
  };
}

afterEach(() => {
  setInferenceGate(undefined);
  setAiUsageUserResolver(undefined);
});

describe('createHostedInferenceGate (#4760)', () => {
  it('checks the kill switch first, without reading spend', async () => {
    const spend = spendAnswering();
    const killSwitch = switches({ enabled: false, disabledBy: 'global' });
    const gate = createHostedInferenceGate({
      killSwitch,
      spend,
      principal: () => ({ tenantId: 't1', userId: 'u1' }),
    });
    await expect(gate.check(REQUEST)).resolves.toEqual({
      action: 'block',
      details: { policy: 'kill-switch', disabledBy: 'global' },
    });
    expect(killSwitch.read).toHaveBeenCalledWith(HOSTED_INFERENCE_KILL_SWITCH, {
      tenantId: 't1',
    });
    expect(spend.evaluate).not.toHaveBeenCalled();
  });

  it('blocks a hosted call with no tenant to bill', async () => {
    const gate = createHostedInferenceGate({
      killSwitch: switches(),
      spend: spendAnswering(),
      principal: () => undefined,
    });
    await expect(gate.check(REQUEST)).resolves.toEqual({
      action: 'block',
      details: { policy: 'no-tenant' },
    });
  });

  it("meters the principal's user only in its own tenant, never for shared clients", async () => {
    const spend = spendAnswering();
    const gate = createHostedInferenceGate({
      killSwitch: switches(),
      spend,
      principal: () => ({ tenantId: 'T1', userId: 'u1' }),
    });
    await gate.check({ ...REQUEST, tenantId: 't1' });
    await gate.check({ ...REQUEST, tenantId: 't2' });
    await gate.check({ ...REQUEST, tenantId: 't1', userId: null });
    expect(spend.evaluate.mock.calls.map(([input]) => input)).toEqual([
      { tenantId: 't1', userId: 'u1' },
      { tenantId: 't2' },
      { tenantId: 't1' },
    ]);
  });

  it('maps spend decisions to block / warn / allow', async () => {
    const resetsAt = new Date('2026-12-01T00:00:00.000Z');
    const blocked = createHostedInferenceGate({
      killSwitch: switches(),
      spend: spendAnswering({
        state: 'blocked',
        decidedBy: { policy: 'tenant-cap', cap: 10, spend: 12, resetsAt },
      }),
      principal: () => ({ tenantId: 't1' }),
    });
    await expect(blocked.check(REQUEST)).resolves.toEqual({
      action: 'block',
      details: {
        policy: 'tenant-cap',
        cap: 10,
        spend: 12,
        resetsAt: '2026-12-01T00:00:00.000Z',
      },
    });

    const onWarning = vi.fn(() => {
      throw new Error('sink down');
    });
    const warned = createHostedInferenceGate({
      killSwitch: switches(),
      spend: spendAnswering({
        state: 'warn',
        decidedBy: { policy: 'user-cap', cap: 10, spend: 9, resetsAt: null },
      }),
      principal: () => ({ tenantId: 't1', userId: 'u1' }),
      onWarning,
    });
    await expect(warned.check(REQUEST)).resolves.toEqual({
      action: 'warn',
      details: { policy: 'user-cap', cap: 10, spend: 9 },
    });
    expect(onWarning).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 't1', userId: 'u1' }),
    );

    const unentitled = createHostedInferenceGate({
      killSwitch: switches(),
      spend: spendAnswering({ entitled: false }),
      principal: () => ({ tenantId: 't1' }),
    });
    await expect(unentitled.check(REQUEST)).resolves.toEqual({
      action: 'block',
      details: { policy: 'subscription' },
    });
  });

  it('refuses a blocked decision that names no cap (core fails closed)', async () => {
    const gate = createHostedInferenceGate({
      killSwitch: switches(),
      spend: spendAnswering({ state: 'blocked', decidedBy: null }),
      principal: () => ({ tenantId: 't1' }),
    });
    await expect(gate.check(REQUEST)).rejects.toThrow(/without a cap/);
  });

  it('forwards invalidate() to the spend evaluator', () => {
    const spend = spendAnswering();
    createHostedInferenceGate({ killSwitch: switches(), spend }).invalidate(
      't1',
    );
    expect(spend.invalidate).toHaveBeenCalledWith('t1');
  });
});

describe('registerHostedInferenceGate (#4760)', () => {
  it("registers the gate and the principal's user as the usage tag", () => {
    const gate = registerHostedInferenceGate({
      killSwitch: switches(),
      spend: spendAnswering(),
      principal: () => ({ tenantId: 't1', userId: ' u1 ' }),
    });
    expect(getInferenceGate()).toBe(gate);
    expect(getAiUsageUserResolver()?.()).toBe('u1');
  });
});

describe('kill switch helpers (#4760)', () => {
  it('reads and writes the inference.hosted.enabled key', async () => {
    const store = switches();
    await getHostedInferenceSwitch(store, { tenantId: 't1' });
    expect(store.read).toHaveBeenCalledWith('inference.hosted.enabled', {
      tenantId: 't1',
    });
    await setHostedInferenceEnabled(store, { enabled: false });
    expect(store.set).toHaveBeenCalledWith('inference.hosted.enabled', {
      enabled: false,
    });
    await expect(
      setHostedInferenceEnabled({ read: store.read }, { enabled: true }),
    ).rejects.toThrow(/read-only/);
  });

  it('keeps the entitlement error type core throws', () => {
    expect(
      new InferenceUnavailableError({
        reason: 'entitlement',
        mode: 'hosted',
        entitlement: { policy: 'kill-switch', disabledBy: 'tenant' },
      }).message,
    ).toBe('Hosted AI is paused.');
  });
});
