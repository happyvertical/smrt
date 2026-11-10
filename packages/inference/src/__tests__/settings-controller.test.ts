/**
 * The shared settings controller (the template and the app shell both wire
 * their pages to it): a key write is refused without the customize
 * permission, a refusal names no key, and a stored key shows as set while no
 * key is ever returned. The host is a stand-in so no database is needed.
 */
import { describe, expect, it, vi } from 'vitest';
import { createInferenceSettingsController } from '../settings/controller.js';
import type { InferenceSettingsHost } from '../settings/host.js';
import { CUSTOMIZE_INFERENCE_PERMISSION } from '../settings/preferences.js';

const API_KEY = 'sk-test-controller-0123456789';

function setup(options: { can: boolean }) {
  const written: unknown[] = [];
  let stored = false;
  const userResolver = {
    write: vi.fn(async (_level: string, config: unknown) => {
      written.push(config);
      stored = true;
    }),
    resolveBindings: vi.fn(async () => ({
      tiers: {},
      ...(stored ? { user: { hasApiKey: true } } : {}),
    })),
  };
  const host = {
    userResolver: () => userResolver,
    settingsService: vi.fn(),
  } as unknown as InferenceSettingsHost;
  const controller = createInferenceSettingsController({
    host,
    preferenceStore: async () => ({
      load: async () => ({
        tenant: { payload: {}, revision: null },
        user: null,
        issues: [],
        canCustomize: { tenant: true, user: true },
      }),
      save: async () => ({ ok: true }),
      reset: async () => ({ ok: true }),
    }),
  });
  const session = {
    tenantId: 'tenant-1',
    can: (permission: string) =>
      options.can && permission === CUSTOMIZE_INFERENCE_PERMISSION,
  };
  return { controller, session, userResolver, written };
}

describe('createInferenceSettingsController', () => {
  it('refuses saveKey without the customize permission and stores nothing', async () => {
    const { controller, session, userResolver } = setup({ can: false });
    expect(controller.canCustomize(session)).toBe(false);
    const outcome = await controller.saveKey(session, {
      provider: 'openai',
      key: API_KEY,
    });
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    expect(userResolver.write).not.toHaveBeenCalled();
  });

  it('stores a key for the permitted session through the user resolver', async () => {
    const { controller, session, written } = setup({ can: true });
    const outcome = await controller.saveKey(session, {
      provider: 'openai',
      key: API_KEY,
    });
    expect(outcome).toEqual({ ok: true, message: 'Saved.' });
    expect(written).toHaveLength(1);
  });

  it('answers a key it cannot bind with a message that does not echo it', async () => {
    const { controller, session } = setup({ can: true });
    const outcome = await controller.saveKey(session, {
      provider: 'no-such-provider-xyz',
      key: API_KEY,
    });
    expect(outcome.ok).toBe(false);
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
  });
});
