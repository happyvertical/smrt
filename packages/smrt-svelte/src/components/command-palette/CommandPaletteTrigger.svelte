<script lang="ts">
/**
 * CommandPaletteTrigger - the shell control that opens the palette: a search
 * glyph, a label and the shortcut hint. Place it in a shell slot (the header
 * center or end is the usual home) through `AppShell` `slotItems`. On narrow
 * screens only the glyph shows; the accessible name stays the label.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import { M } from '../../i18n/strings.palette.js';
import { palettePicker } from './context.js';
import type { CommandPaletteController } from './controller.svelte.js';
import {
  ariaKeyShortcuts,
  DEFAULT_PALETTE_HOTKEYS,
  formatPaletteHotkey,
  isApplePlatform,
} from './hotkeys.js';

interface Props {
  /** The palette to open; default: the one on context. */
  palette?: CommandPaletteController;
  /** Button text and accessible name (default "Search"). */
  label?: string;
  /** Hint shown after the label: the first shortcut. Match `hotkeys` on the dialog. */
  hotkeys?: readonly string[];
  /** Glyph only, at every width. */
  compact?: boolean;
  /** Extra class on the button. */
  class?: string;
}

let {
  palette: paletteProp,
  label,
  hotkeys = DEFAULT_PALETTE_HOTKEYS,
  compact = false,
  class: className = '',
}: Props = $props();

const { t } = useI18n();
const pick = palettePicker(() => paletteProp);
const palette = $derived(pick());
const text = $derived(label ?? t(M['ui.command_palette.trigger']));

let apple = $state(false);
onMount(() => {
  apple = isApplePlatform();
});
const hint = $derived(hotkeys[0] ? formatPaletteHotkey(hotkeys[0], apple) : '');
</script>

<Button
  variant="ghost"
  size="sm"
  class={`smrt-command-palette-trigger ${className}`}
  aria-label={text}
  aria-haspopup="dialog"
  aria-expanded={palette.isOpen}
  aria-keyshortcuts={ariaKeyShortcuts(hotkeys)}
  onclick={() => palette.open()}
>
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
  {#if !compact}
    <span class="smrt-command-palette-trigger__label">{text}</span>
    {#if hint}<kbd class="smrt-command-palette-trigger__hint">{hint}</kbd>{/if}
  {/if}
</Button>

<style>
  :global(.smrt-command-palette-trigger) {
    gap: 0.5rem;
  }

  .smrt-command-palette-trigger__hint {
    font: inherit;
    font-size: var(--smrt-typography-label-small-size, 0.75rem);
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--smrt-color-outline-variant, var(--smrt-color-outline));
    border-radius: var(--smrt-radius-small, 0.375rem);
    color: var(--smrt-color-on-surface-variant);
  }

  @media (max-width: 48rem) {
    .smrt-command-palette-trigger__label,
    .smrt-command-palette-trigger__hint {
      display: none;
    }
  }
</style>
