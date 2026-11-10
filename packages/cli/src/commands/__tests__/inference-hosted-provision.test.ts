/**
 * `smrt inference:hosted provision|revoke` (#4759): budget parsing, output
 * shape, and that no key reaches the output. The provisioning itself is
 * covered in smrt-inference's `hosted.test.ts`.
 */
import type { HostedInferenceProvisioner } from '@happyvertical/smrt-inference/node';
import { describe, expect, it, vi } from 'vitest';
import { INFERENCE_HOSTED_SUBCOMMANDS } from '../inference-hosted.js';
import {
  inferenceHostedProvisionSubcommands,
  parseHostedBudget,
  runInferenceHosted,
} from '../inference-hosted-provision.js';
import { utilityCommands } from '../utilities.js';

function fakeProvisioner(): HostedInferenceProvisioner {
  return {
    provision: vi.fn(async ({ tenantId, userId, budget }) => ({
      tenantId,
      userId,
      status: 'active' as const,
      generation: 0,
      provider: 'litellm' as const,
      projectId: 'smrt-t1',
      keyId: 'key-id-1',
      keyAlias: 'smrt-t1-u1-g0',
      budget: { window: 'month' as const, ...budget },
      created: true,
    })),
    revoke: vi.fn(async ({ tenantId, userId }) => ({
      tenantId,
      userId,
      status: 'revoked' as const,
      generation: 1,
      keyId: 'key-id-1',
      keyAlias: 'smrt-t1-u1-g0',
      revoked: true,
      gateway: 'unsupported' as const,
      restored: 'prior' as const,
    })),
    syncBudget: vi.fn(),
    status: vi.fn(),
    listActive: vi.fn(),
    revokeTenant: vi.fn(),
    syncTenantBudget: vi.fn(),
  } as unknown as HostedInferenceProvisioner;
}

describe('parseHostedBudget', () => {
  it('reads micro-dollars or exact USD, never floats', () => {
    expect(parseHostedBudget({ 'budget-micros': '2500000' })).toEqual({
      limitMicros: 2_500_000,
    });
    expect(parseHostedBudget({ 'budget-usd': '7.5', window: 'Week' })).toEqual({
      limitMicros: 7_500_000,
      window: 'week',
    });
    expect(parseHostedBudget({ 'budget-usd': '0.000001' })).toEqual({
      limitMicros: 1,
    });
    expect(parseHostedBudget({ 'budget-usd': '20.10' })).toEqual({
      limitMicros: 20_100_000,
    });
  });

  it('refuses missing, doubled, fractional-micro and zero budgets', () => {
    expect(() => parseHostedBudget({})).toThrow(/exactly one/);
    expect(() =>
      parseHostedBudget({ 'budget-micros': '1', 'budget-usd': '1' }),
    ).toThrow(/exactly one/);
    expect(() => parseHostedBudget({ 'budget-micros': '1.5' })).toThrow();
    expect(() => parseHostedBudget({ 'budget-usd': '1.0000001' })).toThrow();
    expect(() => parseHostedBudget({ 'budget-usd': '0' })).toThrow(/zero/);
    expect(() =>
      parseHostedBudget({ 'budget-micros': '1', window: 'hour' }),
    ).toThrow(/--window/);
  });
});

describe('runInferenceHosted', () => {
  it('provisions with the parsed budget and prints alias and budget', async () => {
    const provisioner = fakeProvisioner();
    const lines: string[] = [];
    await runInferenceHosted(
      'provision',
      { tenant: 't1', user: 'u1', 'budget-usd': '20' },
      { provisioner, log: (line) => lines.push(line) },
    );
    expect(provisioner.provision).toHaveBeenCalledWith({
      tenantId: 't1',
      userId: 'u1',
      budget: { limitMicros: 20_000_000 },
    });
    expect(lines.join('\n')).toContain('smrt-t1-u1-g0');
    expect(lines.join('\n')).toContain('$20 per month');
  });

  it('revokes and tells the operator to revoke an unsupported key by hand', async () => {
    const provisioner = fakeProvisioner();
    const lines: string[] = [];
    await runInferenceHosted(
      'revoke',
      { tenant: 't1', user: 'u1', json: false },
      { provisioner, log: (line) => lines.push(line) },
    );
    expect(provisioner.revoke).toHaveBeenCalledWith({
      tenantId: 't1',
      userId: 'u1',
      reason: 'operator',
    });
    expect(lines.join('\n')).toMatch(/by hand.*key-id-1|key-id-1.*by hand/);
  });

  it('says a failed gateway delete is owed and retried', async () => {
    const provisioner = fakeProvisioner();
    vi.mocked(provisioner.revoke).mockResolvedValueOnce({
      tenantId: 't1',
      userId: 'u1',
      status: 'revoked',
      generation: 1,
      keyId: 'key-id-1',
      keyAlias: 'smrt-t1-u1-g0',
      revoked: true,
      gateway: 'failed',
      restored: 'prior',
    });
    const lines: string[] = [];
    await runInferenceHosted(
      'revoke',
      { tenant: 't1', user: 'u1', json: false },
      { provisioner, log: (line) => lines.push(line) },
    );
    expect(lines.join('\n')).toContain('owed');
    expect(lines.join('\n')).not.toContain('by hand');
  });

  it('prints JSON without any key value', async () => {
    const provisioner = fakeProvisioner();
    const lines: string[] = [];
    const result = await runInferenceHosted(
      'provision',
      { tenant: 't1', user: 'u1', 'budget-micros': '1', json: true },
      { provisioner, log: (line) => lines.push(line) },
    );
    expect(JSON.parse(lines.join('\n'))).toEqual(result);
    expect(Object.keys(result)).not.toContain('apiKey');
    expect(Object.keys(result)).not.toContain('key');
  });

  it('requires tenant and user', async () => {
    await expect(
      runInferenceHosted(
        'revoke',
        { user: 'u1' },
        { provisioner: fakeProvisioner(), log: () => {} },
      ),
    ).rejects.toThrow('--tenant is required');
  });
});

describe('command registration', () => {
  it('registers provision and revoke in the shared inference:hosted group', () => {
    expect(Object.keys(inferenceHostedProvisionSubcommands)).toEqual([
      'provision',
      'revoke',
    ]);
    expect(INFERENCE_HOSTED_SUBCOMMANDS.provision).toBe(
      inferenceHostedProvisionSubcommands.provision,
    );
    expect(Object.keys(INFERENCE_HOSTED_SUBCOMMANDS).sort()).toEqual([
      'disable',
      'enable',
      'provision',
      'revoke',
      'status',
    ]);
    expect(utilityCommands['inference:hosted']).toBeDefined();
    expect(utilityCommands['inference:hosted provision']).toBeUndefined();
  });
});
