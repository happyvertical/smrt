import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { InferenceSettingsPageData } from '@happyvertical/smrt-inference/server';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { createInferenceSettingsPage } from '../host/settings.js';

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
  it('preserves the load data shape for generated SvelteKit page types', () => {
    expectTypeOf<Awaited<ReturnType<ReturnType<typeof createInferenceSettingsPage>['load']>>>()
      .toEqualTypeOf<InferenceSettingsPageData>();
  });
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
    const mount = readFileSync(join(route, '+page.server.ts'), 'utf8');
    expect(mount).toContain('createInferenceSettingsPage(inferenceSettingsController())');
    const server = readFileSync(join(here, '..', 'host', 'settings.ts'), 'utf8');
    expect(server).toContain('saveKey: async');
    // The load and the write both go through smrt-inference's controller,
    // which reads `keySet` from the resolver's redacted state.
    expect(server).toMatch(/\.load\(\s*session/);
    expect(server).toContain('controller.saveKey(session');
    expect(server).not.toContain('keySet: false');
    expect(readFileSync(join(route, '+page.svelte'), 'utf8')).toContain('InferenceSettingsPage {data}');
    const page = readFileSync(join(here, '..', 'host', 'InferenceSettingsPage.svelte'), 'utf8');
    expect(page).toContain('<title>Assistant · Settings</title>');
    expect(page).toContain('basePath="/settings" title="Assistant"');
    expect(page).toContain("save('saveKey', change)");
    expect(page).toContain('data.canEdit');
  });
});
