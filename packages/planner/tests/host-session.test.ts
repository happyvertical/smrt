import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { COOKBOOK_SCHEMA, type Cookbook } from '../src/lib/cookbook/types.ts';
import {
  createHostSession,
  type HostPlan,
} from '../src/lib/planner/host/session.svelte.ts';

const empty: Cookbook = {
  $schema: COOKBOOK_SCHEMA,
  version: 1,
  recipes: [],
  features: [],
  policies: [],
};
const plan = (revision: number, cookbook: Cookbook = empty): HostPlan =>
  ({ planId: 'plan-12345678', snapshot: { revision }, cookbook }) as HostPlan;

beforeEach(() => {
  cookbookStore.apply(empty);
  cookbookStore.loaded = false;
});
afterEach(() => {
  cookbookStore.apply(empty);
  cookbookStore.loaded = false;
});

describe('host-backed Planner session', () => {
  it('hydrates one authoritative plan and ignores stale or invalid updates', () => {
    const session = createHostSession(async () => ({}));
    session.refresh(plan(2, { ...empty, theme: { preset: 'studio' } }));
    expect(cookbookStore.theme?.preset).toBe('studio');
    expect(cookbookStore.loaded).toBe(true);
    session.refresh(plan(1, { ...empty, theme: { preset: 'glass' } }));
    expect(cookbookStore.theme?.preset).toBe('studio');
    expect(() => session.refresh({ ...plan(3), planId: 'plan-other' })).toThrow(
      'different plan',
    );
    expect(() =>
      session.refresh(plan(3, { ...empty, theme: { preset: 'unknown' } })),
    ).toThrow();
  });

  it('reports a failed read and then reconnects to the same plan', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let attempt = 0;
    const session = createHostSession(async (name, args) => {
      calls.push({ name, args });
      attempt += 1;
      if (attempt === 1) throw new Error('connection lost');
      return plan(2, { ...empty, theme: { preset: 'studio' } });
    });
    session.refresh(plan(1));
    await session.connect('plan-12345678');
    expect(session.error).toContain('connection lost');
    expect(session.current?.snapshot.revision).toBe(1);
    await session.connect('plan-12345678');
    expect(calls).toEqual([
      { name: 'get_plan', args: { planId: 'plan-12345678' } },
      { name: 'get_plan', args: { planId: 'plan-12345678' } },
    ]);
    expect(session.error).toBe('');
    expect(session.current?.snapshot.revision).toBe(2);
    expect(cookbookStore.theme?.preset).toBe('studio');
  });

  it('shows an invalid first payload and recovers when a valid plan arrives', () => {
    const session = createHostSession(async () => ({}));
    session.receive(plan(1, { ...empty, theme: { preset: 'unknown' } }));
    expect(session.current).toBeNull();
    expect(session.pendingPlanId).toBe('plan-12345678');
    expect(session.error).toContain('preset');
    session.receive(plan(2, { ...empty, name: 'Recovered' }));
    expect(session.current?.snapshot.revision).toBe(2);
    expect(session.pendingPlanId).toBeNull();
    expect(session.error).toBe('');
  });

  it('ignores an outstanding read after its host unmounts', async () => {
    let answer!: (value: HostPlan) => void;
    const session = createHostSession(
      async () =>
        new Promise<HostPlan>((resolve) => {
          answer = resolve;
        }),
    );
    session.refresh(plan(1, { ...empty, name: 'First plan' }));
    const stop = session.mount();
    const read = session.connect('plan-12345678');
    stop();
    answer(plan(2, { ...empty, name: 'Late response' }));
    await read;
    expect(session.current?.snapshot.revision).toBe(1);
    expect(cookbookStore.name).toBe('First plan');
  });
});
