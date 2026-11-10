import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

// The runtime is built from app config at import; the action refuses before
// it would ever be touched.
vi.mock('../template/src/lib/server/smrt', () => ({
  runtime: {
    database: () => Promise.reject(new Error('no database in this test')),
    classOptions: () => ({}),
    secretMasterKey: () => Promise.resolve(null),
  },
}));

const here = dirname(fileURLToPath(import.meta.url));
const route = join(
  here,
  '..',
  'template',
  'src',
  'routes',
  'settings',
  'inference',
);

function locals(permissions: string[]) {
  return {
    user: { id: 'user-1' },
    tenantId: 'tenant-1',
    permissions,
  };
}

describe('Inference settings saveKey action', () => {
  it('refuses a member without the customize permission before reading the key', async () => {
    const { actions } = await import(
      '../template/src/routes/settings/inference/+page.server.js'
    );
    const request = new Request('http://localhost/?/saveKey', {
      method: 'POST',
      // Unread: a refusal must not parse the key out of the body.
      body: 'not a form',
    });
    const result = (await actions.saveKey({
      request,
      locals: locals([]),
    } as never)) as { status: number; data: { error: string } };
    expect(result.status).toBe(403);
    expect(result.data.error).not.toMatch(/key/i);
    expect(request.bodyUsed).toBe(false);
  });

  it('is wired to the panel and reports the stored state, never a key', () => {
    const server = readFileSync(join(route, '+page.server.ts'), 'utf8');
    expect(server).toContain('saveKey: async');
    expect(server).toContain('keySet: await inferenceKeyIsSet(');
    expect(server).not.toContain('keySet: false');
    const page = readFileSync(join(route, '+page.svelte'), 'utf8');
    expect(page).toContain("save('saveKey', change)");
    expect(page).toContain('data.canEdit');
  });
});
