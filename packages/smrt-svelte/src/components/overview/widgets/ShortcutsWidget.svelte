<script lang="ts">
/**
 * Shortcuts widget (#3727): the section-overview cards as a widget. It draws
 * the cards a loader produced (see `shortcutsFromNav`), with the same look as
 * `ShellSectionMenu layout="cards"`, so a section's default overview is just
 * this widget.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../../i18n/strings.overview.js';
import ShellSectionIcon from '../../workspace/admin-shell/ShellSectionIcon.svelte';
import { SHELL_DEFAULT_SECTION_ICON } from '../../workspace/admin-shell/shell-icons.js';
import { safeHref } from '../markdown.js';
import type { WidgetComponentProps } from '../types.js';
import { isRecord, type ShortcutsWidgetData } from './data.js';

let { data, iconComponent }: WidgetComponentProps<ShortcutsWidgetData> =
  $props();

const { t } = useI18n();
const MAX_ITEMS = 48;

interface Card {
  id: string;
  label: string;
  href: string;
  icon: string;
  description?: string;
}

const cards = $derived.by((): Card[] => {
  if (!isRecord(data) || !Array.isArray(data.items)) return [];
  const out: Card[] = [];
  for (const item of data.items.slice(0, MAX_ITEMS)) {
    if (!isRecord(item) || typeof item.label !== 'string') continue;
    const href = typeof item.href === 'string' ? safeHref(item.href) : null;
    if (!href) continue;
    out.push({
      id: typeof item.id === 'string' ? item.id : href,
      label: item.label,
      href,
      icon:
        typeof item.icon === 'string' ? item.icon : SHELL_DEFAULT_SECTION_ICON,
      description:
        typeof item.description === 'string' ? item.description : undefined,
    });
  }
  return out;
});
</script>

{#if cards.length === 0}
  <p class="smrt-shortcuts__empty">{t(M['ui.overview.shortcuts.empty'])}</p>
{:else}
  <ul class="smrt-shortcuts">
    {#each cards as card (card.id)}
      <li class="smrt-shortcuts__card">
        <a class="smrt-shortcuts__link" href={card.href}>
          <span class="smrt-shortcuts__icon">
            <ShellSectionIcon name={card.icon} size={28} {iconComponent} />
          </span>
          <span class="smrt-shortcuts__title">{card.label}</span>
          {#if card.description}<span class="smrt-shortcuts__desc">{card.description}</span>{/if}
        </a>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .smrt-shortcuts { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(12rem, 100%), 1fr)); gap: var(--smrt-spacing-3); margin: 0; padding: 0; list-style: none; }
  .smrt-shortcuts__card { position: relative; display: flex; min-inline-size: 0; border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-large, var(--smrt-radius-medium)); background: var(--smrt-color-surface); transition: background-color 120ms, border-color 120ms; }
  .smrt-shortcuts__card:hover { background: var(--smrt-color-surface-container-high); border-color: var(--smrt-color-outline); }
  .smrt-shortcuts__link { flex: 1 1 auto; display: flex; flex-direction: column; gap: var(--smrt-spacing-2); padding: var(--smrt-spacing-3); color: var(--smrt-color-on-surface); text-decoration: none; }
  .smrt-shortcuts__link:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; border-radius: inherit; }
  .smrt-shortcuts__icon { display: inline-grid; place-items: center; inline-size: 3rem; block-size: 3rem; border-radius: var(--smrt-radius-full, 9999px); background: var(--smrt-color-primary-container); color: var(--smrt-color-on-primary-container); }
  .smrt-shortcuts__icon :global(.smrt-shell-section-icon) { inline-size: 28px; block-size: 28px; }
  .smrt-shortcuts__title { font-weight: var(--smrt-typography-weight-medium, 500); overflow-wrap: anywhere; }
  .smrt-shortcuts__desc { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-medium-size, 0.875rem); }
  .smrt-shortcuts__empty { margin: 0; color: var(--smrt-color-on-surface-variant); }
</style>
