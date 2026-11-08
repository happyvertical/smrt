/**
 * `smrt inference:hosted disable | enable | status [--tenant]` (#4760): the
 * kill switch writes and reads `inference.hosted.enabled` through the
 * project's smrt-features `KillSwitchService` (faked here), never calls a
 * model, and shares the command group with other subcommands (#4759).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatInferenceHostedHelp,
  INFERENCE_HOSTED_SUBCOMMANDS,
  inferenceHostedCommand,
} from '../inference-hosted.js';
import {
  createInferenceHostedSwitchSubcommands,
  formatHostedSwitchState,
  type InferenceHostedSwitchDeps,
} from '../inference-hosted-switch.js';

interface Row {
  enabled: boolean;
  disabledBy?: 'global' | 'tenant';
}

function fakeDeps(): InferenceHostedSwitchDeps & {
  writes: Array<{ key: string; enabled: boolean; tenantId?: string | null }>;
  closed: number;
} {
  const disabled = new Set<string>();
  const writes: Array<{
    key: string;
    enabled: boolean;
    tenantId?: string | null;
  }> = [];
  const state = (
    key: string,
    tenantId?: string | null,
  ): Row & { key: string } =>
    disabled.has('global')
      ? { key, enabled: false, disabledBy: 'global' }
      : tenantId && disabled.has(tenantId)
        ? { key, enabled: false, disabledBy: 'tenant' }
        : { key, enabled: true };
  const deps = {
    writes,
    closed: 0,
    openDatabase: async () => ({ db: {} as never, display: 'sqlite::memory:' }),
    closeDatabase: async () => {
      deps.closed += 1;
    },
    killSwitch: async () => ({
      read: async (key: string, options: { tenantId?: string | null }) =>
        state(key, options.tenantId),
      set: async (
        key: string,
        options: { enabled: boolean; tenantId?: string | null },
      ) => {
        writes.push({ key, ...options });
        const scope = options.tenantId ?? 'global';
        if (options.enabled) disabled.delete(scope);
        else disabled.add(scope);
        return state(key, options.tenantId);
      },
    }),
  };
  return deps;
}

describe('inference:hosted kill switch (#4760)', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    log.mockClear();
    error.mockClear();
    process.exitCode = undefined;
  });

  const output = () => log.mock.calls.map((call) => String(call[0])).join('\n');

  it('disables and enables globally and per tenant', async () => {
    const deps = fakeDeps();
    const sub = createInferenceHostedSwitchSubcommands(deps);

    await sub.disable.run([], { tenant: ' tenant-a ' });
    expect(deps.writes).toEqual([
      { key: 'inference.hosted.enabled', enabled: false, tenantId: 'tenant-a' },
    ]);
    expect(output()).toContain(
      'Hosted inference: DISABLED (tenant tenant-a; disabled for tenant tenant-a)',
    );

    await sub.disable.run([], {});
    log.mockClear();
    await sub.enable.run([], { tenant: 'tenant-a' });
    expect(output()).toContain('Still disabled: a global disable outranks');

    log.mockClear();
    await sub.enable.run([], {});
    await sub.status.run([], { tenant: 'tenant-a', json: true });
    expect(JSON.parse(log.mock.calls.at(-1)?.[0] as string)).toEqual({
      action: 'status',
      tenantId: 'tenant-a',
      key: 'inference.hosted.enabled',
      enabled: true,
    });
    expect(deps.closed).toBe(5);
    expect(process.exitCode).toBeUndefined();
  });

  it('refuses a blank --tenant and reports store failures with exit 1', async () => {
    const deps = fakeDeps();
    const sub = createInferenceHostedSwitchSubcommands(deps);
    await sub.disable.run([], { tenant: '  ' });
    expect(process.exitCode).toBe(1);
    expect(deps.writes).toEqual([]);

    process.exitCode = undefined;
    const failing = createInferenceHostedSwitchSubcommands({
      ...deps,
      killSwitch: async () => {
        throw new Error(
          'relation "_smrt_feature_overrides" does not exist (postgres://u:secret@db/x)',
        );
      },
    });
    await failing.disable.run([], {});
    expect(process.exitCode).toBe(1);
    const message = String(error.mock.calls.at(-1)?.[0]);
    expect(message).toContain('run `smrt db:migrate`');
    expect(message).not.toContain('secret');
  });

  it('formats every state', () => {
    expect(
      formatHostedSwitchState({ key: 'k', enabled: true }, undefined),
    ).toBe('Hosted inference: ENABLED (global)');
    expect(
      formatHostedSwitchState(
        { key: 'k', enabled: false, disabledBy: 'global' },
        't1',
      ),
    ).toBe('Hosted inference: DISABLED (tenant t1; disabled globally)');
  });
});

describe('inference:hosted command group', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  afterEach(() => {
    log.mockClear();
    error.mockClear();
    process.exitCode = undefined;
  });

  it('lists its subcommands and refuses unknown ones', async () => {
    expect(Object.keys(INFERENCE_HOSTED_SUBCOMMANDS)).toEqual(
      expect.arrayContaining(['disable', 'enable', 'status']),
    );
    expect(formatInferenceHostedHelp()).toContain('disable [--tenant <id>]');
    await inferenceHostedCommand.handler?.([], {});
    expect(String(log.mock.calls[0]?.[0])).toContain(
      'Usage: smrt inference:hosted',
    );
    await inferenceHostedCommand.handler?.(['constructor'], {});
    expect(process.exitCode).toBe(1);
  });
});
