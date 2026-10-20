import { describe, expect, it } from 'vitest';
import {
  createWorkspaceStorage,
  EPHEMERAL_RECOVERY_KEY,
  LEGACY_WORKSPACE_KEY,
  REMEMBER_KEY,
} from '../src/lib/planner/workspace-storage.ts';

class MemoryStorage implements Storage {
  values = new Map<string, string>();
  failKey = '';
  failRemoveKey = '';
  removeFailures = 0;
  get length() {
    return this.values.size;
  }
  key(i: number) {
    return [...this.values.keys()][i] ?? null;
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (key === this.failKey) throw new Error('quota');
    this.values.set(key, value);
  }
  removeItem(key: string) {
    if (key === this.failRemoveKey && this.removeFailures++ === 0)
      throw new Error('refused removal');
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}
const PLAN = 'smrt-planner:cookbook-doc:v1';
const ROW = 'smrt-planner:data:v6:Product';
const CONTEXT = 'smrt-planner:sample-context:v1';
const THREAD = 'smrt-planner:conversation:v1';
const SEED = 'smrt-planner:conversation-seed:v1';
const DRAFT = 'smrt-planner:host-draft:v1';
describe('workspace persistence', () => {
  it('keeps exact project edits on same-tab reload, fresh tabs start empty', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const first = createWorkspaceStorage(local, session);
    for (const key of [PLAN, ROW, CONTEXT, THREAD, SEED, DRAFT])
      first.storage.setItem(key, `raw:${key}`);
    const reload = createWorkspaceStorage(local, session);
    for (const key of [PLAN, ROW, CONTEXT, THREAD, SEED, DRAFT])
      expect(reload.storage.getItem(key)).toBe(`raw:${key}`);
    expect(local.length).toBe(0);
    expect(
      createWorkspaceStorage(local, new MemoryStorage()).storage.getItem(PLAN),
    ).toBeNull();
  });
  it('moves exact state both directions and removes stale owned copies', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const manager = createWorkspaceStorage(local, session);
    manager.storage.setItem(PLAN, 'manual plan');
    manager.storage.setItem(ROW, 'manual rows');
    expect(manager.setRemember(true)).toBe(true);
    expect(session.getItem(PLAN)).toBeNull();
    expect(local.getItem(ROW)).toBe('manual rows');
    expect(
      createWorkspaceStorage(local, new MemoryStorage()).storage.getItem(PLAN),
    ).toBe('manual plan');
    manager.storage.setItem(PLAN, 'new edit');
    expect(manager.setRemember(false)).toBe(true);
    expect(session.getItem(PLAN)).toBe('new edit');
    expect(local.getItem(PLAN)).toBeNull();
    expect(local.getItem(REMEMBER_KEY)).toBe('false');
  });
  it('archives raw legacy once, migrates to this tab, and offers recovery', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem(PLAN, '{malformed legacy');
    local.setItem(ROW, 'legacy manual');
    const manager = createWorkspaceStorage(local, session);
    expect(manager.storage.getItem(PLAN)).toBe('{malformed legacy');
    expect(manager.recoveryAvailable()).toBe(true);
    const archive = local.getItem(LEGACY_WORKSPACE_KEY);
    expect(local.getItem(PLAN)).toBeNull();
    manager.storage.setItem(PLAN, 'edited');
    expect(local.getItem(LEGACY_WORKSPACE_KEY)).toBe(archive);
    expect(
      createWorkspaceStorage(local, new MemoryStorage()).storage.getItem(PLAN),
    ).toBeNull();
    expect(manager.recover()).toBe(true);
    expect(manager.storage.getItem(PLAN)).toBe('{malformed legacy');
    expect(manager.setRemember(false)).toBe(true);
    expect(local.getItem(LEGACY_WORKSPACE_KEY)).toBeNull();
  });
  it('preserves source and destination when a remember migration fails', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const manager = createWorkspaceStorage(local, session);
    manager.storage.setItem(PLAN, 'current');
    manager.storage.setItem(ROW, 'rows');
    local.failKey = ROW;
    expect(manager.setRemember(true)).toBe(false);
    expect(session.getItem(PLAN)).toBe('current');
    expect(session.getItem(ROW)).toBe('rows');
    expect(local.getItem(PLAN)).toBeNull();
    expect(manager.remembering()).toBe(false);
  });
  it('preserves legacy originals on quota failure', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem(PLAN, 'old raw');
    session.failKey = PLAN;
    const manager = createWorkspaceStorage(local, session);
    expect(() => manager.storage.getItem(PLAN)).toThrow();
    expect(local.getItem(PLAN)).toBe('old raw');
    expect(local.getItem(LEGACY_WORKSPACE_KEY)).toContain('old raw');
  });
  it('remembers plan and samples while raw thread, seed, and frozen draft stay session-only', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const manager = createWorkspaceStorage(local, session);
    manager.storage.setItem(PLAN, 'plan');
    manager.storage.setItem(ROW, 'rows');
    for (const key of [THREAD, SEED, DRAFT])
      manager.storage.setItem(key, `raw:${key}`);
    expect(manager.setRemember(true)).toBe(true);
    for (const key of [THREAD, SEED, DRAFT]) {
      expect(local.getItem(key)).toBeNull();
      expect(session.getItem(key)).toBe(`raw:${key}`);
      manager.storage.setItem(key, `edited:${key}`);
    }
    const fresh = createWorkspaceStorage(local, new MemoryStorage());
    expect(fresh.storage.getItem(PLAN)).toBe('plan');
    expect(fresh.storage.getItem(ROW)).toBe('rows');
    for (const key of [THREAD, SEED, DRAFT])
      expect(fresh.storage.getItem(key)).toBeNull();
    expect(manager.setRemember(false)).toBe(true);
    for (const key of [THREAD, SEED, DRAFT]) {
      expect(local.getItem(key)).toBeNull();
      expect(manager.storage.getItem(key)).toBe(`edited:${key}`);
    }
  });
  it('safely retires earlier durable chat/draft and removes it from durable archives', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem(REMEMBER_KEY, 'true');
    local.setItem(PLAN, 'remembered');
    local.setItem(DRAFT, 'frozen original lead id');
    session.setItem(DRAFT, 'current different lead id');
    local.setItem(THREAD, 'old thread');
    local.setItem(
      LEGACY_WORKSPACE_KEY,
      JSON.stringify([
        [PLAN, 'archive plan'],
        [THREAD, 'archive thread'],
      ]),
    );
    const manager = createWorkspaceStorage(local, session);
    expect(manager.storage.getItem(DRAFT)).toBe('current different lead id');
    expect(session.getItem(EPHEMERAL_RECOVERY_KEY)).toContain(
      'frozen original lead id',
    );
    expect(session.getItem(EPHEMERAL_RECOVERY_KEY)).toContain('archive thread');
    expect(manager.storage.getItem(THREAD)).toBe('old thread');
    expect(local.getItem(DRAFT)).toBeNull();
    expect(local.getItem(THREAD)).toBeNull();
    expect(local.getItem(LEGACY_WORKSPACE_KEY)).toBe(
      JSON.stringify([[PLAN, 'archive plan']]),
    );
  });
  it('does not retire durable draft if session storage refuses its exact copy', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem(DRAFT, 'frozen lead');
    session.failKey = DRAFT;
    const manager = createWorkspaceStorage(local, session);
    expect(() => manager.storage.getItem(DRAFT)).toThrow();
    expect(local.getItem(DRAFT)).toBe('frozen lead');
    expect(local.getItem(LEGACY_WORKSPACE_KEY)).toBeNull();
  });
  it('refuses malformed recovery and explicitly discards its raw archive', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    local.setItem(
      LEGACY_WORKSPACE_KEY,
      JSON.stringify([['unrelated:key', 'raw']]),
    );
    const manager = createWorkspaceStorage(local, session);
    manager.storage.setItem(PLAN, 'current');
    expect(manager.recover()).toBe(false);
    expect(manager.storage.getItem(PLAN)).toBe('current');
    expect(manager.discardRecovery()).toBe(true);
    expect(manager.recoveryAvailable()).toBe(false);
  });
  it('reports unavailable destination without erasing legacy data', () => {
    const local = new MemoryStorage();
    local.setItem(PLAN, 'legacy');
    const manager = createWorkspaceStorage(local, null);
    expect(manager.setRemember(true)).toBe(false);
    expect(local.getItem(PLAN)).toBe('legacy');
  });
  it('rolls back partial reset storage failure without losing manual work', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const manager = createWorkspaceStorage(local, session);
    manager.storage.setItem(PLAN, 'manual plan');
    manager.storage.setItem(ROW, 'manual rows');
    local.setItem(LEGACY_WORKSPACE_KEY, 'legacy raw');
    session.failRemoveKey = ROW;
    expect(manager.reset()).toBe(false);
    expect(session.getItem(PLAN)).toBe('manual plan');
    expect(session.getItem(ROW)).toBe('manual rows');
    expect(local.getItem(LEGACY_WORKSPACE_KEY)).toBe('legacy raw');
    expect(manager.storage.getItem(PLAN)).toBe('manual plan');
  });
  it('reset clears only exact project ownership in both stores, including archive', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    const manager = createWorkspaceStorage(local, session);
    manager.storage.setItem(PLAN, 'plan');
    manager.setRemember(true);
    local.setItem(LEGACY_WORKSPACE_KEY, 'legacy');
    for (const store of [local, session]) {
      store.setItem(ROW, 'rows');
      store.setItem(CONTEXT, 'context');
      store.setItem(THREAD, 'thread');
      store.setItem(SEED, 'seed');
      store.setItem(DRAFT, 'frozen draft');
      store.setItem('smrt-planner:shell', 'theme');
      store.setItem('work:identity', 'identity');
      store.setItem('other', 'other');
    }
    expect(manager.reset()).toBe(true);
    for (const store of [local, session]) {
      for (const key of [
        PLAN,
        ROW,
        CONTEXT,
        THREAD,
        SEED,
        LEGACY_WORKSPACE_KEY,
      ])
        expect(store.getItem(key)).toBeNull();
      expect(store.getItem('smrt-planner:shell')).toBe('theme');
      expect(store.getItem('work:identity')).toBe('identity');
      expect(store.getItem('other')).toBe('other');
    }
  });
});
