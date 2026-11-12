import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { OnboardingState } from '@happyvertical/smrt-svelte/onboarding';
import type { Cookbook } from '@happyvertical/smrt-types';
import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCookbookOnboarding } from '../host/onboarding.js';

const empty: Cookbook = { $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json', version: 1, recipes: [], features: [], policies: [] };
const yoga: Cookbook = { ...empty, recipes: ['classes'], layout: { version: 1, items: { 'item:fixture:Customer': { label: 'Our customers' } } } };
const catalog = { recipes: [{ id: 'classes', label: 'Classes', models: ['@fixture/app:Customer'], nav: [{ model: '@fixture/app:Customer', label: 'Customers' }], requires: [] }], models: [{ id: '@fixture/app:Customer', name: 'Customer', packageId: 'fixture' }] };
let db: Awaited<ReturnType<typeof getTestDatabase>>;
let mount: Awaited<ReturnType<typeof createCookbookOnboarding>>;
let options: Parameters<typeof createCookbookOnboarding>[0];
let approval: 'pending' | 'succeeded' | 'failed' | 'denied';
let actor: { tenantId: string; userId: string };
let saved: OnboardingState;
let changed: boolean;
let fail: boolean;
const origin = 'http://127.0.0.1:4998';
function event(body?: unknown, overrides: { origin?: string; user?: string } = {}): RequestEvent {
  const url = new URL('/api/onboarding', origin);
  return { url, request: new Request(url, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', origin: overrides.origin ?? origin }, ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) }), locals: { user: overrides.user ?? 'owner' } } as unknown as RequestEvent;
}
async function read() {
  const r = await mount.handle(event()); expect(r.status).toBe(200); saved = await r.json(); return saved;
}
async function change(action: string, extra = {}) {
  const r = await mount.handle(event({ action, revision: saved.revision, ...extra }));
  if (r.ok) saved = await r.json();
  return r;
}
beforeEach(async () => {
  db = await getTestDatabase(); actor = { tenantId: randomUUID(), userId: randomUUID() }; approval = 'pending'; changed = false; fail = false;
  options = { db, catalog, authorize: async e => (e.locals as { user: string }).user === 'owner' ? actor : null,
    invoke: vi.fn(async (_actor, name, args) => {
      if (name === 'cookbook.listTemplates') return { status: 'ok', summary: '', templates: [{ id: 'yoga-studio', name: 'Yoga Studio', description: 'Classes', lists: ['Our customers'], missing: [] }] };
      if (args.id !== 'yoga-studio') throw new Error('Unknown template');
      if (fail) throw new Error('private database failure');
      if (!args.apply) return { status: 'preview', summary: '', revision: changed ? 1 : 0, previewToken: randomUUID(), diff: { before: empty, after: yoga } };
      return { status: 'approval_required', summary: '', approvalId: 'hold-1' };
    }),
    approval: async () => ({ id: 'hold-1', tool: 'cookbook.apply', callId: 'call-1', summary: 'Apply yoga', status: approval }),
  };
  mount = await createCookbookOnboarding(options); await read();
});
afterEach(async () => { await db.close(); });

describe('durable owner first run', () => {
  it('resumes each step, including preview and pending approval, and never restarts completed onboarding', async () => {
    expect(saved.step).toBe('welcome');
    await change('welcome'); expect(saved.step).toBe('ai');
    mount = await createCookbookOnboarding(options); await read(); expect(saved.step).toBe('ai');
    await change('skip'); expect(saved.step).toBe('template');
    await change('preview', { id: 'yoga-studio' }); expect(saved.preview?.after).toEqual(['Our customers']);
    mount = await createCookbookOnboarding(options); await read(); expect(saved.selected).toBe('yoga-studio');
    await change('apply'); expect(saved.approvalId).toBe('hold-1'); expect(saved.completed).toBe(false);
    mount = await createCookbookOnboarding(options); approval = 'succeeded'; await read(); expect(saved.step).toBe('done'); expect(saved.completed).toBe(true);
    expect((await change('welcome')).status).toBe(409);
    mount = await createCookbookOnboarding(options); await read(); expect(saved.step).toBe('done');
    await change('restart'); expect(saved.rerunning).toBe(true); expect(saved.completed).toBe(true);
    await change('preview', { id: 'yoga-studio' }); await change('cancel'); expect(saved.step).toBe('done');
  });
  it('keeps the template step on failure and requires a new preview after a changed app', async () => {
    await change('welcome'); await change('continue'); await change('preview', { id: 'yoga-studio' });
    const before = saved.revision; fail = true;
    const response = await change('apply'); expect(response.status).toBe(503); expect(await response.text()).not.toContain('private');
    fail = false; await read(); expect(saved.revision).toBe(before); expect(saved.step).toBe('template');
    changed = true; expect((await change('apply')).status).toBe(409);
    await change('preview', { id: 'yoga-studio' }); await change('apply'); expect(saved.approvalId).toBe('hold-1');
    approval = 'failed'; await read(); await change('preview', { id: 'yoga-studio' }); expect(saved.approvalId).toBeNull();
    await change('apply'); approval = 'denied'; await read(); await change('preview', { id: 'yoga-studio' }); expect(saved.step).toBe('template');
  });
  it('rejects stale tabs, unknown actions, invalid steps, malformed/oversized requests, foreign origins and nonowners', async () => {
    const stale = saved.revision;
    expect((await change('apply')).status).toBe(409); expect((await change('restart')).status).toBe(409);
    await change('welcome');
    expect((await mount.handle(event({ action: 'skip', revision: stale }))).status).toBe(409);
    expect((await mount.handle(event({ action: 'skip', revision: saved.revision, initialSetup: true }))).status).toBe(400);
    expect((await change('unknown')).status).toBe(400);
    expect((await mount.handle(event('{'))).status).toBe(400);
    expect((await mount.handle(event(' '.repeat(4097)))).status).toBe(413);
    expect((await mount.handle(event({ action: 'skip', revision: saved.revision }, { origin: 'https://foreign.invalid' }))).status).toBe(403);
    expect((await mount.handle(event(undefined, { user: 'other' }))).status).toBe(403);
    const owner = actor; actor = { tenantId: randomUUID(), userId: randomUUID() }; await read(); expect(saved.step).toBe('welcome'); actor = owner; await read(); expect(saved.step).toBe('ai');
  });
  it('derives initial setup only from durable unfinished progress, never a restart', async () => {
    await change('welcome'); await change('skip'); await change('preview', { id: 'yoga-studio' }); await change('apply');
    approval = 'succeeded'; await read();
    await change('restart'); await change('preview', { id: 'yoga-studio' }); await change('apply');
    expect(vi.mocked(options.invoke).mock.calls.filter(([, name, args]) => name === 'cookbook.apply' && args.apply).map(call => call[3])).toEqual([true, false]);
  });
  it('keeps a completed app usable when pre-built components are off, with a cancellable empty replacement picker', async () => {
    await change('welcome'); await change('skip'); await change('preview', { id: 'yoga-studio' }); await change('apply');
    approval = 'succeeded'; await read();
    vi.mocked(options.invoke).mockRejectedValue(Object.assign(new Error('not offered'), { code: 'forbidden' }));
    await read(); expect(saved.completed).toBe(true);
    await change('restart'); expect(saved.templates).toEqual([]);
    await change('cancel'); expect(saved.step).toBe('done');
  });

});
