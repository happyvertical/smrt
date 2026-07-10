import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  resolveTenant,
  selectTenantSlug,
} from '../template/src/lib/server/tenancy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templateDir = join(__dirname, '..', 'template');

function makeEvent(url: string, headers: Record<string, string> = {}) {
  return {
    url: new URL(url),
    request: new Request(url, { headers }),
  };
}

describe('tenant URL selection', () => {
  it('selects the leading label under an explicit base domain', () => {
    expect(
      selectTenantSlug(new URL('https://acme.example.co.uk/'), 'example.co.uk'),
    ).toBe('acme');
  });

  it('does not guess outside the configured base domain', () => {
    expect(
      selectTenantSlug(new URL('https://acme.attacker.test/'), 'example.com'),
    ).toBeNull();
  });

  it('rejects apex, reserved, localhost, and IP hosts', () => {
    expect(
      selectTenantSlug(new URL('https://example.com/'), 'example.com'),
    ).toBeNull();
    expect(
      selectTenantSlug(new URL('https://www.example.com/'), 'example.com'),
    ).toBeNull();
    expect(selectTenantSlug(new URL('http://localhost:5173/'))).toBeNull();
    expect(selectTenantSlug(new URL('http://127.0.0.1:5173/'))).toBeNull();
  });

  it('ignores an untrusted x-tenant-id header', async () => {
    await expect(
      resolveTenant(
        makeEvent('http://localhost:5173/', { 'x-tenant-id': 'attacker' }),
      ),
    ).resolves.toEqual({ tenantId: null, tenantSlug: null });
  });
});

describe('request hook authorization boundary', () => {
  const hooks = readFileSync(join(templateDir, 'src', 'hooks.server.ts'), 'utf8');

  it('stores selection before loading the session without entering tenant context', () => {
    expect(hooks).toContain('tenantSelectionHandle');
    expect(hooks).toContain('createSessionHandler');
    expect(hooks.indexOf('tenantSelectionHandle')).toBeLessThan(
      hooks.lastIndexOf('sessionHandle'),
    );
    expect(hooks).not.toContain('createSvelteKitHandle');
  });

  it('only publishes tenantContext when it matches an authenticated session', () => {
    expect(hooks).toContain('event.locals.user &&');
    expect(hooks).toContain(
      'activeContext?.tenantId === event.locals.tenantId',
    );
  });
});
