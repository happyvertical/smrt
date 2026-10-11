<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { FieldLabel, Input, Select } from '@happyvertical/smrt-ui/forms';
import {
  ColorSchemeToggle,
  ThemeSwitcher,
} from '@happyvertical/smrt-ui/themes';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { normalizeHex, THEME_FONTS } from '../theme/theme.ts';

interface ThemeSectionProps {
  /**
   * Show the preset and light/dark controls, which drive a smrt-ui theme
   * provider. A host that applies the cookbook's theme itself turns them off
   * and keeps the brand colour, which only writes the document.
   */
  provider?: boolean;
}

let { provider = true }: ThemeSectionProps = $props();

// The app's look. The preset and scheme controls change the shell's theme
// provider, which ThemeBridge reads back into the document; the brand colour
// writes the document and the bridge applies it.
const custom = $derived(cookbookStore.theme?.custom);
let hex = $state('');
let invalid = $state(false);

$effect(() => {
  hex = custom?.primary ?? '';
  invalid = false;
});

function setBrand(primary: string, fontFamily = custom?.fontFamily) {
  const normalized = normalizeHex(primary);
  invalid = !normalized;
  if (!normalized) return;
  cookbookStore.setTheme({
    ...cookbookStore.theme,
    custom: { primary: normalized, ...(fontFamily ? { fontFamily } : {}) },
  });
}

function setFont(fontFamily: string) {
  if (!custom) return;
  setBrand(custom.primary, fontFamily || undefined);
}

function resetToPreset() {
  cookbookStore.setTheme({ ...cookbookStore.theme, custom: undefined });
}
</script>

<section class="theme" aria-labelledby="theme-heading">
  <h2 id="theme-heading">Theme</h2>
  <p class="meta">
    The look of this app. It is saved with your cookbook and applies as you
    change it.
  </p>
  {#if provider}
    <div class="row">
      <ThemeSwitcher label="Preset" variant="select" showIcons={false} />
      <ColorSchemeToggle variant="segmented" ariaLabel="Colour scheme" />
    </div>
  {/if}
  <div class="brand">
    <div class="field">
      <FieldLabel for="theme-brand-colour" label="Brand colour" />
      <div class="pick">
        <input
          id="theme-brand-colour"
          class="swatch"
          type="color"
          aria-label="Brand colour picker"
          value={custom?.primary ?? '#e68a00'}
          oninput={(event) => setBrand(event.currentTarget.value)}
        />
        <Input
          type="text"
          aria-label="Brand colour hex"
          placeholder="#c2410c"
          autocomplete="off"
          spellcheck="false"
          value={hex}
          aria-invalid={invalid}
          oninput={(event) => {
            hex = event.currentTarget.value;
            if (hex.trim()) setBrand(hex);
          }}
        />
      </div>
    </div>
    <div class="field">
      <FieldLabel for="theme-brand-font" label="Font" />
      <Select
        id="theme-brand-font"
        value={custom?.fontFamily ?? ''}
        disabled={!custom}
        onchange={(event) => setFont(event.currentTarget.value)}
      >
        <option value="">Default</option>
        {#each Object.keys(THEME_FONTS) as font (font)}
          <option value={font}>{font}</option>
        {/each}
      </Select>
      {#if !custom}
        <span class="hint">Pick a brand colour to choose a font.</span>
      {/if}
    </div>
    {#if custom}
      <Button variant="secondary" onclick={resetToPreset}>Reset to preset</Button>
    {/if}
  </div>
  {#if invalid}
    <p class="meta" role="alert">Use a hex colour like #c2410c.</p>
  {/if}
</section>

<style>
  .theme {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  h2,
  p {
    margin: 0;
  }

  .meta {
    color: var(--smrt-color-on-surface-variant);
  }

  .row,
  .brand {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-4);
    align-items: end;
  }

  .field {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .pick {
    display: flex;
    gap: var(--smrt-spacing-2);
    align-items: center;
  }

  .swatch {
    inline-size: 3rem;
    block-size: 2.5rem;
    padding: var(--smrt-spacing-1);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 0.5rem);
    background: var(--smrt-color-surface);
    cursor: pointer;
  }

  .hint {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.8125rem;
  }
</style>
