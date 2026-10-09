<script lang="ts">
/**
 * The navigation as it looks on the site, made editable in place: every
 * section heading and item has a grip (drag, or Space plus arrow keys), section
 * headings carry overlay icon buttons (show, title, host actions) and open a
 * floating toolbar (rename, title, hide, delete, host actions), and a "New
 * section" button ends the list. Rendered by `AppShell` in place of
 * `TenantNav` while the layout is being edited.
 */
import { Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { type Component, type Snippet, tick, untrack } from 'svelte';
import { M } from '../../../i18n/strings.workspace.js';
import Sortable from '../../sortable/Sortable.svelte';
import type {
  SortableContainer,
  SortableContainerMove,
  SortableItem,
  SortableItemMove,
} from '../../sortable/types.js';
import { useShellLayout } from './layout-context.js';
import type { ShellLayoutController } from './layout-controller.svelte.js';
import ShellIconButton from './ShellIconButton.svelte';
import ShellSectionIcon from './ShellSectionIcon.svelte';
import {
  SHELL_DEFAULT_SECTION_ICON,
  SHELL_SECTION_ICONS,
} from './shell-icons.js';
import type { ShellSectionActionsContext } from './types.js';

interface Props {
  /** The layout API to edit; defaults to the nearest `AppShell`'s. */
  controller?: ShellLayoutController;
  /** Accessible name for the navigation landmark. */
  'aria-label'?: string;
  /** Component used to render icon names, as for `TenantNav`. */
  iconComponent?: Component<{ name: string; size?: number }>;
  /** Host icon buttons for each section (overlay and floating toolbar). */
  sectionActions?: Snippet<[ShellSectionActionsContext]>;
  /**
   * `'sections'` edits only the sections (grip, rename, show, delete, icon
   * picker); their entries are edited on the section's own page with
   * `ShellSectionMenu`. Default `'items'`.
   */
  navMode?: 'items' | 'sections';
}

let {
  controller: provided,
  'aria-label': ariaLabel,
  iconComponent: IconComponent,
  sectionActions,
  navMode = 'items',
}: Props = $props();

const { t } = useI18n();
const layout = untrack(() => provided ?? useShellLayout());

interface NavContainer extends SortableContainer {
  hidden: boolean;
  root: boolean;
  custom: boolean;
  titleVisible: boolean;
  count: number;
  icon: string;
}

const sections = $derived(layout.sections);
const containers = $derived<NavContainer[]>(
  sections.map((section) => ({
    id: section.id,
    label: section.heading ?? t(M['ui.shell_layout_editor.top_level']),
    fixed: section.group === null,
    root: section.group === null,
    hidden: section.hidden,
    custom: section.custom,
    titleVisible: section.titleVisible,
    count: section.items.length,
    icon: section.icon ?? SHELL_DEFAULT_SECTION_ICON,
  })),
);
const items = $derived<SortableItem[]>(
  (navMode === 'sections' ? [] : sections).flatMap((section) =>
    section.items.map((entry) => ({
      id: entry.id,
      containerId: section.id,
      label: entry.label,
    })),
  ),
);
const itemDefaults = $derived(
  new Map(
    sections.flatMap((section) =>
      section.items.map((entry) => [entry.id, entry.defaultLabel] as const),
    ),
  ),
);
const itemIcons = $derived(
  new Map(
    sections.flatMap((section) =>
      section.items.map((entry) => [entry.id, entry.item.icon] as const),
    ),
  ),
);

let rootEl: HTMLElement | undefined = $state();

// One floating toolbar at a time. `pinned` (opened by click/tap) stays until
// dismissed; an unpinned one (opened by hovering with a fine pointer) closes
// when the pointer leaves the section.
let open = $state<{ id: string; pinned: boolean } | null>(null);

function canHover(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(hover: hover) and (pointer: fine)').matches === true
  );
}

function sectionEl(id: string): HTMLElement | null {
  return (
    rootEl?.querySelector<HTMLElement>(
      `[data-nav-section="${CSS.escape(id)}"]`,
    ) ?? null
  );
}

function onhover(id: string, event: PointerEvent): void {
  if (event.pointerType === 'touch' || !canHover()) return;
  if (open?.pinned) return;
  open = { id, pinned: false };
}

