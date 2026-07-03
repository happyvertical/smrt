/**
 * Reference data-loading pattern tests (issue #1760).
 *
 * The home page must load collection data in a server `load` (serialized
 * into the initial HTML, hydrated without a duplicate client fetch) and
 * follow the `depends('smrt:<collection>')` / `invalidate('smrt:<collection>')`
 * refresh convention. Structural tests pin the convention in the template
 * source; runtime tests execute the load/action contract directly.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const routesDir = join(__dirname, '..', 'template', 'src', 'routes');

describe('home page data-loading convention (structural)', () => {
  const pageServer = readFileSync(join(routesDir, '+page.server.ts'), 'utf-8');
  const page = readFileSync(join(routesDir, '+page.svelte'), 'utf-8');

  it('server load declares the smrt:items dependency', () => {
    expect(pageServer).toContain("depends('smrt:items')");
  });

  it('server load opts the SSR read into the collection cache', () => {
    expect(pageServer).toMatch(/cache:\s*\{\s*ttl/);
  });

  it('page invalidates smrt:items after the demo mutation', () => {
    expect(page).toContain("invalidate('smrt:items')");
  });

  it('page renders server-loaded data instead of fetching on mount', () => {
    // Svelte 5 runes: data arrives via $props() from the server load…
    expect(page).toMatch(/\$props\(\)/);
    // …so the mount-time fetch waterfall must not come back.
    expect(page).not.toMatch(/\$effect\s*\(/);
    expect(page).not.toMatch(/onMount/);
    expect(page).not.toMatch(/fetch\(\s*['"`]\/api\/items['"`]\s*\)/);
  });
});

describe('home page server load (runtime)', () => {
  let tempDir: string | undefined;
  let routeModule: typeof import('../template/src/routes/+page.server.js');
  const previousEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DATABASE_TYPE: process.env.DATABASE_TYPE,
  };

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-template-load-'));
    // Point the template's default config at a throwaway database. No table
    // is ever prepared: runtime schema creation is disabled by design, so
    // reads fail and the load must degrade gracefully.
    process.env.DATABASE_URL = join(tempDir, 'app.db');
    process.env.DATABASE_TYPE = 'sqlite';
    routeModule = await import('../template/src/routes/+page.server.js');
  });

  afterAll(() => {
    process.env.DATABASE_URL = previousEnv.DATABASE_URL;
    process.env.DATABASE_TYPE = previousEnv.DATABASE_TYPE;
    // Guard: if beforeAll failed before mkdtempSync assigned tempDir, a
    // bare rmSync(undefined) here would throw and mask the real failure.
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('registers depends("smrt:items") before querying and degrades gracefully without a prepared database', async () => {
    const depends = vi.fn();
    const event = { depends } as unknown as Parameters<
      typeof routeModule.load
    >[0];

    const result = await routeModule.load(event);

    // The dependency key must be registered even on the failure path, so a
    // later invalidate('smrt:items') re-runs the load once the database has
    // been initialized.
    expect(depends).toHaveBeenCalledTimes(1);
    expect(depends).toHaveBeenCalledWith('smrt:items');

    // First run before `smrt db:setup`: no 500, just guidance.
    expect(result.items).toEqual([]);
    expect(result.loadError).toBeTruthy();
  });

  it('create action rejects a blank title without touching the database', async () => {
    const body = new FormData();
    body.set('title', '   ');
    const request = new Request('http://localhost/?/create', {
      method: 'POST',
      body,
    });
    const event = { request } as unknown as Parameters<
      typeof routeModule.actions.create
    >[0];

    const result = (await routeModule.actions.create(event)) as unknown as {
      status: number;
      data: { error: string };
      __isActionFailure: boolean;
    };

    expect(result.__isActionFailure).toBe(true);
    expect(result.status).toBe(400);
    expect(result.data.error).toBe('Title is required');
  });
});
