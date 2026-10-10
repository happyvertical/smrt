import { describe, expect, it } from 'vitest';
import { sanitizeShellSettingsDelta } from '../index.js';

describe('sanitizeShellSettingsDelta (#3727)', () => {
  it('keeps a valid delta unchanged and reports nothing', () => {
    const input = {
      hotkeysEnabled: false,
      keymap: { left: { code: 'KeyQ', shiftKey: true }, right: null },
      panels: { left: 'collapsed', right: 'expanded' },
      sizes: { left: 320 },
      activeFocusToolId: 'notes',
      layout: { version: 1, hidden: ['reports'] },
    };
    expect(sanitizeShellSettingsDelta(input)).toEqual({
      delta: input,
      issues: [],
    });
  });

  it('treats nothing as an empty delta', () => {
    expect(sanitizeShellSettingsDelta(null)).toEqual({ delta: {}, issues: [] });
    expect(sanitizeShellSettingsDelta(undefined)).toEqual({
      delta: {},
      issues: [],
    });
  });

  it('drops a null size (a reset) without reporting it', () => {
    expect(
      sanitizeShellSettingsDelta({ sizes: { left: null, right: 400 } }),
    ).toEqual({ delta: { sizes: { right: 400 } }, issues: [] });
  });

  it('drops and reports everything malformed, keeping the rest', () => {
    const result = sanitizeShellSettingsDelta({
      hotkeysEnabled: 'yes',
      keymap: {
        left: { code: 'KeyA', ctrlKey: 'true' },
        up: { code: 'KeyW' },
        right: { code: '<script>' },
        top: { code: 'KeyT' },
      },
      panels: { left: 'open', bottom: 'hidden' },
      sizes: { left: -5, right: Number.POSITIVE_INFINITY, top: 99_999 },
      activeFocusToolId: 42,
      layout: { version: 9 },
      extra: true,
    });
    expect(result.delta).toEqual({
      keymap: { top: { code: 'KeyT' } },
      panels: { bottom: 'hidden' },
    });
    expect(result.issues.map((issue) => issue.path).sort()).toEqual(
      [
        'activeFocusToolId',
        'extra',
        'hotkeysEnabled',
        'keymap.left',
        'keymap.right',
        'keymap.up',
        'layout',
        'panels.left',
        'sizes.left',
        'sizes.right',
        'sizes.top',
      ].sort(),
    );
  });

  it('refuses a non-object', () => {
    expect(sanitizeShellSettingsDelta([1, 2]).issues).toHaveLength(1);
    expect(sanitizeShellSettingsDelta('x').delta).toEqual({});
  });
});
