<script lang="ts">
/**
 * CommandPaletteDialog - the palette itself: a modal with a search box and a
 * grouped result list, driven by a {@link CommandPaletteController}.
 *
 * It follows the WAI-ARIA combobox pattern: focus stays in the search box,
 * the highlighted row is `aria-activedescendant`, Up/Down move it, Enter
 * chooses it and Escape closes. It also installs the global shortcut
 * (`Mod+K` by default) that toggles the palette. The shortcut works in any
 * field because it carries a modifier; a bare key such as `/` is ignored
 * while the user is typing.
 *
 * The palette comes from the `palette` prop or the nearest
 * `setCommandPalette()` context.
 */
import { Modal } from '@happyvertical/smrt-ui/feedback';
import { Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { onMount, tick } from 'svelte';
import { M } from '../../i18n/strings.palette.js';
import {
  isShellIconName,
  SHELL_ICON_PATHS,
} from '../workspace/admin-shell/shell-icons.js';
import { palettePicker } from './context.js';
import type { CommandPaletteController } from './controller.svelte.js';
import {
  DEFAULT_PALETTE_HOTKEYS,
  formatPaletteHotkey,
  isApplePlatform,
  isPaletteHotkeyEvent,
  type PaletteHotkey,
  parsePaletteHotkey,
} from './hotkeys.js';
import { highlightSegments } from './match.js';
import type { PaletteResult } from './types.js';

interface Props {
  /** The palette to drive; default: the one on context. */
  palette?: CommandPaletteController;
  /**
   * Shortcuts that toggle the palette, e.g. `['Mod+K', '/']`. `false` installs
   * none (open it from your own control).
   */
  hotkeys?: readonly string[] | false;
  /** Accessible name of the dialog. */
  label?: string;
  /** Search box placeholder. */
  placeholder?: string;
}

let {
  palette: paletteProp,
  hotkeys = DEFAULT_PALETTE_HOTKEYS,
  label,
  placeholder,
}: Props = $props();

const { t } = useI18n();
const pick = palettePicker(() => paletteProp);
const palette = $derived(pick());
const uid = $props.id();
const listId = `smrt-palette-list-${uid}`;
const optionId = (result: PaletteResult) =>
  `smrt-palette-opt-${uid}-${result.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

const parsed: PaletteHotkey[] = $derived(
  hotkeys === false
    ? []
    : hotkeys.flatMap((spec) => {
        const hotkey = parsePaletteHotkey(spec);
        return hotkey ? [hotkey] : [];
      }),
);

let apple = $state(false);
onMount(() => {
  apple = isApplePlatform();
});

let input: { focus(): void } | undefined = $state();

function onWindowKeydown(event: KeyboardEvent) {
  if (!isPaletteHotkeyEvent(event, parsed)) return;
  event.preventDefault();
  palette.toggle();
}

$effect(() => {
  if (!palette.isOpen) return;
  void tick().then(() => input?.focus());
});

const active = $derived(palette.active);
const hasRows = $derived(palette.results.length > 0);

// Keep the highlighted row visible as the arrow keys move it.
$effect(() => {
  if (!active || typeof document === 'undefined') return;
  const row = document.getElementById(optionId(active));
  if (row && typeof row.scrollIntoView === 'function') {
    row.scrollIntoView({ block: 'nearest' });
  }
});

function onInputKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      palette.moveActive(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      palette.moveActive(-1);
      break;
    case 'Enter':
      event.preventDefault();
      void palette.activate();
      break;
    case 'PageDown':
      event.preventDefault();
      palette.moveActive(5);
      break;
    case 'PageUp':
      event.preventDefault();
      palette.moveActive(-5);
      break;
  }
}

const statusText = $derived.by(() => {
  if (!palette.isOpen) return '';
  const query = palette.query.trim();
  if (palette.busy && !hasRows) return t(M['ui.command_palette.searching']);
  if (!hasRows) {
    return query
      ? t(M['ui.command_palette.empty'], { query })
      : t(M['ui.command_palette.nothing']);
  }
  const count = palette.results.length;
  const base =
    count === 1
      ? t(M['ui.command_palette.status_one'])
      : t(M['ui.command_palette.status_many'], { count });
  return palette.failedProviders.size > 0
    ? `${base} ${t(M['ui.command_palette.partial'])}`
    : base;
});

function iconPath(icon: string | undefined): string | null {
  return icon && isShellIconName(icon) ? SHELL_ICON_PATHS[icon] : null;
}

const inputLabel = $derived(label ?? t(M['ui.command_palette.input_label']));
</script>

<svelte:window onkeydown={onWindowKeydown} />

<Modal
  bind:open={() => palette.isOpen, (next) => { if (!next) palette.close(); }}
  ariaLabel={label ?? t(M['ui.command_palette.title'])}
  showClose={false}
  size="md"
>
  <div class="smrt-command-palette">
    <div class="smrt-command-palette__field">
      <svg class="smrt-command-palette__search-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      <Input
        bind:this={input}
        type="text"
        role="combobox"
        aria-label={inputLabel}
        aria-expanded={hasRows}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionId(active) : undefined}
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        enterkeyhint="go"
        placeholder={placeholder ?? t(M['ui.command_palette.placeholder'])}
        interaction={false}
        class="smrt-command-palette__input"
        bind:value={() => palette.query, (next) => palette.setQuery(String(next))}
        onkeydown={onInputKeydown}
      />
    </div>

    <div
      class="smrt-command-palette__list"
      id={listId}
      role="listbox"
      aria-label={t(M['ui.command_palette.results'])}
      aria-busy={palette.busy}
    >
      {#each palette.sections as section, sectionIndex (section.id)}
        <div class="smrt-command-palette__group" role="group" aria-labelledby={`${listId}-g${sectionIndex}`}>
          <div class="smrt-command-palette__heading" id={`${listId}-g${sectionIndex}`}>{section.label}</div>
          {#each section.results as result (result.key)}
            {@const path = iconPath(result.item.icon)}
            {@const shortcut = result.item.shortcut ? formatPaletteHotkey(result.item.shortcut, apple) : ''}
            <!-- The combobox input owns the keyboard (aria-activedescendant); rows are pointer targets. -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div
              class="smrt-command-palette__option"
              id={optionId(result)}
              role="option"
              tabindex="-1"
              aria-selected={active?.key === result.key}
              aria-disabled={result.selectable ? undefined : true}
              data-kind={result.item.kind}
              data-active={active?.key === result.key ? '' : undefined}
              title={typeof result.item.disabled === 'string' ? result.item.disabled : undefined}
              onmousedown={(event) => event.preventDefault()}
              onpointermove={() => palette.setActive(result.key)}
              onclick={() => void palette.activate(result)}
            >
              <span class="smrt-command-palette__icon" aria-hidden="true">
                {#if path}
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" focusable="false"><path d={path} /></svg>
                {/if}
              </span>
              <span class="smrt-command-palette__text">
                <span class="smrt-command-palette__title">
                  {#each highlightSegments(result.item.title, result.titleRanges) as segment}
                    {#if segment.match}<mark>{segment.text}</mark>{:else}{segment.text}{/if}
                  {/each}
                </span>
                {#if result.item.subtitle}
                  <span class="smrt-command-palette__subtitle">{result.item.subtitle}</span>
                {/if}
              </span>
              {#if typeof result.item.disabled === 'string'}
                <span class="smrt-command-palette__note">{t(M['ui.command_palette.unavailable'])}</span>
              {:else if shortcut}
                <kbd class="smrt-command-palette__shortcut">{shortcut}</kbd>
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>
    {#if !hasRows}
      <p class="smrt-command-palette__empty">{statusText}</p>
    {/if}

    <div class="smrt-command-palette__hints" aria-hidden="true">
      <span><kbd>↑</kbd><kbd>↓</kbd> {t(M['ui.command_palette.hint_move'])}</span>
      <span><kbd>↵</kbd> {t(M['ui.command_palette.hint_select'])}</span>
      <span><kbd>Esc</kbd> {t(M['ui.command_palette.hint_close'])}</span>
    </div>

    <div class="smrt-command-palette__live" role="status" aria-live="polite">{statusText}</div>
  </div>
</Modal>

<style>
  .smrt-command-palette {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
    min-block-size: 0;
  }

  .smrt-command-palette__field {
    position: relative;
    display: flex;
    align-items: center;
  }

  .smrt-command-palette__search-icon {
    position: absolute;
    inset-inline-start: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    pointer-events: none;
  }

  .smrt-command-palette__field :global(.smrt-command-palette__input) {
    padding-inline-start: 2.5rem;
    /* 16px keeps iOS from zooming when the box takes focus. */
    font-size: max(1rem, var(--smrt-typography-body-medium-size, 0.875rem));
  }

  .smrt-command-palette__list {
    max-block-size: min(24rem, 55vh);
    overflow-y: auto;
    overscroll-behavior: contain;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .smrt-command-palette__heading {
    padding: 0.25rem 0.75rem;
    font-size: var(--smrt-typography-label-small-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-command-palette__option {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-block-size: max(2.5rem, var(--smrt-control-target-min, 0px));
    padding: 0.375rem 0.75rem;
    border-radius: var(--smrt-radius-medium, 0.5rem);
    color: var(--smrt-color-on-surface);
    cursor: pointer;
  }

  .smrt-command-palette__option[data-active] {
    background: var(--smrt-color-surface-container-high);
    box-shadow: inset 3px 0 0 var(--smrt-color-primary);
  }

  .smrt-command-palette__option[aria-disabled='true'] {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .smrt-command-palette__icon {
    flex: 0 0 1.125rem;
    inline-size: 1.125rem;
    color: var(--smrt-color-on-surface-variant);
    display: inline-grid;
    place-items: center;
  }

  .smrt-command-palette__text {
    flex: 1 1 auto;
    min-inline-size: 0;
    display: flex;
    flex-direction: column;
  }

  .smrt-command-palette__title,
  .smrt-command-palette__subtitle {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .smrt-command-palette__subtitle {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-command-palette mark {
    background: color-mix(in srgb, var(--smrt-color-primary) 18%, transparent);
    color: inherit;
    font-weight: var(--smrt-typography-weight-bold, 700);
    border-radius: 0.125rem;
  }

  .smrt-command-palette__note {
    font-size: var(--smrt-typography-label-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-command-palette kbd {
    font: inherit;
    font-size: var(--smrt-typography-label-small-size, 0.75rem);
    padding: 0.0625rem 0.375rem;
    border: 1px solid var(--smrt-color-outline-variant, var(--smrt-color-outline));
    border-radius: var(--smrt-radius-small, 0.375rem);
    color: var(--smrt-color-on-surface-variant);
    background: var(--smrt-color-surface-container);
  }

  .smrt-command-palette__empty {
    margin: 0;
    padding: 1.5rem 0.75rem;
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-command-palette__hints {
    display: flex;
    gap: 1rem;
    padding: 0.25rem 0.75rem 0;
    font-size: var(--smrt-typography-label-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .smrt-command-palette__hints kbd + kbd {
    margin-inline-start: 0.125rem;
  }

  @media (max-width: 48rem) {
    .smrt-command-palette__hints {
      display: none;
    }
  }

  .smrt-command-palette__live {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
