import { untrack } from 'svelte';
import { tryUseCommandPalette } from './context.js';
import type { CommandPaletteController } from './controller.svelte.js';
import type { PaletteProvider } from './types.js';

/**
 * Register a palette provider for the calling component's lifetime. Pass a
 * getter to follow reactive state: the provider re-registers (replacing the
 * earlier one, same `id`) whenever what it reads changes. A silent no-op when
 * there is no palette on context, so a recipe's component works with or
 * without one. Call during component initialization.
 *
 * @param source The provider, or a function returning it (or null for none).
 * @param controller Override the palette from context.
 */
export function useCommandPaletteProvider(
  source: PaletteProvider | (() => PaletteProvider | null),
  controller: CommandPaletteController | null = tryUseCommandPalette(),
): void {
  if (!controller) return;
  $effect(() => {
    const provider = typeof source === 'function' ? source() : source;
    if (!provider) return;
    // Registering reads and writes the registry; keep that out of this effect.
    return untrack(() => controller.registerProvider(provider));
  });
}
