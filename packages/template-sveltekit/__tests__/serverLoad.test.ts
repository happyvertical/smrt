import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
// The Notes page is the opt-in example (`examples/notes`), not part of the
// template; the template's own home page is an empty state.
const routesDir = join(__dirname, '..', 'examples', 'notes', 'src', 'routes', 'notes');
const templateRoutesDir = join(__dirname, '..', 'template', 'src', 'routes');

describe('template home page', () => {
  it('is an empty state with no object, load, or create form', () => {
    const home = readFileSync(join(templateRoutesDir, '+page.svelte'), 'utf8');
    expect(existsSync(join(templateRoutesDir, '+page.server.ts'))).toBe(false);
    expect(home).toContain('<EmptyState');
    expect(home).not.toMatch(/note/i);
    expect(readFileSync(join(templateRoutesDir, '+layout.svelte'), 'utf8')).not.toMatch(
      /Notes/,
    );
  });
});

describe('example notes page server-load convention', () => {
  const pageServer = readFileSync(join(routesDir, '+page.server.ts'), 'utf8');
  const page = readFileSync(join(routesDir, '+page.svelte'), 'utf8');

  it('uses depends and targeted invalidation', () => {
    expect(pageServer).toContain("depends('smrt:notes')");
    expect(page).toContain("invalidate('smrt:notes')");
  });

  it('hydrates server data without a mount-time initial fetch', () => {
    expect(page).toMatch(/\$props\(\)/);
    expect(page).not.toMatch(/\$effect\s*\(/);
    expect(page).not.toMatch(/onMount/);
    expect(page).not.toMatch(/fetch\(\s*['"`]\/api\/items/);
  });

  it('guards reads and hand-written writes with manifest-derived permissions', () => {
    expect(pageServer).toContain("const READ_PERMISSION = 'notes.read'");
    expect(pageServer).toContain('assertOperationPermission');
    expect(pageServer).toContain('permissionSet: locals.permissions');
  });
});

describe('example notes page server load and action', () => {
  it('does not query tenant data for an anonymous request', async () => {
    const { load } = await import('../examples/notes/src/routes/notes/+page.server.js');
    const depends = vi.fn();
    const result = await load({
      depends,
      locals: {
        user: null,
        membership: null,
        permissions: [],
        tenantId: null,
        sessionId: null,
        selectedTenantId: null,
        selectedTenantSlug: null,
      },
    } as never);

    expect(depends).toHaveBeenCalledWith('smrt:notes');
    expect(result.notes).toEqual([]);
    expect(result.accessMessage).toMatch(/Sign in/);
  });

  it('rejects an anonymous create before reading the request body or database', async () => {
    const { actions } = await import('../examples/notes/src/routes/notes/+page.server.js');
    const result = (await actions.create({
      request: new Request('http://localhost/?/create', {
        method: 'POST',
        body: new FormData(),
      }),
      locals: {
        user: null,
        membership: null,
        permissions: [],
        tenantId: null,
        sessionId: null,
        selectedTenantId: null,
        selectedTenantSlug: null,
      },
    } as never)) as unknown as {
      status: number;
      data: { error: string };
    };

    expect(result.status).toBe(401);
    expect(result.data.error).toMatch(/Authentication/);
  });
});
