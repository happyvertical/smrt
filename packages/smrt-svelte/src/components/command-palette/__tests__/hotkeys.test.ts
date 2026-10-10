import { describe, expect, it } from 'vitest';
import {
  ariaKeyShortcuts,
  formatPaletteHotkey,
  isPaletteHotkeyEvent,
  matchesPaletteHotkey,
  parsePaletteHotkey,
} from '../hotkeys.js';

function key(init: KeyboardEventInit & { target?: EventTarget }) {
  const event = new KeyboardEvent('keydown', {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  if (init.target) {
    Object.defineProperty(event, 'target', { value: init.target });
  }
  return event;
}

describe('palette hotkeys', () => {
  it('parses specs', () => {
    expect(parsePaletteHotkey('Mod+K')).toMatchObject({ key: 'k', mod: true });
    expect(parsePaletteHotkey('ctrl+shift+P')).toMatchObject({
      key: 'p',
      ctrl: true,
      shift: true,
    });
    expect(parsePaletteHotkey('/')).toMatchObject({ key: '/', mod: false });
    expect(parsePaletteHotkey('')).toBeNull();
    expect(parsePaletteHotkey('Hyper+K')).toBeNull();
  });

  it('Mod matches Control or Meta, and nothing extra', () => {
    const mod = parsePaletteHotkey('Mod+K');
    if (!mod) throw new Error('parse');
    expect(matchesPaletteHotkey(mod, key({ key: 'k', ctrlKey: true }))).toBe(
      true,
    );
    expect(matchesPaletteHotkey(mod, key({ key: 'K', metaKey: true }))).toBe(
      true,
    );
    expect(matchesPaletteHotkey(mod, key({ key: 'k' }))).toBe(false);
    expect(
      matchesPaletteHotkey(mod, key({ key: 'k', ctrlKey: true, altKey: true })),
    ).toBe(false);
    expect(
      matchesPaletteHotkey(
        mod,
        key({ key: 'k', ctrlKey: true, shiftKey: true }),
      ),
    ).toBe(false);
    // Physical key still counts on another layout.
    expect(
      matchesPaletteHotkey(mod, key({ key: 'л', code: 'KeyK', ctrlKey: true })),
    ).toBe(true);
  });

  it('a bare symbol key tolerates Shift but not other modifiers', () => {
    const slash = parsePaletteHotkey('/');
    if (!slash) throw new Error('parse');
    expect(matchesPaletteHotkey(slash, key({ key: '/' }))).toBe(true);
    expect(matchesPaletteHotkey(slash, key({ key: '/', shiftKey: true }))).toBe(
      true,
    );
    expect(matchesPaletteHotkey(slash, key({ key: '/', ctrlKey: true }))).toBe(
      false,
    );
  });

  it('bare keys ignore text fields; modified keys do not', () => {
    const hotkeys = ['Mod+K', '/'].flatMap((s) => parsePaletteHotkey(s) ?? []);
    const input = document.createElement('input');
    document.body.append(input);
    expect(
      isPaletteHotkeyEvent(key({ key: '/', target: input }), hotkeys),
    ).toBe(false);
    expect(
      isPaletteHotkeyEvent(
        key({ key: 'k', ctrlKey: true, target: input }),
        hotkeys,
      ),
    ).toBe(true);
    expect(isPaletteHotkeyEvent(key({ key: '/' }), hotkeys)).toBe(true);
    input.remove();
  });

  it('ignores composition, repeats and handled events', () => {
    const hotkeys = [parsePaletteHotkey('Mod+K') ?? []].flat();
    expect(
      isPaletteHotkeyEvent(
        key({ key: 'k', ctrlKey: true, isComposing: true }),
        hotkeys,
      ),
    ).toBe(false);
    expect(
      isPaletteHotkeyEvent(
        key({ key: 'k', ctrlKey: true, repeat: true }),
        hotkeys,
      ),
    ).toBe(false);
    const handled = key({ key: 'k', ctrlKey: true });
    handled.preventDefault();
    expect(isPaletteHotkeyEvent(handled, hotkeys)).toBe(false);
  });

  it('formats for the platform and for aria-keyshortcuts', () => {
    expect(formatPaletteHotkey('Mod+K', true)).toBe('⌘K');
    expect(formatPaletteHotkey('Mod+K', false)).toBe('Ctrl+K');
    expect(formatPaletteHotkey('Ctrl+Shift+P', false)).toBe('Ctrl+Shift+P');
    expect(formatPaletteHotkey('/', false)).toBe('/');
    expect(ariaKeyShortcuts(['Mod+K', '/'])).toBe('Control+K Meta+K /');
    expect(ariaKeyShortcuts([])).toBeUndefined();
  });
});