async function onactivate(id: string): Promise<void> {
  if (open?.id === id && open.pinned) {
    open = null;
    return;
  }
  open = { id, pinned: true };
  await tick();
  const input = sectionEl(id)?.querySelector<HTMLInputElement>(
    'input[data-section-name]',
  );
  input?.focus();
  input?.select();
}

function onleave(id: string): void {
  if (open?.id === id && !open.pinned) open = null;
}

function onkeydown(id: string, event: KeyboardEvent): void {
  if (event.key !== 'Escape' || open?.id !== id) return;
  event.preventDefault();
  event.stopPropagation();
  // An open icon picker closes first; the toolbar stays.
  if (iconPicker === id) {
    iconPicker = null;
    pickerButton(id)?.focus();
    return;
  }
  open = null;
  sectionEl(id)
    ?.querySelector<HTMLElement>('button[data-section-title]')
    ?.focus();
}

function onfocusout(id: string, event: FocusEvent): void {
  if (open?.id !== id || !open.pinned) return;
  const next = event.relatedTarget;
  if (next instanceof Node && !sectionEl(id)?.contains(next)) open = null;
}

$effect(() => {
  const current = open;
  if (!current?.pinned || typeof document === 'undefined') return;
  const dismiss = (event: PointerEvent) => {
    if (
      event.target instanceof Node &&
      !sectionEl(current.id)?.contains(event.target)
    ) {
      open = null;
    }
  };
  document.addEventListener('pointerdown', dismiss, true);
  return () => document.removeEventListener('pointerdown', dismiss, true);
});

// The section whose icon picker is open (inside its toolbar).
let iconPicker = $state<string | null>(null);

function pickerButton(id: string): HTMLElement | null {
  return (
    sectionEl(id)?.querySelector<HTMLElement>('button[data-section-icon]') ??
    null
  );
}

function chooseIcon(id: string, icon: string): void {
  layout.setSectionIcon(id, icon);
  iconPicker = null;
  pickerButton(id)?.focus();
}

// The picker lives in the toolbar: it closes with it.
$effect(() => {
  if (iconPicker !== null && open?.id !== iconPicker) iconPicker = null;
});

function humanizeIcon(name: string): string {
  return name.replace(/([A-Z])/g, ' $1').toLowerCase();
}

// The item whose name is being edited in place (one at a time).
let renamingItem = $state<string | null>(null);

async function startRenameItem(id: string): Promise<void> {
  renamingItem = id;
  await tick();
  const input = rootEl?.querySelector<HTMLInputElement>(
    `input[data-item-name="${CSS.escape(id)}"]`,
  );
  input?.focus();
  input?.select();
}

function commitRenameItem(id: string, value: string): void {
  // Blur after Escape or a save lands here too; only the open editor commits.
  if (renamingItem !== id) return;
  renamingItem = null;
  layout.renameItem(id, value);
}

function cancelRenameItem(id: string): void {
  renamingItem = null;
  rootEl
    ?.querySelector<HTMLElement>(`button[data-item-rename="${CSS.escape(id)}"]`)
    ?.focus();
}

function setShown(id: string, shown: boolean): void {
  if (shown) layout.show(id);
  else layout.hide(id);
}

function rename(id: string, input: HTMLInputElement): void {
  layout.renameSection(id, input.value);
  // Blank or rejected input snaps back to the section's real name.
  input.value = containers.find((entry) => entry.id === id)?.label ?? '';
}

async function createSection(): Promise<void> {
  const id = layout.createSection(
    t(M['ui.shell_layout_editor.new_section_label']),
  );
  if (!id) return;
  await tick();
  await onactivate(id);
}

function deleteSection(id: string, label: string, count: number): void {
  if (
    count > 0 &&
    !globalThis.confirm?.(
      t(M['ui.shell_layout_editor.delete_confirm'], { label }),
    )
  ) {
    return;
  }
  open = null;
  layout.deleteSection(id);
}

function onmove(move: SortableItemMove<SortableItem, NavContainer>): void {
  layout.moveItem(move.item.id, move.target.containerId, move.target.index);
}

