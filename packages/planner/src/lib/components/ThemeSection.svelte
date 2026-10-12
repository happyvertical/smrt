<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { FieldLabel, Input, Select } from '@happyvertical/smrt-ui/forms';
import {
  ColorSchemeToggle,
  themePresets,
  tryGetThemeContext,
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
const context = tryGetThemeContext();
const custom = $derived(cookbookStore.theme?.custom);
const icons: Record<string, string> = {
  material: '◆',
  glass: '◇',
  studio: '▣',
  smrt: '✦',
  happyvertical: '⬡',
};
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
  {#if provider && context}
    <div class="cards" role="group" aria-label="Theme look">
      {#each themePresets as preset (preset.id)}
        {@const palette = context.state.resolvedScheme === 'dark' ? preset.dark : preset.light}
        <button type="button" class="choice preset"
          class:selected={!custom && (cookbookStore.theme?.preset ?? 'glass') === preset.id}
          aria-pressed={!custom && (cookbookStore.theme?.preset ?? 'glass') === preset.id}
          onclick={() => context?.setPreset(preset.id)}
          style:--preview-bg={palette.background}
          style:--preview-surface={palette.surface}
          style:--preview-primary={palette.primary}
          style:--preview-ink={palette.onSurface}>
          <span class="choice-name"><span class="choice-icon" aria-hidden="true">{icons[preset.id]}</span>{preset.label}</span>
          <span class="preview" aria-hidden="true">
            <span class="preview-sidebar"><span></span><span></span><span></span></span>
            <span class="preview-main"><span class="preview-title"></span><span class="preview-body"><span></span><span></span></span></span>
          </span>
        </button>
      {/each}
    </div>
    <div class="row">
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
  <div class="field">
    <FieldLabel for="theme-custom-css" label="Custom CSS notes" />
    <textarea id="theme-custom-css" aria-label="Custom CSS notes" rows="8" spellcheck="false"
      value={cookbookStore.theme?.customCss ?? ''}
      oninput={(event) => cookbookStore.setTheme({ ...cookbookStore.theme, customCss: event.currentTarget.value || undefined })}></textarea>
    <span class="hint">Saved with your cookbook as notes for your agent to refine. This CSS is not applied to the app.</span>
  </div>
</section>

<style>
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(10rem, 100%), 1fr)); gap: .75rem; }
  .choice { display: grid; align-content: start; gap: .8rem; min-block-size: 8.5rem; padding: .85rem; border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-large, .75rem); background: var(--smrt-color-surface-container-low); color: var(--smrt-color-on-surface); text-align: start; cursor: pointer; transition: border-color .15s, background .15s, transform .15s; }
  .choice:hover { border-color: var(--smrt-color-primary); background: var(--smrt-color-surface-container); transform: translateY(-2px); }
  .choice.selected { border: 2px solid var(--smrt-color-primary); padding: calc(.85rem - 1px); background: var(--smrt-color-primary-container); color: var(--smrt-color-on-primary-container); }
  .choice:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .choice-name { display: inline-flex; align-items: center; gap: .55rem; font-size: 1rem; font-weight: 700; line-height: 1.2; }
  .choice-icon { display: inline-grid; place-items: center; flex: none; inline-size: 1.5rem; block-size: 1.5rem; font-size: 1.35rem; color: var(--smrt-color-primary); }
  .preview { display: flex; overflow: hidden; inline-size: 100%; block-size: 4.5rem; border-radius: .4rem; border: 1px solid color-mix(in srgb, var(--preview-ink) 20%, transparent); background: var(--preview-bg); }
  .preview-sidebar { display: grid; align-content: start; gap: .35rem; inline-size: 23%; padding: .5rem .3rem; background: var(--preview-primary); }
  .preview-sidebar span { block-size: .22rem; border-radius: 1rem; background: var(--preview-surface); opacity: .8; }
  .preview-main { display: grid; align-content: start; gap: .4rem; flex: 1; padding: .6rem; }
  .preview-title { inline-size: 55%; block-size: .32rem; border-radius: 1rem; background: var(--preview-ink); opacity: .7; }
  .preview-body { display: grid; gap: .25rem; padding: .35rem; border-radius: .2rem; background: var(--preview-surface); }
  .preview-body span { block-size: .2rem; border-radius: 1rem; background: var(--preview-primary); opacity: .7; }
  .preview-body span:last-child { inline-size: 70%; opacity: .35; }
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

  textarea { inline-size: min(100%, 48rem); min-block-size: 10rem; padding: var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-md, 0.5rem); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); font: 0.9rem ui-monospace, monospace; }

  .hint {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.8125rem;
  }
</style>
