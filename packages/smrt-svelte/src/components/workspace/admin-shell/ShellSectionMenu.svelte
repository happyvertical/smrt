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
import { SHELL_ICON_PATHS } from './shell-icons.js';
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

<div class="smrt-section-menu" bind:this={rootEl} data-editing={editing ? '' : undefined}>
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
