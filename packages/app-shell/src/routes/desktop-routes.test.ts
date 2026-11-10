// The two routes the desktop wrapper depends on (smrt-desktop.json:
// sidecar.healthRoute and sidecar.ownerClaimRoute). Both are app-runtime's
// handlers; this checks they are mounted at the manifest's paths and that the
// owner link fails closed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as health from './api/_runtime/health/+server.ts';
import * as ownerLink from './api/_runtime/owner-link/+server.ts';

const SECRET_ENV = 'SMRT_DESKTOP_OWNER_LINK_SECRET';

function linkEvent(search: string, address = '127.0.0.1') {
  const url = new URL(`http://127.0.0.1:3000/api/_runtime/owner-link${search}`);
  return {
    url,
    request: new Request(url, { headers: { host: url.host } }),
    getClientAddress: () => address,
  } as never;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('desktop routes', () => {
  it('mounts the health handler', () => {
    expect(typeof health.GET).toBe('function');
  });

  it('answers 403 to every owner-link request outside the wrapper', async () => {
    vi.stubEnv(SECRET_ENV, '');
    const response = await ownerLink.GET(linkEvent('?launch=anything'));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('');
  });

  it('answers 403 to a wrong or missing launch secret', async () => {
    vi.stubEnv(SECRET_ENV, 'a'.repeat(64));
    for (const search of ['', '?launch=wrong']) {
      const response = await ownerLink.GET(linkEvent(search));
      expect(response.status).toBe(403);
    }
  });

  it('answers 403 to a non-loopback peer even with the secret', async () => {
    vi.stubEnv(SECRET_ENV, 'b'.repeat(64));
    const response = await ownerLink.GET(
      linkEvent(`?launch=${'b'.repeat(64)}`, '203.0.113.9'),
    );
    expect(response.status).toBe(403);
  });
});
