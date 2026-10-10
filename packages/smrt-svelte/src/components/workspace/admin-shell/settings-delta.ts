/**
 * Read an untrusted value as a {@link ShellSettingsDelta} (#3727).
 *
 * The browser settings adapter trusts what it wrote itself; a server that
 * stores shell preferences for many users (`@happyvertical/smrt-preferences`)
 * must not. This module is pure (no Svelte, no DOM) and is published on the
 * Node-safe `./workspace/server` subpath as well as `./workspace`.
 */
import { isShellLayoutEmpty, normalizeShellLayout } from './layout.js';
import type {
  PanelEdge,
  PanelState,
  ShellHotkeyBinding,
  ShellSettingsDelta,
} from './types.js';

const EDGES: readonly PanelEdge[] = ['top', 'left', 'right', 'bottom'];
const PANEL_STATES: readonly PanelState[] = ['hidden', 'collapsed', 'expanded'];
const MODIFIERS = ['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const;
const DELTA_KEYS = new Set([
  'hotkeysEnabled',
  'keymap',
  'panels',
  'sizes',
  'activeFocusToolId',
  'layout',
]);
/** `KeyboardEvent.code` values are short ASCII identifiers. */
const KEY_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
/** Generous bound on a stored panel width in CSS pixels. */
const MAX_PANEL_SIZE = 10_000;
const MAX_FOCUS_TOOL_ID_LENGTH = 200;

/** One part of a stored delta that was dropped, and why. */
export interface ShellSettingsIssue {
  /** Dotted path of the dropped value, e.g. `keymap.left`. */
  path: string;
  message: string;
}

export interface ShellSettingsDeltaCheck {
  /** The readable part, pruned (empty object when nothing is left). */
  delta: ShellSettingsDelta;
  /** What was dropped. Empty when the input was a valid delta. */
  issues: ShellSettingsIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBinding(value: unknown): ShellHotkeyBinding | undefined {
  if (!isRecord(value) || typeof value.code !== 'string') return undefined;
  if (!KEY_CODE_PATTERN.test(value.code)) return undefined;
  const binding: ShellHotkeyBinding = { code: value.code };
  for (const key of Object.keys(value)) {
    if (key === 'code') continue;
    if (!(MODIFIERS as readonly string[]).includes(key)) return undefined;
    const flag = value[key];
    if (typeof flag !== 'boolean') return undefined;
    if (flag) binding[key as (typeof MODIFIERS)[number]] = true;
  }
  return binding;
}

function readEdgeMap<T>(
  value: unknown,
  name: string,
  read: (entry: unknown) => T | undefined,
  issues: ShellSettingsIssue[],
): Partial<Record<PanelEdge, T>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push({ path: name, message: 'must be an object keyed by edge' });
    return undefined;
  }
  const out: Partial<Record<PanelEdge, T>> = {};
  for (const [edge, entry] of Object.entries(value)) {
    if (!(EDGES as readonly string[]).includes(edge)) {
      issues.push({ path: `${name}.${edge}`, message: 'unknown edge' });
      continue;
    }
    const parsed = read(entry);
    if (parsed === undefined) {
      issues.push({ path: `${name}.${edge}`, message: 'invalid value' });
      continue;
    }
    out[edge as PanelEdge] = parsed;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Validate and prune an untrusted shell settings delta. Never throws:
 * unknown keys and malformed values are dropped and reported, the rest is
 * kept. A caller that must refuse bad input (a save) checks `issues`; a
 * reader that must degrade (a load) uses `delta`.
 */
export function sanitizeShellSettingsDelta(
  input: unknown,
): ShellSettingsDeltaCheck {
  const issues: ShellSettingsIssue[] = [];
  const delta: ShellSettingsDelta = {};
  if (input === null || input === undefined) return { delta, issues };
  if (!isRecord(input)) {
    issues.push({ path: '', message: 'shell settings must be an object' });
    return { delta, issues };
  }
  for (const key of Object.keys(input)) {
    if (!DELTA_KEYS.has(key)) {
      issues.push({ path: key, message: 'unknown setting' });
    }
  }
  if (input.hotkeysEnabled !== undefined) {
    if (typeof input.hotkeysEnabled === 'boolean') {
      delta.hotkeysEnabled = input.hotkeysEnabled;
    } else {
      issues.push({ path: 'hotkeysEnabled', message: 'must be a boolean' });
    }
  }
  if (input.activeFocusToolId !== undefined) {
    const id = input.activeFocusToolId;
    if (
      id === null ||
      (typeof id === 'string' &&
        id !== '' &&
        id.length <= MAX_FOCUS_TOOL_ID_LENGTH)
    ) {
      delta.activeFocusToolId = id;
    } else {
      issues.push({
        path: 'activeFocusToolId',
        message: 'must be a short string or null',
      });
    }
  }
  const keymap = readEdgeMap(
    input.keymap,
    'keymap',
    (entry) => (entry === null ? null : readBinding(entry)),
    issues,
  );
  if (keymap) delta.keymap = keymap;
  const panels = readEdgeMap(
    input.panels,
    'panels',
    (entry) =>
      (PANEL_STATES as readonly unknown[]).includes(entry)
        ? (entry as PanelState)
        : undefined,
    issues,
  );
  if (panels) delta.panels = panels;
  // A `null` size means "back to the configured width": nothing to store.
  const sizes = readEdgeMap(
    isRecord(input.sizes)
      ? Object.fromEntries(
          Object.entries(input.sizes).filter(([, size]) => size !== null),
        )
      : input.sizes,
    'sizes',
    (entry) =>
      typeof entry === 'number' &&
      Number.isFinite(entry) &&
      entry > 0 &&
      entry <= MAX_PANEL_SIZE
        ? entry
        : undefined,
    issues,
  );
  if (sizes) delta.sizes = sizes;
  if (input.layout !== undefined) {
    const layout = normalizeShellLayout(input.layout);
    if (!isShellLayoutEmpty(layout)) {
      delta.layout = layout;
    } else if (input.layout !== null) {
      issues.push({ path: 'layout', message: 'unreadable or empty layout' });
    }
  }
  return { delta, issues };
}
