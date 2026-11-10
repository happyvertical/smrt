<script lang="ts">
import { Button } from '@happyvertical/smrt-ui';
import { FieldLabel, Input } from '@happyvertical/smrt-ui/forms';
import {
  themePresets,
  tryGetThemeContext,
} from '@happyvertical/smrt-ui/themes';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { customCssApproved } from '../theme/custom-css.svelte.ts';
import {
  type BorderRadiusSetting,
  type ColorSchemeSetting,
  type ContrastSetting,
  type DensitySetting,
  normalizeHex,
  THEME_FONTS,
  type ThemeSetting,
} from '../theme/theme.ts';

interface Props {
  provider?: boolean;
  advancedStylesHref?: string;
}
let { provider = true, advancedStylesHref = '#/advanced-styles/' }: Props =
  $props();
const context = tryGetThemeContext();
const custom = $derived(cookbookStore.theme?.custom);
let hex = $state('');
let invalid = $state(false);
$effect(() => {
  hex = custom?.primary ?? '';
  invalid = false;
});

const icons: Record<string, string> = {
  material: '◆',
  glass: '◇',
  studio: '▣',
  smrt: '✦',
  happyvertical: '⬡',
};
const schemes: {
  id: ColorSchemeSetting;
  label: string;
  icon: string;
  hint: string;
}[] = [
  { id: 'light', label: 'Light', icon: '☀', hint: 'Bright all the time' },
  { id: 'dark', label: 'Dark', icon: '☾', hint: 'Dim all the time' },
  { id: 'system', label: 'Auto', icon: '◐', hint: 'Follow this device' },
];

// Corner radius, density and contrast. Each control shows the effective value;
// choosing the default (the preset's own radius, comfortable, auto) removes
// the field so the cookbook keeps only what was changed.
const radii: { id: BorderRadiusSetting; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'sm', label: 'Small' },
  { id: 'md', label: 'Medium' },
  { id: 'lg', label: 'Large' },
  { id: 'xl', label: 'Extra large' },
  { id: 'full', label: 'Full' },
];
const densities: { id: DensitySetting; label: string }[] = [
  { id: 'comfortable', label: 'Comfortable' },
  { id: 'touch', label: 'Touch' },
];
const contrasts: { id: ContrastSetting; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'standard', label: 'Standard' },
  { id: 'more', label: 'More' },
];
const DEFAULTS = {
  borderRadius: 'md',
  density: 'comfortable',
  contrast: 'auto',
} as const;

function setShape<K extends keyof typeof DEFAULTS>(
  key: K,
  value: NonNullable<ThemeSetting[K]>,
) {
  cookbookStore.setTheme({
    ...cookbookStore.theme,
    [key]: value === DEFAULTS[key] ? undefined : value,
  });
}

function setBrand(primary: string) {
  const normalized = normalizeHex(primary);
  invalid = !normalized;
  if (!normalized) return;
  cookbookStore.setTheme({
    ...cookbookStore.theme,
    fontFamily: cookbookStore.theme?.fontFamily ?? custom?.fontFamily,
    custom: { primary: normalized },
  });
}

function setFont(fontFamily: string) {
  const legacyCustom = custom ? { primary: custom.primary } : undefined;
  cookbookStore.setTheme({
    ...cookbookStore.theme,
    fontFamily: fontFamily || undefined,
    custom: legacyCustom,
  });
}

function resetToPreset() {
  cookbookStore.setTheme({
    ...cookbookStore.theme,
    fontFamily: cookbookStore.theme?.fontFamily ?? custom?.fontFamily,
    custom: undefined,
  });
}
const cssPending = $derived.by(() => {
  const css = cookbookStore.theme?.customCss;
  return Boolean(css) && !customCssApproved(css ?? '');
});
</script>

