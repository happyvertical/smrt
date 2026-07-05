import { flushSync, mount, unmount } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import { createShellState } from '../admin-shell/state.svelte.js';
import MutationEffectHarness from './admin-shell-mutation-effect-harness.svelte';

type ShellMutationEffect = Parameters<typeof MutationEffectHarness>[0]['run'];

function mountMutationEffect(
  shell: ReturnType<typeof createShellState>,
  run: ShellMutationEffect,
): {
  getRuns: () => number;
  setActivityProgress: (progress: number) => void;
  teardown: () => void;
} {
  const target = document.createElement('div');
  document.body.appendChild(target);
  let getRuns = () => 0;
  let setActivityProgress = (_progress: number) => {};
  const component = mount(MutationEffectHarness, {
    target,
    props: {
      shell,
      run,
      onReady: (controls) => {
        getRuns = controls.getRuns;
        setActivityProgress = controls.setActivityProgress;
      },
    },
  });
  return {
    getRuns,
    setActivityProgress,
    teardown: () => {
      unmount(component);
      target.remove();
    },
  };
}

describe('ShellState', () => {
  it('allows panels to expand independently by default', () => {
    const shell = createShellState();
    shell.expandPanel('top');
    shell.expandPanel('bottom');
    expect(shell.panels.top).toBe('expanded');
    expect(shell.panels.bottom).toBe('expanded');
  });

  it('closes peers in the same exclusivity group', () => {
    const shell = createShellState({
      config: {
        top: { exclusiveGroup: 'vertical' },
        bottom: { exclusiveGroup: 'vertical' },
      },
    });
    shell.expandPanel('top');
    shell.expandPanel('bottom');
    expect(shell.panels.top).toBe('collapsed');
    expect(shell.panels.bottom).toBe('expanded');
  });

  it('registers and unregisters focus tools', () => {
    const shell = createShellState();
    const unregister = shell.registerFocusTool({
      id: 'activity',
      label: 'Activity',
    });
    expect(shell.focusTools.map((tool) => tool.id)).toEqual(['activity']);
    expect(shell.activeFocusToolId).toBe('activity');
    unregister();
    expect(shell.focusTools).toEqual([]);
    expect(shell.activeFocusToolId).toBeNull();
  });

  it('re-homes activities to system when their edge is hidden', () => {
    const shell = createShellState({ config: { right: false } });
    shell.upsertActivity({
      id: 'encode-1',
      label: 'Encode',
      kind: 'video-encode',
      scope: 'focus',
      status: 'running',
    });
    expect(shell.listActivities()[0]?.edge).toBe('bottom');
    expect(shell.activityBadge('bottom').count).toBe(1);
  });

  it('emits lifecycle events for activity updates', () => {
    const shell = createShellState();
    const listener = vi.fn();
    shell.watchActivities(listener);
    shell.upsertActivity({
      id: 'import-1',
      label: 'Import',
      kind: 'import',
      scope: 'system',
      status: 'running',
    });
    shell.updateActivity('import-1', { status: 'completed' });
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'transition' }),
    );
  });

  it('keeps an exclusivity-closed peer collapsed after settings re-resolve', () => {
    const shell = createShellState({
      config: {
        top: { exclusiveGroup: 'vertical' },
        bottom: { exclusiveGroup: 'vertical' },
      },
    });
    shell.expandPanel('top');
    shell.expandPanel('bottom');
    // Re-applying settings (as hydrate / app-default changes do) must not
    // resurrect the peer the exclusivity rule collapsed.
    shell.applySettings({});
    expect(shell.panels.top).toBe('collapsed');
    expect(shell.panels.bottom).toBe('expanded');
  });

  it('re-homes to a visible edge when both the scope edge and system are hidden', () => {
    const shell = createShellState({ config: { right: false, bottom: false } });
    shell.upsertActivity({
      id: 'encode-2',
      label: 'Encode',
      kind: 'video-encode',
      scope: 'focus',
      status: 'running',
    });
    const edge = shell.listActivities()[0]?.edge;
    expect(edge).toBeDefined();
    expect(shell.panels[edge as 'top']).not.toBe('hidden');
  });

  it('flags progress-only updates as upsert with a previous snapshot', () => {
    const shell = createShellState();
    const events: string[] = [];
    shell.watchActivities((event) => {
      if (event.type !== 'remove') {
        events.push(`${event.type}:${event.previous ? 'has-prev' : 'new'}`);
      }
    });
    shell.upsertActivity({
      id: 'encode-3',
      label: 'Encode',
      kind: 'video-encode',
      scope: 'system',
      status: 'running',
      progress: 10,
    });
    shell.updateActivity('encode-3', { progress: 40 });
    // A new activity is a notify-worthy "started"; a progress-only tick is an
    // upsert carrying `previous`, which the toaster filters out.
    expect(events).toEqual(['upsert:new', 'upsert:has-prev']);
  });

  it('does not leak focus-tool state reads into consumer effects', () => {
    const shell = createShellState();
    const harness = mountMutationEffect(shell, (state) => {
      const unregister = state.registerFocusTool({
        id: 'activity',
        label: 'Activity',
      });
      state.openFocusTool('activity');
      return unregister;
    });

    try {
      flushSync();
      expect(harness.getRuns()).toBe(1);

      shell.collapsePanel('right');
      flushSync();
      shell.openFocusTool('activity');
      flushSync();

      expect(harness.getRuns()).toBe(1);
      expect(shell.focusTools.map((tool) => tool.id)).toEqual(['activity']);
    } finally {
      harness.teardown();
    }
  });

  it('does not leak panel state reads into consumer effects', () => {
    const shell = createShellState();
    const harness = mountMutationEffect(shell, (state) => {
      state.setPanel('right', 'expanded');
      return undefined;
    });

    try {
      flushSync();
      expect(harness.getRuns()).toBe(1);

      shell.togglePanel('right');
      flushSync();

      expect(harness.getRuns()).toBe(1);
      expect(shell.panels.right).toBe('collapsed');
    } finally {
      harness.teardown();
    }
  });

  it('does not leak settings state reads into consumer effects', () => {
    const shell = createShellState();
    const harness = mountMutationEffect(shell, (state) => {
      state.applySettings({ panels: { right: 'expanded' } });
      return undefined;
    });

    try {
      flushSync();
      expect(harness.getRuns()).toBe(1);

      shell.setHotkey('right', 'KeyR');
      flushSync();

      expect(harness.getRuns()).toBe(1);
      expect(shell.settings.keymap?.right).toEqual({ code: 'KeyR' });
    } finally {
      harness.teardown();
    }
  });

  it('does not leak activity state reads into consumer effects', () => {
    const shell = createShellState();
    const harness = mountMutationEffect(shell, (state) => {
      state.upsertActivity({
        id: 'sync-1',
        label: 'Sync',
        kind: 'sync',
        scope: 'system',
        status: 'running',
      });
      return undefined;
    });

    try {
      flushSync();
      expect(harness.getRuns()).toBe(1);

      shell.updateActivity('sync-1', { progress: 50 });
      flushSync();

      expect(harness.getRuns()).toBe(1);
      expect(shell.listActivities()[0]?.progress).toBe(50);
    } finally {
      harness.teardown();
    }
  });

  it('keeps caller-supplied reactive activity inputs tracked', () => {
    const shell = createShellState();
    const harness = mountMutationEffect(shell, (state, inputs) => {
      state.upsertActivity(inputs.activity);
      return undefined;
    });

    try {
      flushSync();
      expect(harness.getRuns()).toBe(1);
      expect(shell.listActivities()[0]?.progress).toBe(0);

      harness.setActivityProgress(75);
      flushSync();

      expect(harness.getRuns()).toBe(2);
      expect(shell.listActivities()[0]?.progress).toBe(75);
    } finally {
      harness.teardown();
    }
  });
});
