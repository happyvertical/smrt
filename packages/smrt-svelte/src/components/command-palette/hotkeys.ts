/**
 * Hotkey specs for the command palette: `"Mod+K"`, `"Ctrl+Shift+P"`, `"/"`.
 *
 * `Mod` is the platform command key: either Control or Meta matches, so
 * Cmd+K on macOS and Ctrl+K elsewhere (and an external keyboard on either)
 * all work. A spec with no modifier (`"/"`) never fires while the user is
 * typing in a field; a spec with a modifier fires anywhere, because Ctrl/Cmd+K
 * is not a character a field could be waiting for.
 */
import { isEditableTarget } from '../workspace/admin-shell/hotkeys.js';

/** Parsed hotkey. */
export interface PaletteHotkey {
  /** Lower-cased `KeyboardEvent.key`, e.g. `k` or `/`. */
  key: string;
  /** Control or Meta. */
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

/** The palette's default shortcut. */
export const DEFAULT_PALETTE_HOTKEYS: readonly string[] = ['Mod+K'];

/** Parse `"Mod+K"`; null when the spec has no key. */
export function parsePaletteHotkey(spec: string): PaletteHotkey | null {
  const parts = spec
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  // "Mod++" would mean Mod and "+", which no palette needs: drop empties.
  const key = parts.pop();
  if (!key) return null;
  const hotkey: PaletteHotkey = {
    key: key.toLowerCase(),
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  };
  for (const part of parts) {
    switch (part.toLowerCase()) {
      case 'mod':
        hotkey.mod = true;
        break;
      case 'ctrl':
      case 'control':
        hotkey.ctrl = true;
        break;
      case 'meta':
      case 'cmd':
      case 'command':
        hotkey.meta = true;
        break;
      case 'alt':
      case 'option':
        hotkey.alt = true;
        break;
      case 'shift':
        hotkey.shift = true;
        break;
      default:
        return null;
    }
  }
  return hotkey;
}

function keyMatches(hotkey: PaletteHotkey, event: KeyboardEvent): boolean {
  if (event.key.toLowerCase() === hotkey.key) return true;
  // A letter on a non-Latin layout or with Alt held still has its physical key.
  return (
    /^[a-z]$/.test(hotkey.key) &&
    event.code === `Key${hotkey.key.toUpperCase()}`
  );
}

/** Whether `event` is the hotkey (modifiers must match exactly). */
export function matchesPaletteHotkey(
  hotkey: PaletteHotkey,
  event: KeyboardEvent,
): boolean {
  if (!keyMatches(hotkey, event)) return false;
  if (hotkey.mod) {
    if (!(event.ctrlKey || event.metaKey)) return false;
  } else if (event.ctrlKey !== hotkey.ctrl || event.metaKey !== hotkey.meta) {
    return false;
  }
  if (event.altKey !== hotkey.alt) return false;
  // A bare symbol such as "/" or "?" may need Shift on some layouts.
  const symbol = !/^[a-z0-9]$/.test(hotkey.key);
  const modified = hotkey.mod || hotkey.ctrl || hotkey.meta || hotkey.alt;
  if (symbol && !modified && !hotkey.shift) return true;
  return event.shiftKey === hotkey.shift;
}

/**
 * Whether `event` should open the palette: it matches one of `hotkeys`, is
 * not part of an IME composition, was not already handled, and (for a bare
 * key) is not going to a text field.
 */
export function isPaletteHotkeyEvent(
  event: KeyboardEvent,
  hotkeys: readonly PaletteHotkey[],
): boolean {
  if (event.isComposing || event.defaultPrevented || event.repeat) return false;
  for (const hotkey of hotkeys) {
    if (!matchesPaletteHotkey(hotkey, event)) continue;
    const modified = hotkey.mod || hotkey.ctrl || hotkey.meta || hotkey.alt;
    if (!modified && isEditableTarget(event.target)) continue;
    return true;
  }
  return false;
}

/** Whether the platform shows the command key as a symbol (Apple devices). */
export function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = nav.userAgentData?.platform ?? nav.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(platform);
}

/** Display text for a hotkey: `⌘K` on Apple devices, `Ctrl+K` elsewhere. */
export function formatPaletteHotkey(
  spec: string | PaletteHotkey,
  apple: boolean = isApplePlatform(),
): string {
  const hotkey = typeof spec === 'string' ? parsePaletteHotkey(spec) : spec;
  if (!hotkey) return typeof spec === 'string' ? spec : '';
  const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;
  if (apple) {
    return (
      (hotkey.ctrl ? '⌃' : '') +
      (hotkey.alt ? '⌥' : '') +
      (hotkey.shift ? '⇧' : '') +
      (hotkey.mod || hotkey.meta ? '⌘' : '') +
      key
    );
  }
  const parts = [
    hotkey.mod || hotkey.ctrl ? 'Ctrl' : '',
    hotkey.meta ? 'Meta' : '',
    hotkey.alt ? 'Alt' : '',
    hotkey.shift ? 'Shift' : '',
    key,
  ].filter(Boolean);
  return parts.join('+');
}

/** The `aria-keyshortcuts` value for specs: `Mod+K` -> `Control+K Meta+K`. */
export function ariaKeyShortcuts(specs: readonly string[]): string | undefined {
  const out: string[] = [];
  for (const spec of specs) {
    const hotkey = parsePaletteHotkey(spec);
    if (!hotkey) continue;
    const key = hotkey.key.length === 1 ? hotkey.key.toUpperCase() : hotkey.key;
    const shared = [
      hotkey.alt ? 'Alt' : '',
      hotkey.shift ? 'Shift' : '',
    ].filter(Boolean);
    if (hotkey.mod) {
      out.push([...shared, 'Control', key].join('+'));
      out.push([...shared, 'Meta', key].join('+'));
    } else {
      out.push(
        [
          hotkey.ctrl ? 'Control' : '',
          hotkey.meta ? 'Meta' : '',
          ...shared,
          key,
        ]
          .filter(Boolean)
          .join('+'),
      );
    }
  }
  return out.length > 0 ? out.join(' ') : undefined;
}
