import { resolveHotkey } from './settings.js';
import type {
  PanelEdge,
  ShellHotkeyBinding,
  ShellPanelConfig,
  ShellSettingsDelta,
} from './types.js';
import { PANEL_EDGES } from './types.js';

export type ShellHotkeyAction =
  | { type: 'toggle-panel'; edge: PanelEdge }
  | { type: 'show-shortcuts' };

export function shellActionFromKeyboardEvent(
  event: KeyboardEvent,
  panels: Record<PanelEdge, ShellPanelConfig>,
  settings: ShellSettingsDelta = {},
): ShellHotkeyAction | null {
  if (shouldIgnoreShellHotkey(event, settings)) return null;
  if (isShortcutsEvent(event)) return { type: 'show-shortcuts' };

  for (const edge of PANEL_EDGES) {
    const binding = resolveHotkey(edge, panels[edge], settings);
    if (binding && hotkeyMatchesEvent(binding, event)) {
      return { type: 'toggle-panel', edge };
    }
  }

  return null;
}

export function shouldIgnoreShellHotkey(
  event: KeyboardEvent,
  settings: ShellSettingsDelta = {},
): boolean {
  if (settings.hotkeysEnabled === false) return true;
  if (event.isComposing) return true;
  // An editable control always wins: never hijack a keystroke destined for a
  // field — including `?`, which is otherwise the shortcuts trigger. This must
  // precede the modifier branch below, since `?` carries Shift.
  if (isEditableTarget(event.target)) return true;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return !isShortcutsEvent(event);
  }
  return false;
}

export function hotkeyMatchesEvent(
  binding: ShellHotkeyBinding,
  event: KeyboardEvent,
): boolean {
  return (
    binding.code === event.code &&
    Boolean(binding.altKey) === event.altKey &&
    Boolean(binding.ctrlKey) === event.ctrlKey &&
    Boolean(binding.metaKey) === event.metaKey &&
    Boolean(binding.shiftKey) === event.shiftKey
  );
}

export function isShortcutsEvent(event: KeyboardEvent): boolean {
  return event.key === '?' || (event.code === 'Slash' && event.shiftKey);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (target.isContentEditable) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

export function formatHotkeyBinding(
  binding: ShellHotkeyBinding | null | undefined,
): string {
  if (!binding) return 'Off';
  const parts = [
    binding.ctrlKey ? 'Ctrl' : '',
    binding.altKey ? 'Alt' : '',
    binding.shiftKey ? 'Shift' : '',
    binding.metaKey ? 'Meta' : '',
    binding.code.replace(/^Key/, '').replace(/^Digit/, ''),
  ].filter(Boolean);
  return parts.join('+');
}
