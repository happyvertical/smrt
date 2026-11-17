import { describe, expect, it } from 'vitest';
import { describeChanges, planDraftBar, showDraftBar } from './draft-bar.ts';
import type { DraftInfo } from './types.ts';

const draft = (patch: Partial<DraftInfo> = {}): DraftInfo => ({
  id: 'd1',
  name: 'Draft',
  status: 'open',
  baseVersion: 1,
  version: 1,
  changes: 0,
  createdAt: '2026-01-01T00:00:00Z',
  createdBy: 'owner',
  liveVersion: 1,
  liveFrozen: true,
  publishable: true,
  problem: null,
  recovery: 'none',
  ...patch,
});

describe('planDraftBar', () => {
  it('offers only a quiet start when there is no draft', () => {
    expect(planDraftBar(null)).toEqual({ kind: 'start' });
    expect(planDraftBar(undefined)).toEqual({ kind: 'start' });
  });

  it('shows no review or discard actions for an empty draft', () => {
    expect(planDraftBar(draft())).toEqual({ kind: 'idle' });
  });

  it('shows everything once the draft has changes', () => {
    expect(planDraftBar(draft({ changes: 2 }))).toEqual({
      kind: 'changes',
      count: 2,
    });
  });

  it('keeps discard but never review for an unpublishable draft', () => {
    expect(
      planDraftBar(draft({ changes: 3, publishable: false, problem: 'x' })),
    ).toEqual({ kind: 'blocked' });
  });
});

describe('describeChanges', () => {
  it('pluralises the count', () => {
    expect(describeChanges(1)).toBe('1 change, not published');
    expect(describeChanges(2)).toBe('2 changes, not published');
  });
});

describe('showDraftBar', () => {
  const base = {
    owner: true,
    plugin: false,
    onboarding: false,
    pathname: '/',
  };
  it('is on every owner page, settings included', () => {
    for (const pathname of ['/', '/m/Order', '/settings', '/approvals'])
      expect(showDraftBar({ ...base, pathname })).toBe(true);
  });
  it('is off in a plugin, onboarding, setup, welcome and signed out', () => {
    expect(showDraftBar({ ...base, plugin: true })).toBe(false);
    expect(showDraftBar({ ...base, onboarding: true })).toBe(false);
    expect(showDraftBar({ ...base, pathname: '/welcome' })).toBe(false);
    expect(showDraftBar({ ...base, pathname: '/setup/x' })).toBe(false);
    expect(showDraftBar({ ...base, owner: false })).toBe(false);
  });
});
