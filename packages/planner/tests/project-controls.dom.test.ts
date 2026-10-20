import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectControls from '../src/lib/components/ProjectControls.svelte';
import { cookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { DATA_SOURCE_KEY } from '../src/lib/data/context.ts';
import PlannerControls from '../src/lib/planner/PlannerControls.svelte';
import SettingsPanel from './settings-panel.fixture.svelte';

const workspace = vi.hoisted(() => ({
  reset: vi.fn(() => true),
  remember: vi.fn(() => true),
}));
vi.mock('../src/lib/planner/workspace.svelte.ts', () => ({
  resetWorkspace: workspace.reset,
  workspacePersistence: {
    remembering: false,
    recoveryAvailable: false,
    setRemember: workspace.remember,
  },
}));

async function settle() {
  await tick();
  flushSync();
  await tick();
}
function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected fixture element missing');
  return value;
}
const button = (text: string) =>
  required(
    [...document.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === text,
    ),
  );

describe('project workspace controls', () => {
  let target: HTMLElement;
  let app: ReturnType<typeof mount> | undefined;
  const context = new Map<unknown, unknown>([[DATA_SOURCE_KEY, {}]]);
  beforeEach(() => {
    workspace.reset.mockClear();
    workspace.remember.mockReset().mockReturnValue(true);
    target = document.createElement('div');
    document.body.append(target);
  });
  afterEach(async () => {
    if (app) await unmount(app);
    target.remove();
    vi.useRealTimers();
  });
  it('omits self-storage promises for a generic host while preserving reset', async () => {
    app = mount(PlannerControls, {
      target,
      context,
      props: { persistence: 'host', tabs: ['settings'] },
    });
    await settle();
    expect(target.textContent).not.toContain('Remember this plan');
    expect(target.textContent).not.toContain('Previous saved plan');
    expect(button('Reset project').disabled).toBe(false);
    expect(workspace.remember).not.toHaveBeenCalled();
  });
  it('delegates storage controls only to the supplied current-cookbook owner', async () => {
    const owner = {
      remembering: false,
      recoveryAvailable: false,
      setRemember: vi.fn(() => true),
      recover: vi.fn(() => true),
      discardRecovery: vi.fn(() => true),
    };
    app = mount(PlannerControls, {
      target,
      context,
      props: {
        persistence: 'host',
        projectPersistence: owner,
        tabs: ['settings'],
      },
    });
    await settle();
    const input = required(
      target.querySelector<HTMLInputElement>('input[type="checkbox"]'),
    );
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(owner.setRemember).toHaveBeenCalledWith(true);
    expect(workspace.remember).not.toHaveBeenCalled();
  });
  it('requires explicit confirmation and passes canonical reset dependencies', async () => {
    const onreset = vi.fn();
    app = mount(ProjectControls, { target, context, props: { onreset } });
    await settle();
    button('Reset project').click();
    await settle();
    expect(document.querySelector('dialog[open]')?.textContent).toContain(
      'Manual edits will be lost',
    );
    button('Cancel').click();
    await settle();
    expect(workspace.reset).not.toHaveBeenCalled();
    button('Reset project').click();
    await settle();
    required(document.querySelector<HTMLDialogElement>('dialog[open]'))
      .querySelectorAll('button')[1]
      .click();
    await settle();
    expect(workspace.reset).toHaveBeenCalledWith(
      expect.objectContaining({ onreset, dataSource: {} }),
    );
  });
  it('blocks resetting while an irreversible request is unresolved', async () => {
    app = mount(ProjectControls, {
      target,
      context,
      props: {
        resetDisabledReason:
          'Your request is awaiting confirmation; resetting cannot unsend it.',
      },
    });
    await settle();
    expect(button('Reset project').disabled).toBe(true);
    expect(target.textContent).toContain('cannot unsend');
    button('Reset project').click();
    await settle();
    expect(workspace.reset).not.toHaveBeenCalled();
  });
  it('shows a storage failure without silently changing preference', async () => {
    workspace.remember.mockReturnValue(false);
    app = mount(ProjectControls, { target, context });
    await settle();
    const input = required(
      target.querySelector<HTMLInputElement>('input[type="checkbox"]'),
    );
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await settle();
    expect(workspace.remember).toHaveBeenCalledWith(true);
    expect(target.textContent).toContain('could not be changed');
    expect(target.textContent).toContain('current tab session');
    expect(target.textContent).toContain(
      'cookbook, sample records and settings',
    );
    expect(input.checked).toBe(false);
  });
  it('discards pending settings edits when another surface replaces the project', async () => {
    app = mount(SettingsPanel, { target, context });
    await settle();
    vi.useFakeTimers();
    const terms = required(
      target.querySelector<HTMLInputElement>('#app-settings-tab-terms') ??
        [...target.querySelectorAll<HTMLInputElement>('input')].find(
          (node) => node.type === 'text',
        ),
    );
    expect(terms).toBeDefined();
    terms.value = 'Stale pending terms';
    terms.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(terms.value).toBe('Stale pending terms');
    expect(cookbookStore.settings().paymentTerms).not.toBe(
      'Stale pending terms',
    );
    cookbookStore.reset();
    await settle();
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.stringify(cookbookStore.settings())).not.toContain(
      'Stale pending terms',
    );
  });
});
