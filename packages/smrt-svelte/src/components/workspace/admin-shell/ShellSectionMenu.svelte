<script lang="ts">
/**
 * A section's entries as a menu: one row per navigation item, in the layout's
 * order with the user's renames (hidden entries are left out). Used on a
 * section's own page when the shell shows only sections
 * (`navMode: 'sections'`). Hosts add per-row content with `meta(entry)`
 * (e.g. "8 records") and `actions(entry)` (e.g. a "New course" link).
 *
 * While the layout is being edited the rows get the same chrome as the nav
 * editor: a grip (drag, or Space plus arrows), an inline rename, and a
 * show/hide toggle, all driving the layout controller. Rows are plain text
 * then, not links.
 */
import { Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { type Component, type Snippet, tick, untrack } from 'svelte';
import { M } from '../../../i18n/strings.workspace.js';
import Sortable from '../../sortable/Sortable.svelte';
import type { SortableItem, SortableItemMove } from '../../sortable/types.js';
import { useShellLayout } from './layout-context.js';
import type { ShellLayoutController } from './layout-controller.svelte.js';
import ShellIconButton from './ShellIconButton.svelte';
import ShellSectionIcon from './ShellSectionIcon.svelte';
import { SHELL_DEFAULT_SECTION_ICON, SHELL_ICON_PATHS } from './shell-icons.js';
import type { ShellSectionMenuEntry } from './types.js';

interface Props {
  /** The section's id (`ShellNavGroup.id ?? heading`). */
  sectionId: string;
  /** The layout API; defaults to the nearest `AppShell`'s. */
  controller?: ShellLayoutController;
  /** Accessible name for the list (default "<section> entries"). */
  'aria-label'?: string;
  /** Renders host icon names, as for `TenantNav`. */
  iconComponent?: Component<{ name: string; size?: number }>;
  /** Content after the label, e.g. a record count. */
  meta?: Snippet<[ShellSectionMenuEntry]>;
  /** Trailing links or buttons, e.g. "New <noun>". Not shown while editing. */
  actions?: Snippet<[ShellSectionMenuEntry]>;
  /**
   * `list` (default): compact rows. `cards`: a responsive grid of cards, each
   * with a large icon, the label, the item's `description`, then `meta` and
   * `actions` along the bottom.
   */
  layout?: 'list' | 'cards';
  /** Called when the user follows a row link. */
  onNavigate?: () => void;
}

let {
  sectionId,
  controller: provided,
  'aria-label': ariaLabel,
  iconComponent: IconComponent,
  meta,
  actions,
  layout: layoutMode = 'list',
  onNavigate,
}: Props = $props();

const { t } = useI18n();
const layout = untrack(() => provided ?? useShellLayout());

const section = $derived(layout.sections.find((s) => s.id === sectionId));
const editing = $derived(layout.editing);
const label = $derived(section?.heading ?? sectionId);
const entries = $derived<ShellSectionMenuEntry[]>(
  (section?.items ?? [])
    .filter((entry) => editing || !entry.hidden)
    .map((entry) => ({
      id: entry.id,
      href: entry.item.href,
      label: entry.label,
      defaultLabel: entry.defaultLabel,
      icon: entry.item.icon,
      hidden: entry.hidden,
      item: entry.item,
    })),
);
const listLabel = $derived(
  ariaLabel || t(M['ui.section_menu.label'], { label }),
);
const containers = $derived([{ id: sectionId, label: listLabel }]);
const sortableItems = $derived<SortableItem[]>(
  entries.map((entry) => ({
    id: entry.id,
    containerId: sectionId,
    label: entry.label,
  })),
);
const entryById = $derived(new Map(entries.map((entry) => [entry.id, entry])));

let rootEl: HTMLElement | undefined = $state();
let renaming = $state<string | null>(null);

async function startRename(id: string): Promise<void> {
  renaming = id;
  await tick();
  const input = rootEl?.querySelector<HTMLInputElement>(
    `input[data-item-name="${CSS.escape(id)}"]`,
  );
  input?.focus();
  input?.select();
}

function commitRename(id: string, value: string): void {
  if (renaming !== id) return;
  renaming = null;
  layout.renameItem(id, value);
}

function cancelRename(id: string): void {
  renaming = null;
  rootEl
    ?.querySelector<HTMLElement>(`button[data-item-rename="${CSS.escape(id)}"]`)
    ?.focus();
}

function setShown(id: string, shown: boolean): void {
  if (shown) layout.show(id);
  else layout.hide(id);
}

function onmove(move: SortableItemMove<SortableItem>): void {
  layout.moveItem(move.item.id, sectionId, move.target.index);
}
</script>

<div
  class="smrt-section-menu"
  class:smrt-section-menu--cards={layoutMode === 'cards'}
  bind:this={rootEl}
  data-editing={editing ? '' : undefined}
>
  {#if editing}
    <Sortable
      {containers}
      items={sortableItems}
      label={listLabel}
      {onmove}
    >
      {#snippet item({ item: sortable })}
        {@const entry = entryById.get(sortable.id)}
        {#if entry}
          <span class="smrt-section-menu__row" class:smrt-section-menu__row--muted={entry.hidden}>
            {#if entry.icon}
              <ShellSectionIcon name={entry.icon} iconComponent={IconComponent} />
            {/if}
            {#if renaming === entry.id}
              <Input
                class="smrt-section-menu__name"
                interaction={false}
                data-item-name={entry.id}
                aria-label={t(M['ui.shell_layout_editor.item_name'], { label: entry.label })}
                value={entry.label}
                onblur={(event) => commitRename(entry.id, event.currentTarget.value)}
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    event.stopPropagation();
                    const value = event.currentTarget.value;
                    commitRename(entry.id, value);
                    cancelRename(entry.id);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelRename(entry.id);
                  }
                }}
              />
            {:else}
              <strong title={entry.defaultLabel !== entry.label ? entry.defaultLabel : undefined}>{entry.label}</strong>
            {/if}
            {@render meta?.(entry)}
            {#if layoutMode === 'cards' && entry.item.description}
              <span class="smrt-section-menu__desc">{entry.item.description}</span>
            {/if}
          </span>
          <ShellIconButton
            icon="edit"
            data-item-rename={entry.id}
            label={t(M['ui.shell_layout_editor.rename_item'], { label: entry.label })}
            onclick={() => startRename(entry.id)}
          />
          {#if entry.defaultLabel !== entry.label}
            <ShellIconButton
              icon="undo"
              label={t(M['ui.shell_layout_editor.reset_item'], { label: entry.label, original: entry.defaultLabel })}
              onclick={() => layout.renameItem(entry.id, null)}
            />
          {/if}
          <ShellIconButton
            icon={entry.hidden ? 'eyeOff' : 'eye'}
            pressed={!entry.hidden}
            label={t(M['ui.shell_layout_editor.show_entry'], { label: entry.label })}
            onclick={() => setShown(entry.id, entry.hidden)}
          />
        {/if}
      {/snippet}
    </Sortable>
  {:else if entries.length === 0}
    <p class="smrt-section-menu__empty">{t(M['ui.section_menu.empty'])}</p>
  {:else if layoutMode === 'cards'}
    <ul class="smrt-section-menu__cards" aria-label={listLabel}>
      {#each entries as entry (entry.id)}
        <li class="smrt-section-menu__card">
          <a class="smrt-section-menu__card-link" href={entry.href} onclick={onNavigate}>
            <span class="smrt-section-menu__card-icon">
              <ShellSectionIcon name={entry.icon ?? SHELL_DEFAULT_SECTION_ICON} size={32} iconComponent={IconComponent} />
            </span>
            <span class="smrt-section-menu__card-title">{entry.label}</span>
            {#if entry.item.description}
              <span class="smrt-section-menu__desc">{entry.item.description}</span>
            {/if}
          </a>
          {#if meta || actions}
            <div class="smrt-section-menu__card-foot">
              {#if meta}<span class="smrt-section-menu__meta">{@render meta(entry)}</span>{/if}
              {#if actions}<span class="smrt-section-menu__actions">{@render actions(entry)}</span>{/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <ul class="smrt-section-menu__list" aria-label={listLabel}>
      {#each entries as entry (entry.id)}
        <li class="smrt-section-menu__item">
          <a class="smrt-section-menu__link" href={entry.href} onclick={onNavigate}>
            {#if entry.icon}
              <ShellSectionIcon name={entry.icon} iconComponent={IconComponent} />
            {/if}
            <span class="smrt-section-menu__label">{entry.label}</span>
          </a>
          {#if meta}<span class="smrt-section-menu__meta">{@render meta(entry)}</span>{/if}
          {#if actions}<span class="smrt-section-menu__actions">{@render actions(entry)}</span>{/if}
          <svg class="smrt-section-menu__chevron" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false"><path d={SHELL_ICON_PATHS.chevronRight} /></svg>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .smrt-section-menu { min-inline-size: 0; }
  .smrt-section-menu__list { display: grid; gap: var(--smrt-spacing-1); margin: 0; padding: 0; list-style: none; }
  .smrt-section-menu__item { position: relative; display: flex; align-items: center; gap: var(--smrt-spacing-3); min-inline-size: 0; padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); }
  .smrt-section-menu__item:hover { background: var(--smrt-color-surface-container-high); }
  .smrt-section-menu__link { flex: 1 1 auto; display: flex; align-items: center; gap: var(--smrt-spacing-3); min-inline-size: 0; min-block-size: var(--smrt-control-target-min, 2rem); color: inherit; text-decoration: none; }
  /* The whole row follows the link; actions sit above the stretched target. */
  .smrt-section-menu__link::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
  .smrt-section-menu__link:focus-visible { outline: none; }
  .smrt-section-menu__link:focus-visible::after { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .smrt-section-menu__label { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--smrt-typography-weight-medium, 500); }
  .smrt-section-menu__meta { flex: 0 0 auto; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-large-size); }
  .smrt-section-menu__actions { position: relative; z-index: 1; flex: 0 0 auto; display: inline-flex; align-items: center; gap: var(--smrt-spacing-1); }
  .smrt-section-menu__chevron { flex: 0 0 auto; color: var(--smrt-color-on-surface-variant); }
  /* Fixed icon column so labels align whatever the glyph (or a missing one). */
  .smrt-section-menu :global(.smrt-shell-section-icon) { inline-size: 20px; block-size: 20px; }
  /* Cards draw a 32px icon: its box must match, or the glyph spills out of
     the centred circle. */
  .smrt-section-menu__card-icon :global(.smrt-shell-section-icon) { inline-size: 32px; block-size: 32px; }
  /* Cards: a responsive grid; the whole card is one stretched link. */
  .smrt-section-menu__cards, .smrt-section-menu--cards :global(.smrt-sortable__items) { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(16rem, 100%), 1fr)); gap: var(--smrt-spacing-3); margin: 0; padding: 0; list-style: none; }
  .smrt-section-menu__card { position: relative; display: flex; flex-direction: column; gap: var(--smrt-spacing-3); min-inline-size: 0; padding: var(--smrt-spacing-4); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-large, var(--smrt-radius-medium)); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); transition: background-color 120ms, border-color 120ms, transform 120ms; }
  .smrt-section-menu__card:hover { background: var(--smrt-color-surface-container-high); border-color: var(--smrt-color-outline); transform: translateY(-2px); }
  .smrt-section-menu__card-link { flex: 1 1 auto; display: flex; flex-direction: column; gap: var(--smrt-spacing-2); color: inherit; text-decoration: none; }
  .smrt-section-menu__card-link::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
  .smrt-section-menu__card-link:focus-visible { outline: none; }
  .smrt-section-menu__card-link:focus-visible::after { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .smrt-section-menu__card-icon { display: inline-grid; place-items: center; inline-size: 56px; block-size: 56px; border-radius: var(--smrt-radius-full, 9999px); background: var(--smrt-color-primary-container); color: var(--smrt-color-on-primary-container); }
  .smrt-section-menu__card-title { font-size: var(--smrt-typography-title-medium-size, 1rem); font-weight: var(--smrt-typography-weight-medium, 500); overflow-wrap: anywhere; }
  .smrt-section-menu__desc { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-body-medium-size, 0.875rem); }
  .smrt-section-menu__card-foot { position: relative; z-index: 1; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-2); }
  .smrt-section-menu--cards :global(.smrt-sortable__item) { align-items: flex-start; }
  .smrt-section-menu--cards .smrt-section-menu__row { flex-wrap: wrap; }
  .smrt-section-menu--cards .smrt-section-menu__row .smrt-section-menu__desc { flex: 1 1 100%; }
  .smrt-section-menu__empty { margin: 0; color: var(--smrt-color-on-surface-variant); }

  /* Edit mode: the generic Sortable reads as the same rows. */
  .smrt-section-menu :global(.smrt-sortable__container) { padding: 0; border: 0; background: transparent; gap: var(--smrt-spacing-1); }
  .smrt-section-menu :global(.smrt-sortable__header) { display: none; }
  .smrt-section-menu :global(.smrt-sortable__items) { gap: var(--smrt-spacing-1); }
  .smrt-section-menu :global(.smrt-sortable__item) { border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface); }
  .smrt-section-menu :global(.smrt-sortable__handle) { inline-size: 1.5rem; block-size: 2rem; }
  .smrt-section-menu__row { flex: 1 1 auto; min-inline-size: 0; display: flex; align-items: center; gap: var(--smrt-spacing-3); padding: var(--smrt-spacing-2) var(--smrt-spacing-1); }
  .smrt-section-menu__row--muted { opacity: 0.55; }
  .smrt-section-menu__row strong { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--smrt-typography-weight-medium, 500); }
  :global(.smrt-section-menu__name) { flex: 1 1 auto; min-inline-size: 0; }
</style>
