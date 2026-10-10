<script lang="ts">
/**
 * CommandPalette - the trigger and the dialog together: the one component a
 * host drops into a shell slot.
 *
 * ```svelte
 * <AppShell slotItems={[{ id: 'item:command-palette', label: 'Search',
 *   slot: 'header.center', render: search }]} ... />
 * ```
 *
 * The palette is the `palette` prop, else the nearest `setCommandPalette()`
 * context, else one created here from `providers` and `navigate` (then only
 * this component can reach it). Mount it once: it owns the global shortcut.
 */
import { onDestroy, untrack } from 'svelte';
import CommandPaletteDialog from './CommandPaletteDialog.svelte';
import CommandPaletteTrigger from './CommandPaletteTrigger.svelte';
import { tryUseCommandPalette } from './context.js';
import {
  CommandPaletteController,
  type CommandPaletteOptions,
} from './controller.svelte.js';
import { DEFAULT_PALETTE_HOTKEYS } from './hotkeys.js';
import type { PaletteProvider } from './types.js';

interface Props {
  /** The palette to use; default: context, else a new one. */
  palette?: CommandPaletteController;
  /** Providers for the palette created here (ignored when one is supplied). */
  providers?: readonly PaletteProvider[];
  /** Navigation seam for the palette created here. */
  navigate?: CommandPaletteOptions['navigate'];
  /** Shortcuts that toggle the palette; `false` for none. */
  hotkeys?: readonly string[] | false;
  /** Trigger text and dialog name (default "Search"). */
  label?: string;
  /** Show only the glyph in the trigger. */
  compact?: boolean;
  /** Render the dialog and shortcut without a trigger. */
  hideTrigger?: boolean;
}

let {
  palette: paletteProp,
  providers = [],
  navigate,
  hotkeys = DEFAULT_PALETTE_HOTKEYS,
  label,
  compact = false,
  hideTrigger = false,
}: Props = $props();

// The palette made here (when none is supplied) is built once from the initial
// `providers` and `navigate`; register later providers through the controller.
const fromContext = tryUseCommandPalette();
const owned: CommandPaletteController | null = untrack(() =>
  paletteProp || fromContext
    ? null
    : new CommandPaletteController({ providers, navigate }),
);
onDestroy(() => owned?.destroy());
const palette = $derived(
  paletteProp ?? fromContext ?? (owned as CommandPaletteController),
);
</script>

{#if !hideTrigger}
  <CommandPaletteTrigger
    {palette}
    {label}
    {compact}
    hotkeys={hotkeys === false ? [] : hotkeys}
  />
{/if}
<CommandPaletteDialog {palette} {hotkeys} {label} />
