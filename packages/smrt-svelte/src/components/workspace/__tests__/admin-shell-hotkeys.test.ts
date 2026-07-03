import { describe, expect, it } from 'vitest';
import {
  hotkeyMatchesEvent,
  shellActionFromKeyboardEvent,
} from '../admin-shell/hotkeys.js';
import { resolveShellConfig } from '../admin-shell/settings.js';

function keyEvent(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('AdminShell hotkeys', () => {
  it('matches physical KeyboardEvent.code bindings', () => {
    expect(
      hotkeyMatchesEvent({ code: 'KeyW' }, keyEvent({ code: 'KeyW' })),
    ).toBe(true);
    expect(
      hotkeyMatchesEvent({ code: 'KeyW' }, keyEvent({ code: 'KeyZ' })),
    ).toBe(false);
  });

  it('maps WASD codes to shell edges', () => {
    const { panels } = resolveShellConfig();
    expect(
      shellActionFromKeyboardEvent(keyEvent({ code: 'KeyW' }), panels),
    ).toEqual({ type: 'toggle-panel', edge: 'top' });
    expect(
      shellActionFromKeyboardEvent(keyEvent({ code: 'KeyA' }), panels),
    ).toEqual({ type: 'toggle-panel', edge: 'left' });
    expect(
      shellActionFromKeyboardEvent(keyEvent({ code: 'KeyS' }), panels),
    ).toEqual({ type: 'toggle-panel', edge: 'bottom' });
    expect(
      shellActionFromKeyboardEvent(keyEvent({ code: 'KeyD' }), panels),
    ).toEqual({ type: 'toggle-panel', edge: 'right' });
  });

  it('suppresses panel hotkeys in editable controls', () => {
    const input = document.createElement('input');
    const event = keyEvent({ code: 'KeyW' });
    Object.defineProperty(event, 'target', { value: input });
    expect(
      shellActionFromKeyboardEvent(event, resolveShellConfig().panels),
    ).toBe(null);
  });

  it('keeps the shortcuts overlay available on question mark', () => {
    expect(
      shellActionFromKeyboardEvent(
        keyEvent({ key: '?', code: 'Slash', shiftKey: true }),
        resolveShellConfig().panels,
      ),
    ).toEqual({ type: 'show-shortcuts' });
  });

  it('does not open shortcuts when typing ? in an editable control', () => {
    const input = document.createElement('input');
    const event = keyEvent({ key: '?', code: 'Slash', shiftKey: true });
    Object.defineProperty(event, 'target', { value: input });
    expect(
      shellActionFromKeyboardEvent(event, resolveShellConfig().panels),
    ).toBe(null);
  });
});
