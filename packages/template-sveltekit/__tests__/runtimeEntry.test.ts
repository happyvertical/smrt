/**
 * The template's server wiring onto `@happyvertical/smrt-app-runtime/sveltekit`
 * (#3369). Request ordering, tenant selection, session/tenant authorization,
 * owner bootstrap, health, and diagnostics authorization are proven in
 * app-runtime's `src/sveltekit.test.ts`; the M5 browser gate proves them end
 * to end in a served copy. This file proves the template mounts that runtime
 * and its handlers rather than a local copy, using only paths that never
 * initialize application storage.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as hooks from '../template/src/hooks.server.js';
import * as smrtModule from '../template/src/lib/server/smrt.js';
import { runtime } from '../template/src/lib/server/smrt.js';
import { load as layoutLoad } from '../template/src/routes/+layout.server.js';
import { GET as diagnosticsGet } from '../template/src/routes/api/_runtime/diagnostics/+server.js';
import {
  actions as setupActions,
  load as setupLoad,
} from '../template/src/routes/setup/+page.server.js';

const anonymousLocals = {
  user: null,
  membership: null,
  permissions: [],
  tenantId: null,
  sessionId: null,
  selectedTenantId: null,
  selectedTenantSlug: null,
};

describe('template runtime entry', () => {
  it('reduces smrt.ts to the runtime and its options (#3416)', () => {
    // Generated routes resolve collections through runtime.getCollection(),
    // the smrt() plugin injects the generated registration, and the runtime
    // holds the local writer lease by default: none of it is app code.
    expect(Object.keys(smrtModule)).toEqual(['runtime']);
    expect(typeof runtime.getCollection).toBe('function');
    const source = readFileSync(
      join(process.cwd(), 'template/src/lib/server/smrt.ts'),
      'utf8',
    );
    expect(source).not.toContain('smrt-register');
    expect(source).not.toContain('isMissingRegisterModule');
    expect(source).not.toContain('loadManifestFromPathSync');
    expect(source).not.toMatch(/acquireWriterLease\(/);
    expect(source).not.toMatch(/export (async )?function/);
  });

  it('mounts the shared runtime handle and startup gate', () => {
    expect(hooks.handle).toBe(runtime.handle);
    expect(hooks.init).toBe(runtime.init);
    expect(Object.keys(hooks).sort()).toEqual(['handle', 'init']);
  });

  it('keeps the selected URL tenant out of the authorized session summary', () => {
    expect(
      layoutLoad({
        locals: {
          ...anonymousLocals,
          selectedTenantId: 'tenant-from-hostname',
          selectedTenantSlug: 'acme',
        },
      }),
    ).toEqual({
      session: {
        authenticated: false,
        activeTenantId: null,
        selectedTenantSlug: 'acme',
      },
    });
  });

  it('rejects unauthenticated diagnostics before reading the runtime', async () => {
    const response = (await diagnosticsGet({
      locals: anonymousLocals,
    } as never)) as Response;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      error: { code: 'authentication_required' },
    });
  });

  it('sends a signed-in visitor away from owner setup', async () => {
    await expect(
      setupLoad({
        url: new URL('http://127.0.0.1:5173/setup?token=abc'),
        locals: { ...anonymousLocals, user: { id: 'owner' } },
        getClientAddress: () => '127.0.0.1',
      }),
    ).rejects.toMatchObject({ status: 303, location: '/' });
  });

  it('refuses owner setup from a non-loopback client before reading the form', async () => {
    let bodyRead = false;
    const request = new Request('http://127.0.0.1:5173/setup', {
      method: 'POST',
      body: new URLSearchParams({ token: 't', name: 'n', email: 'a@b.c' }),
    });
    const result = await setupActions.default({
      url: new URL('http://127.0.0.1:5173/setup'),
      locals: anonymousLocals,
      getClientAddress: () => '203.0.113.7',
      request: new Proxy(request, {
        get(target, property) {
          if (property === 'formData') bodyRead = true;
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
      cookies: {
        set() {
          throw new Error('no session may be issued');
        },
      },
    });
    expect(result).toMatchObject({
      status: 403,
      data: { code: 'setup_unavailable' },
    });
    expect(bodyRead).toBe(false);
  });
});
