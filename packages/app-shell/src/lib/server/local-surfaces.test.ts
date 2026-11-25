// The desktop is unchanged by the cloud profile (#5191). Its own file: the cloud
// profile puts the shell models in `required` tenancy for the life of the
// process (core's runtime overrides are monotonic), so the local cases must not
// share a process with a cloud case.
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
import { resolveAssistantOptions } from './assistant/config.ts';
import { cloudSignInOptions } from './cloud-auth.ts';
import { configureShell, requireLocalProfile } from './host.ts';
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