function oncontainermove(move: SortableContainerMove<NavContainer>): void {
  layout.moveSection(move.container.id, move.target);
}
</script>

{#snippet toggles(entry: NavContainer)}
  <ShellIconButton
    icon={entry.hidden ? 'eyeOff' : 'eye'}
    pressed={!entry.hidden}
    label={t(M['ui.shell_layout_editor.show_entry'], { label: entry.label })}
    onclick={() => setShown(entry.id, entry.hidden)}
  />
  {#if navMode !== 'sections'}
    <ShellIconButton
      icon={entry.titleVisible ? 'heading' : 'headingOff'}
      pressed={entry.titleVisible}
      label={t(M['ui.shell_layout_editor.show_title_for'], { label: entry.label })}
      onclick={() => layout.setSectionTitleVisible(entry.id, !entry.titleVisible)}
    />
  {/if}
{/snippet}

{#snippet actions(entry: NavContainer)}
  {@render sectionActions?.({
    sectionId: entry.id,
    label: entry.label,
    custom: entry.custom,
    editing: true,
  })}
{/snippet}

<nav
  class="smrt-nav-editor"
  data-layout-editing=""
  data-nav-mode={navMode}
  aria-label={ariaLabel || t(M['ui.shell_layout_editor.sortable_label'])}
  bind:this={rootEl}
>
  <Sortable
    {containers}
    {items}
    label={t(M['ui.shell_layout_editor.sortable_label'])}
    reorderContainers={true}
    {onmove}
    {oncontainermove}
  >
    {#snippet containerHeader({ container })}
      {@const entry = containers.find((candidate) => candidate.id === container.id)}
      {#if !entry}
        <strong>{container.label}</strong>
      {:else if entry.root}
        <span class="smrt-nav-editor__top">{container.label}</span>
      {:else}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="smrt-nav-editor__head"
          data-nav-section={entry.id}
          data-toolbar-open={open?.id === entry.id ? '' : undefined}
          onpointerleave={() => onleave(entry.id)}
          onkeydown={(event) => onkeydown(entry.id, event)}
          onfocusout={(event) => onfocusout(entry.id, event)}
        >
          <!-- raw-primitive-allow: heading button that opens the section toolbar -->
          <button
            type="button"
            class="smrt-nav-editor__title"
            class:smrt-nav-editor__title--off={!entry.titleVisible}
            class:smrt-nav-editor__title--hidden={entry.hidden}
            data-section-title=""
            aria-haspopup="true"
            aria-expanded={open?.id === entry.id}
            aria-label={t(M['ui.layout_edit.edit_section'], { label: entry.label })}
            onpointerenter={(event) => onhover(entry.id, event)}
            onclick={() => onactivate(entry.id)}
          >{#if navMode === 'sections'}<span class="smrt-nav-editor__section-icon"><ShellSectionIcon name={entry.icon} iconComponent={IconComponent} /></span>{/if}{entry.label}</button>
          <span class="smrt-nav-editor__overlay">
            {@render toggles(entry)}
            {@render actions(entry)}
          </span>
          {#if open?.id === entry.id}
            <div
              class="smrt-nav-editor__toolbar"
              role="group"
              aria-label={t(M['ui.layout_edit.section_options'], { label: entry.label })}
              data-testid="section-toolbar"
            >
              <Input
                class="smrt-nav-editor__name"
                interaction={false}
                data-section-name={entry.id}
                aria-label={t(M['ui.shell_layout_editor.section_name'], { label: entry.label })}
                value={entry.label}
                onchange={(event) => rename(entry.id, event.currentTarget)}
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    rename(entry.id, event.currentTarget);
                  }
                }}
              />
              {@render toggles(entry)}
              {#if navMode === 'sections'}
                <ShellIconButton
                  data-section-icon={entry.id}
                  aria-haspopup="true"
                  aria-expanded={iconPicker === entry.id}
                  label={t(M['ui.shell_layout_editor.section_icon'], { label: entry.label })}
                  onclick={() => (iconPicker = iconPicker === entry.id ? null : entry.id)}
                >
                  <ShellSectionIcon name={entry.icon} iconComponent={IconComponent} />
                </ShellIconButton>
              {/if}
              {#if entry.custom}
                <ShellIconButton
                  icon="trash"
                  label={t(M['ui.shell_layout_editor.delete_section'], { label: entry.label })}
                  onclick={() => deleteSection(entry.id, entry.label, entry.count)}
                />
              {/if}
              {@render actions(entry)}
              {#if navMode === 'sections' && iconPicker === entry.id}
                <div
                  class="smrt-nav-editor__icons"
                  role="group"
                  aria-label={t(M['ui.shell_layout_editor.section_icon'], { label: entry.label })}
                >
                  {#each SHELL_SECTION_ICONS as name (name)}
                    <ShellIconButton
                      data-icon-option={name}
                      pressed={entry.icon === name}
                      label={t(M['ui.shell_layout_editor.icon_option'], { icon: humanizeIcon(name) })}
                      onclick={() => chooseIcon(entry.id, name)}
                    >
                      <ShellSectionIcon {name} />
                    </ShellIconButton>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {/if}
    {/snippet}
    {#snippet item({ item: entry, container })}
      {@const hidden = layout.isHidden(entry.id)}
      {@const icon = itemIcons.get(entry.id)}
      {@const original = itemDefaults.get(entry.id)}
      <span
        class="smrt-nav-editor__row"
        class:smrt-nav-editor__row--muted={hidden || layout.isHidden(container.id)}
      >
        {#if icon}
          <span class="smrt-nav-editor__icon" aria-hidden="true">
            {#if IconComponent}
              <IconComponent name={icon} size={18} />
            {:else}
              {icon}
            {/if}
          </span>
        {/if}
        {#if renamingItem === entry.id}
          <Input
            class="smrt-nav-editor__item-name"
            interaction={false}
            data-item-name={entry.id}
            aria-label={t(M['ui.shell_layout_editor.item_name'], { label: entry.label })}
            value={entry.label}
            onblur={(event) => commitRenameItem(entry.id, event.currentTarget.value)}
            onkeydown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                event.stopPropagation();
                const value = event.currentTarget.value;
                commitRenameItem(entry.id, value);
                cancelRenameItem(entry.id);
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                cancelRenameItem(entry.id);
              }
            }}
          />
        {:else}
          <strong title={original !== entry.label ? original : undefined}>{entry.label}</strong>
        {/if}
      </span>
      <ShellIconButton
        icon="edit"
        data-item-rename={entry.id}
        label={t(M['ui.shell_layout_editor.rename_item'], { label: entry.label })}
        onclick={() => startRenameItem(entry.id)}
      />
      {#if original !== undefined && original !== entry.label}
        <ShellIconButton
          icon="undo"
          label={t(M['ui.shell_layout_editor.reset_item'], { label: entry.label, original })}
          onclick={() => layout.renameItem(entry.id, null)}
        />
      {/if}
      <ShellIconButton
        icon={hidden ? 'eyeOff' : 'eye'}
        pressed={!hidden}
        label={t(M['ui.shell_layout_editor.show_entry'], { label: entry.label })}
        onclick={() => setShown(entry.id, hidden)}
      />
    {/snippet}
  </Sortable>
  <Button variant="secondary" size="sm" class="smrt-nav-editor__new" onclick={createSection}>
    {t(M['ui.shell_layout_editor.new_section'])}
  </Button>
</nav>

<style>
  .smrt-nav-editor { display: grid; gap: var(--smrt-spacing-2); min-inline-size: 0; }
  /* Make the generic Sortable read as the real navigation. */
  .smrt-nav-editor :global(.smrt-sortable) { gap: var(--smrt-spacing-1); }
  .smrt-nav-editor :global(.smrt-sortable__containers) { gap: var(--smrt-spacing-1); }
  .smrt-nav-editor :global(.smrt-sortable__container) { padding: 0; border: 0; background: transparent; gap: var(--smrt-spacing-1); }
  .smrt-nav-editor :global(.smrt-sortable__item) { padding: 0; border: 0; border-radius: var(--smrt-radius-medium); background: transparent; }
  .smrt-nav-editor :global(.smrt-sortable__item:hover) { background: var(--smrt-color-surface-container-high); }
  .smrt-nav-editor :global(.smrt-sortable__items) { padding-inline-start: var(--smrt-spacing-3); min-block-size: 0; }
  .smrt-nav-editor :global(.smrt-sortable__header) { min-block-size: 0; }
  .smrt-nav-editor :global(.smrt-sortable__empty) { padding-block: 0; }
  .smrt-nav-editor :global(.smrt-sortable__handle) { inline-size: 1.5rem; block-size: 2rem; }

  .smrt-nav-editor__top { color: var(--smrt-color-on-surface-variant); font: var(--smrt-typography-label-small-font); text-transform: uppercase; letter-spacing: 0.04em; }
  .smrt-nav-editor__head { position: relative; flex: 1 1 auto; display: flex; align-items: center; gap: var(--smrt-spacing-1); min-inline-size: 0; }
  .smrt-nav-editor__title { flex: 1 1 auto; min-inline-size: 0; padding: var(--smrt-spacing-2) var(--smrt-spacing-3); border: 0; border-radius: var(--smrt-radius-medium); background: transparent; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-large-size); font-weight: var(--smrt-typography-weight-semibold); text-align: start; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .smrt-nav-editor__title:hover, .smrt-nav-editor__head[data-toolbar-open] .smrt-nav-editor__title { background: var(--smrt-color-surface-container-high); }
  .smrt-nav-editor__title:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .smrt-nav-editor__title--off { font-style: italic; font-weight: var(--smrt-typography-weight-normal, normal); }
  .smrt-nav-editor__title--hidden { opacity: 0.55; }
  .smrt-nav-editor__overlay { display: inline-flex; align-items: center; flex: 0 0 auto; }
  .smrt-nav-editor__toolbar { position: absolute; inset-block-start: 100%; inset-inline: 0; z-index: 40; display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-1); padding: var(--smrt-spacing-2); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-medium); background: var(--smrt-color-surface-container-high); box-shadow: var(--smrt-elevation-2, 0 4px 12px rgb(0 0 0 / 0.2)); }
  :global(.smrt-nav-editor__name) { flex: 1 1 100%; min-inline-size: 0; }
  .smrt-nav-editor__row { flex: 1 1 auto; min-inline-size: 0; display: flex; align-items: center; gap: var(--smrt-spacing-2); padding: var(--smrt-spacing-2) var(--smrt-spacing-1); color: var(--smrt-color-on-surface); }
  .smrt-nav-editor__row--muted { opacity: 0.55; }
  .smrt-nav-editor__row strong { min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--smrt-typography-weight-medium, 500); }
  /* Keep editor rows inside the sidebar: the implicit grid column would size to
     the rows' min-content and push the trailing icons past the clipped rail. */
  .smrt-nav-editor :global(.smrt-sortable) { grid-template-columns: minmax(0, 1fr); }
  .smrt-nav-editor :global(.smrt-sortable__container),
  .smrt-nav-editor :global(.smrt-sortable__items),
  .smrt-nav-editor :global(.smrt-sortable__item) { min-inline-size: 0; max-inline-size: 100%; box-sizing: border-box; }
  .smrt-nav-editor__icon { display: inline-grid; place-items: center; inline-size: 1.25rem; block-size: 1.25rem; min-inline-size: 1.25rem; }
  :global(.smrt-nav-editor__item-name) { flex: 1 1 auto; min-inline-size: 0; }
  :global(.smrt-nav-editor__new) { justify-self: start; }
  /* Sections mode: the entries are edited on the section's page. */
  .smrt-nav-editor[data-nav-mode='sections'] :global(.smrt-sortable__items) { display: none; }
  .smrt-nav-editor__section-icon { display: inline-flex; margin-inline-end: var(--smrt-spacing-2); vertical-align: middle; }
  .smrt-nav-editor__icons { flex: 1 1 100%; display: grid; grid-template-columns: repeat(auto-fill, minmax(2rem, 1fr)); gap: var(--smrt-spacing-1); padding-block-start: var(--smrt-spacing-1); }
  .smrt-nav-editor__icons :global(.smrt-shell-icon-button[aria-pressed='true']) { background: var(--smrt-color-primary-container); color: var(--smrt-color-on-primary-container); }
</style>
