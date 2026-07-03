import { describe, expect, it } from 'vitest';
import {
  mergeShellSettingsDelta,
  resolveHotkey,
  resolveInitialPanelState,
  resolveShellConfig,
} from '../admin-shell/settings.js';

describe('AdminShell settings', () => {
  it('treats false app config as a hidden edge', () => {
    const config = resolveShellConfig({ right: false });
    expect(config.panels.right.initial).toBe('hidden');
    expect(resolveInitialPanelState('right', config.panels.right)).toBe(
      'hidden',
    );
    expect(resolveHotkey('right', config.panels.right)).toBeNull();
  });

  it('resolves user panel deltas over app defaults', () => {
    const config = resolveShellConfig({
      left: { initial: 'collapsed' },
    });
    expect(
      resolveInitialPanelState('left', config.panels.left, {
        panels: { left: 'expanded' },
      }),
    ).toBe('expanded');
  });

  it('merges sparse deltas without replacing unrelated keys', () => {
    expect(
      mergeShellSettingsDelta(
        { hotkeysEnabled: true, panels: { left: 'expanded' } },
        { keymap: { top: { code: 'KeyQ' } } },
      ),
    ).toEqual({
      hotkeysEnabled: true,
      panels: { left: 'expanded' },
      keymap: { top: { code: 'KeyQ' } },
    });
  });
});