<section class="smrt-theme-section__root" aria-label="Theme settings" data-smrt-component="ThemeSection">
  {#if provider && context}
    <div class="smrt-theme-section__cards" role="group" aria-label="Theme look" data-smrt-part="grid">
      {#each themePresets as preset (preset.id)}
        {@const palette = context.state.resolvedScheme === 'dark' ? preset.dark : preset.light}
        <button type="button" class="smrt-theme-section__choice smrt-theme-section__preset" data-smrt-part="card"
          class:smrt-theme-section__selected={!custom && (cookbookStore.theme?.preset ?? 'glass') === preset.id}
          aria-pressed={!custom && (cookbookStore.theme?.preset ?? 'glass') === preset.id}
          onclick={() => context?.setPreset(preset.id)}
          style:--smrt-planner-preview-bg={palette.background}
          style:--smrt-planner-preview-surface={palette.surface}
          style:--smrt-planner-preview-primary={palette.primary}
          style:--smrt-planner-preview-ink={palette.onSurface}>
          <span class="smrt-theme-section__name" data-smrt-part="name"><span class="smrt-theme-section__icon" aria-hidden="true" data-smrt-part="icon">{icons[preset.id]}</span>{preset.label}</span>
          <span class="smrt-theme-section__preview" aria-hidden="true" data-smrt-part="preview">
            <span class="smrt-theme-section__preview-sidebar" data-smrt-part="panel"><span></span><span></span><span></span></span>
            <span class="smrt-theme-section__preview-main" data-smrt-part="main"><span class="smrt-theme-section__preview-title" data-smrt-part="title"></span><span class="smrt-theme-section__preview-body" data-smrt-part="body"><span></span><span></span></span></span>
          </span>
        </button>
      {/each}
    </div>
    <div class="smrt-theme-section__cards smrt-theme-section__schemes" role="group" aria-label="Appearance" data-smrt-part="grid">
      {#each schemes as scheme (scheme.id)}
        <button type="button" class="smrt-theme-section__choice smrt-theme-section__scheme" data-smrt-part="card"
          class:smrt-theme-section__selected={context.state.colorScheme === scheme.id}
          aria-pressed={context.state.colorScheme === scheme.id}
          onclick={() => context?.setColorScheme(scheme.id)}>
          <span class="smrt-theme-section__name" data-smrt-part="name"><span class="smrt-theme-section__icon" aria-hidden="true" data-smrt-part="icon">{scheme.icon}</span>{scheme.label}</span>
          <span class="smrt-theme-section__hint" data-smrt-part="hint">{scheme.hint}</span>
        </button>
      {/each}
    </div>
  {/if}
  <div class="smrt-theme-section__shape" role="group" aria-label="Shape and contrast" data-smrt-part="row">
    <div class="smrt-theme-section__field" data-smrt-part="field">
      <FieldLabel for="theme-radius" label="Corner radius" />
      <select id="theme-radius" value={cookbookStore.theme?.borderRadius ?? DEFAULTS.borderRadius}
        onchange={(event) => setShape('borderRadius', event.currentTarget.value as BorderRadiusSetting)}>
        {#each radii as radius (radius.id)}<option value={radius.id}>{radius.label}</option>{/each}
      </select>
    </div>
    <div class="smrt-theme-section__field" data-smrt-part="field">
      <FieldLabel for="theme-density" label="Density" />
      <select id="theme-density" value={cookbookStore.theme?.density ?? DEFAULTS.density}
        onchange={(event) => setShape('density', event.currentTarget.value as DensitySetting)}>
        {#each densities as density (density.id)}<option value={density.id}>{density.label}</option>{/each}
      </select>
    </div>
    <div class="smrt-theme-section__field" data-smrt-part="field">
      <FieldLabel for="theme-contrast" label="Contrast" />
      <select id="theme-contrast" value={cookbookStore.theme?.contrast ?? DEFAULTS.contrast}
        onchange={(event) => setShape('contrast', event.currentTarget.value as ContrastSetting)}>
        {#each contrasts as contrast (contrast.id)}<option value={contrast.id}>{contrast.label}</option>{/each}
      </select>
    </div>
  </div>
  <div class="smrt-theme-section__brand" data-smrt-part="row">
    <div class="smrt-theme-section__field" data-smrt-part="field">
      <FieldLabel for="theme-brand-colour" label="Brand colour" />
      <div class="smrt-theme-section__pick" data-smrt-part="row">
        <span class="smrt-theme-section__wheel" style:--smrt-planner-picked-color={custom?.primary ?? '#e68a00'} data-smrt-part="value">
          <input id="theme-brand-colour" type="color" aria-label="Choose brand colour"
            value={custom?.primary ?? '#e68a00'}
            oninput={(event) => setBrand(event.currentTarget.value)} />
        </span>
        <Input type="text" aria-label="Brand colour hex" placeholder="#c2410c"
          autocomplete="off" spellcheck="false" value={hex} aria-invalid={invalid}
          oninput={(event) => {
            hex = event.currentTarget.value;
            if (hex.trim()) setBrand(hex);
          }} />
      </div>
    </div>
    <div class="smrt-theme-section__field smrt-theme-section__font-field" data-smrt-part="field">
      <FieldLabel for="theme-brand-font" label="Font" />
      <select id="theme-brand-font" value={cookbookStore.theme?.fontFamily ?? custom?.fontFamily ?? ''} onchange={(event) => setFont(event.currentTarget.value)}>
        <option value="">Theme default</option>
        {#each Object.keys(THEME_FONTS) as font (font)}<option value={font}>{font}</option>{/each}
      </select>
    </div>
    {#if custom}<Button variant="secondary" onclick={resetToPreset}>Reset brand colour</Button>{/if}
  </div>
  {#if invalid}<p class="smrt-theme-section__error" role="alert" data-smrt-part="error">Use a hex colour like #c2410c.</p>{/if}
  <a class="smrt-theme-section__advanced" href={advancedStylesHref} data-smrt-part="card">
    <span class="smrt-theme-section__advanced-icon" aria-hidden="true" data-smrt-part="icon">{'{}'}</span>
    <span><strong>Advanced Styles</strong><small>{cssPending ? 'This cookbook has custom CSS waiting for your approval' : 'Edit custom CSS for your app'}</small></span>
    <span class="smrt-theme-section__arrow" aria-hidden="true" data-smrt-part="icon">→</span>
  </a>
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-theme-section__root {
    display: grid;
    gap: 1.25rem;
    max-inline-size: 72rem;
  }
  .smrt-theme-section__cards {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(10rem, 100%), 1fr));
    gap: .75rem;
  }
  .smrt-theme-section__choice {
    display: grid;
    align-content: start;
    gap: .8rem;
    min-block-size: 8.5rem;
    padding: .85rem;
    cursor: pointer;
  }
  .smrt-theme-section__choice.smrt-theme-section__selected {
    padding: calc(.85rem - 1px);
  }
  .smrt-theme-section__name {
    display: inline-flex;
    align-items: center;
    gap: .55rem;
  }
  .smrt-theme-section__icon {
    display: inline-grid;
    place-items: center;
    flex: none;
    inline-size: 1.5rem;
    block-size: 1.5rem;
  }
  .smrt-theme-section__preview {
    display: flex;
    overflow: hidden;
    inline-size: 100%;
    block-size: 4.5rem;
  }
  .smrt-theme-section__preview-sidebar {
    display: grid;
    align-content: start;
    gap: .35rem;
    inline-size: 23%;
    padding: .5rem .3rem;
  }
  .smrt-theme-section__preview-sidebar span {
    block-size: .22rem;
  }
  .smrt-theme-section__preview-main {
    display: grid;
    align-content: start;
    gap: .4rem;
    flex: 1;
    padding: .6rem;
  }
  .smrt-theme-section__preview-title {
    inline-size: 55%;
    block-size: .32rem;
  }
  .smrt-theme-section__preview-body {
    display: grid;
    gap: .25rem;
    padding: .35rem;
  }
  .smrt-theme-section__preview-body span {
    block-size: .2rem;
  }
  .smrt-theme-section__preview-body span:last-child {
    inline-size: 70%;
  }
  .smrt-theme-section__scheme {
    min-block-size: 8.5rem;
  }
  .smrt-theme-section__brand, .smrt-theme-section__shape {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem;
    align-items: end;
  }
  .smrt-theme-section__shape .smrt-theme-section__field {
    min-inline-size: min(10rem, 100%);
  }
  .smrt-theme-section__field {
    display: grid;
    gap: .4rem;
  }
  .smrt-theme-section__pick {
    display: flex;
    gap: .65rem;
    align-items: center;
  }
  .smrt-theme-section__wheel {
    position: relative;
    display: inline-grid;
    place-items: center;
    flex: none;
    inline-size: 3rem;
    block-size: 3rem;
    cursor: pointer;
  }
  .smrt-theme-section__wheel::after {
    inline-size: 1.7rem;
    block-size: 1.7rem;
    pointer-events: none;
  }
  .smrt-theme-section__wheel input {
    position: absolute;
    inset: 0;
    inline-size: 100%;
    block-size: 100%;
    cursor: pointer;
    opacity: 0;
  }
  .smrt-theme-section__font-field {
    min-inline-size: min(14rem, 100%);
  }
  select {
    min-block-size: 3rem;
    padding: .6rem 2rem .6rem .8rem;
    cursor: pointer;
  }
  .smrt-theme-section__error {
    margin: 0;
  }
  .smrt-theme-section__advanced {
    display: flex;
    align-items: center;
    gap: .8rem;
    padding: 1rem;
  }
  .smrt-theme-section__advanced-icon {
    display: grid;
    place-items: center;
    inline-size: 2.8rem;
    block-size: 2.8rem;
    flex: none;
  }
  .smrt-theme-section__advanced strong, .smrt-theme-section__advanced small {
    display: block;
  }
  .smrt-theme-section__advanced small {
    margin-top: .15rem;
  }
  .smrt-theme-section__arrow {
    margin-inline-start: auto;
  }
}

@layer smrt.theme {
  .smrt-theme-section__choice {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-large, .75rem);
    background: var(--smrt-surface-panel);
    color: var(--smrt-color-on-surface);
    text-align: start;
    transition: border-color var(--smrt-duration-short3, 150ms) var(--smrt-easing-standard, ease), background var(--smrt-duration-short3, 150ms) var(--smrt-easing-standard, ease), transform var(--smrt-duration-short3, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-theme-section__choice:hover {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-surface-raised);
    transform: translateY(-2px);
  }
  .smrt-theme-section__choice.smrt-theme-section__selected {
    border: 2px solid var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-theme-section__choice:focus-visible, .smrt-theme-section__advanced:focus-visible, .smrt-theme-section__wheel:focus-within, select:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .smrt-theme-section__name {
    font-size: 1rem;
    font-weight: 700;
    line-height: 1.2;
  }
  .smrt-theme-section__icon {
    font-size: 1.35rem;
    color: var(--smrt-color-primary);
  }
  .smrt-theme-section__preview {
    border-radius: .4rem;
    border: 1px solid color-mix(in srgb, var(--smrt-planner-preview-ink) 20%, transparent);
    background: var(--smrt-planner-preview-bg);
  }
  .smrt-theme-section__preview-sidebar {
    background: var(--smrt-planner-preview-primary);
  }
  .smrt-theme-section__preview-sidebar span {
    border-radius: 1rem;
    background: var(--smrt-planner-preview-surface);
    opacity: .8;
  }
  .smrt-theme-section__preview-title {
    border-radius: 1rem;
    background: var(--smrt-planner-preview-ink);
    opacity: .7;
  }
  .smrt-theme-section__preview-body {
    border-radius: .2rem;
    background: var(--smrt-planner-preview-surface);
  }
  .smrt-theme-section__preview-body span {
    border-radius: 1rem;
    background: var(--smrt-planner-preview-primary);
    opacity: .7;
  }
  .smrt-theme-section__preview-body span:last-child {
    opacity: .35;
  }
  .smrt-theme-section__hint {
    font-size: .85rem;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-theme-section__wheel {
    border-radius: 50%;
    background: conic-gradient(red, #ff0, #0f0, #0ff, #00f, #f0f, red);
    box-shadow: 0 0 0 1px var(--smrt-hairline-color);
  }
  .smrt-theme-section__wheel::after {
    content: '';
    border: 2px solid white;
    border-radius: 50%;
    background: var(--smrt-planner-picked-color);
    box-shadow: var(--smrt-elevation-1);
  }
  select {
    border: var(--smrt-control-border);
    border-radius: var(--smrt-radius-medium, .5rem);
    background: var(--smrt-surface-control);
    color: var(--smrt-color-on-surface);
    font: inherit;
  }
  .smrt-theme-section__error {
    color: var(--smrt-color-error);
  }
  .smrt-theme-section__advanced {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-large, .75rem);
    background: var(--smrt-surface-panel);
    color: var(--smrt-color-on-surface);
    text-decoration: none;
  }
  .smrt-theme-section__advanced:hover {
    border-color: var(--smrt-color-primary);
  }
  .smrt-theme-section__advanced-icon {
    border-radius: .65rem;
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font: 700 1rem ui-monospace, monospace;
  }
  .smrt-theme-section__advanced small {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-theme-section__arrow {
    font-size: 1.3rem;
  }
  /* Forced colours: backgrounds and shadows are replaced by system colours, so
  the selected card shows a Highlight frame, and the colour swatches (the
  preset previews and the wheel) keep their real colours: they show
  colours by design. */
  @media (forced-colors: active) {
    .smrt-theme-section__choice.smrt-theme-section__selected {
      border-color: Highlight;
      outline: 0.125rem solid Highlight;
      outline-offset: 0.125rem;
    }
    .smrt-theme-section__preview, .smrt-theme-section__wheel {
      forced-color-adjust: none;
    }
  }
}

</style>
