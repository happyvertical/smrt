// What must NOT exist in the cloud profile (#5191): the loopback owner link,
// the local owner bootstrap page, any engine that runs a program or signs in
// on the server's machine, an operator-paid assistant key, the desktop's
// workbook import runner. Each is refused as a 404 (or "unavailable") before
// anything of the runtime is touched, and each still works in the local
// profile (the desktop is unchanged).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The runtime stand-in records every property a route reads from it. In the
// cloud profile the owner link and setup page must read none at request time.
const touched = vi.hoisted(() => [] as string[]);
vi.mock('$lib/server/smrt', () => ({
  runtime: new Proxy(
    {},
    {
      get(_target, prop) {
        touched.push(String(prop));
        return () => {
          throw new Error(`the runtime was reached: ${String(prop)}`);
        };
      },
    },
  ),
}));

import * as ownerLink from '../../routes/api/_runtime/owner-link/+server.ts';
import * as signInCallback from '../../routes/auth/[provider]/callback/+server.ts';
import * as signInLogin from '../../routes/auth/[provider]/login/+server.ts';
import { resolveAssistantOptions } from './assistant/config.ts';
import { cloudSignInOptions } from './cloud-auth.ts';
import { type CloudHarness, openCloudShell } from './cloud-test-support.ts';
import { configureShell, requireLocalProfile } from './host.ts';
import { mountOnboardingRoutes } from './onboarding.ts';
import { openShell, type ShellHarness } from './test-support.ts';

const SECRET_ENV = 'SMRT_DESKTOP_OWNER_LINK_SECRET';
const SECRET = 'c'.repeat(64);

function linkEvent() {
  const url = new URL(
    `http://127.0.0.1:3000/api/_runtime/owner-link?launch=${SECRET}`,
  );
  return {
    url,
    request: new Request(url, { headers: { host: url.host } }),
    getClientAddress: () => '127.0.0.1',
  } as never;
}

describe('cloud profile', () => {
  let h: CloudHarness;
  beforeEach(async () => {
    h = await openCloudShell();
    vi.stubEnv(SECRET_ENV, SECRET);
    touched.length = 0;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await h.close();
  });

  it('has no owner link: a loopback peer with the right secret still gets a 404', async () => {
    const response = await ownerLink.GET(linkEvent());
    expect(response.status).toBe(404);
    expect(touched).toEqual([]);
  });

  it('has no local owner setup page', async () => {
    const setup = await import('../../routes/setup/+page.server.ts');
    touched.length = 0;
    await expect(
      setup.load({ url: new URL('http://127.0.0.1/setup') } as never),
    ).rejects.toMatchObject({ status: 404 });
    await expect(setup.actions.default({} as never)).rejects.toMatchObject({
      status: 404,
    });
    expect(touched).toEqual([]);
  });

  it('never reads or writes app_imports (the one shell table with no tenancy or policy)', async () => {
    const { createShellImportService } = await import('./import-workflow.ts');
    const service = createShellImportService({
      db: h.db,
      root: h.dir,
    } as never);
    await expect(service.current(h.a)).rejects.toMatchObject({
      code: 'not_found',
    });
    service.dispose();
  });

  it('serves the account sign-in routes (cloud only)', async () => {
    expect(typeof signInLogin.GET).toBe('function');
    expect(typeof signInCallback.GET).toBe('function');
    await expect(cloudSignInOptions()).resolves.toBeTruthy();
  });

  it('refuses every local engine route (agent CLI and Sign in with ChatGPT)', async () => {
    const routes = mountOnboardingRoutes();
    const event = {
      url: new URL('https://app.example.test/api/shell/onboarding'),
      request: new Request('https://app.example.test/api/shell/onboarding', {
        method: 'POST',
      }),
      locals: {},
      params: {},
    } as never;
    for (const name of [
      'connect',
      'engine',
      'chatgpt',
      'chatgptState',
    ] as const) {
      const response = await routes[name](event);
      expect(response.status, name).toBe(404);
    }
    await expect(requireLocalProfile('x')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('uses no key but the owner’s own: the deployment’s key is ignored', async () => {
    await expect(
      resolveAssistantOptions(h.a, {
        env: { ANTHROPIC_API_KEY: 'sk-ant-operator-key' },
      }),
    ).rejects.toMatchObject({ code: 'assistant_not_configured' });
  });
});

describe('local profile (the desktop) is unchanged', () => {
  let h: ShellHarness;
  beforeEach(async () => {
    h = await openShell();
    vi.stubEnv(SECRET_ENV, SECRET);
    touched.length = 0;
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await h.close();
  });

  it('still answers the owner link through the runtime handler', async () => {
    // With the runtime stand-in the handler's first runtime read throws: the
    // point is that the local profile DOES reach the handler.
    await Promise.resolve(ownerLink.GET(linkEvent())).catch(() => {});
    expect(touched.length).toBeGreaterThan(0);
  });

  it('has no cloud sign-in', async () => {
    await expect(cloudSignInOptions()).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(await requireLocalProfile('x')).toBeUndefined();
  });

  it('keeps the deployment key for the assistant', async () => {
    const options = await resolveAssistantOptions(h.owner, {
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-key-for-local' },
    });
    expect(JSON.stringify(options)).toContain('anthropic');
  });

  it('refuses a profile that is not local or cloud', async () => {
    configureShell({
      db: async () => h.db,
      dataRoot: async () => h.dir,
      profile: async () => 'self-hosted' as never,
    });
    await expect(requireLocalProfile('x')).rejects.toThrow(/not known/);
  });
});
