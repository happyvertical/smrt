import { getContext, setContext } from 'svelte';
import type { CommandPaletteController } from './controller.svelte.js';

export const COMMAND_PALETTE_CONTEXT = Symbol('smrt-command-palette');

/**
 * Put a palette on context so descendants (recipe components, pages) can
 * register providers with {@link useCommandPaletteProvider}. Call it in the
 * layout that owns the palette, above the `AppShell`.
 */
export function setCommandPalette(
  controller: CommandPaletteController,
): CommandPaletteController {
  setContext(COMMAND_PALETTE_CONTEXT, controller);
  return controller;
}

/** The nearest palette; throws when there is none. */
export function useCommandPalette(): CommandPaletteController {
  const controller = getContext<CommandPaletteController | undefined>(
    COMMAND_PALETTE_CONTEXT,
  );
  if (!controller) {
    throw new Error(
      '[useCommandPalette] No command palette found on context. Call setCommandPalette() in a parent layout.',
    );
  }
  return controller;
}

/** The nearest palette, or null. */
export function tryUseCommandPalette(): CommandPaletteController | null {
  return (
    getContext<CommandPaletteController | undefined>(COMMAND_PALETTE_CONTEXT) ??
    null
  );
}

/**
 * The palette a component should drive: the explicit one, else the nearest on
 * context. Throws when there is neither. Call during component initialization.
 */
export function palettePicker(
  explicit: () => CommandPaletteController | undefined,
): () => CommandPaletteController {
  const fromContext = tryUseCommandPalette();
  return () => {
    const controller = explicit() ?? fromContext;
    if (!controller) {
      throw new Error(
        '[command palette] Pass a `palette` prop or call setCommandPalette() in a parent layout.',
      );
    }
    return controller;
  };
}
