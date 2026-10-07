<script lang="ts">
import { Input, Select, Switch } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { type Component, tick, untrack } from 'svelte';
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
import {
  SHELL_REGION_MESSAGES,
  SHELL_SLOT_MESSAGES,
  SHELL_SLOT_SHORT_MESSAGES,
} from './slot-labels.js';
import { isShellSlot, type ShellSlot, slotRegion } from './slots.js';
import TenantNav from './TenantNav.svelte';

interface Props {
  /** The layout API to edit; defaults to the nearest `AppShell`'s. */
  controller?: ShellLayoutController;
  /** Show a live preview of the resulting navigation (default true). */
  preview?: boolean;
  /** Icon renderer for the preview, as for `TenantNav`. */
  iconComponent?: Component<{ name: string; size?: number }>;
}

let { controller: provided, preview = true, iconComponent }: Props = $props();

const { t } = useI18n();
const layout = untrack(() => provided ?? useShellLayout());
const instanceId = $props.id();
const headingId = `${instanceId}-heading`;

const sections = $derived(layout.sections);
const panels = $derived(layout.panels);
const applied = $derived(layout.applied);

interface NavContainer extends SortableContainer {
  hidden: boolean;
  root: boolean;
  custom: boolean;
  titleVisible: boolean;
  count: number;
}

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
  })),
);
const items = $derived<SortableItem[]>(
  sections.flatMap((section) =>
    section.items.map((entry) => ({
      id: entry.id,
      containerId: section.id,
      label: entry.item.label,
    })),
  ),
);

function setShown(id: string, shown: boolean): void {
  if (shown) layout.show(id);
  else layout.hide(id);
}

let rootEl: HTMLElement | undefined = $state();

function rename(id: string, event: Event): void {
  const input = event.currentTarget as HTMLInputElement;
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
  const input = rootEl?.querySelector<HTMLInputElement>(
    `input[data-section-name="${CSS.escape(id)}"]`,
  );
  input?.focus();
  input?.select();
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
  layout.deleteSection(id);
}

/** Visual (row-major) order of the placement map, which is also the order a keyboard move walks. */
const PLACEMENT_ORDER: readonly ShellSlot[] = [
  'header.start',
  'header.center',
  'header.end',
  'leftSidebar.header',
  'rightSidebar.header',
  'leftSidebar.footer',
  'rightSidebar.footer',
  'footer.start',
  'footer.center',
  'footer.end',
];

interface SlotContainer extends SortableContainer {
  slot: ShellSlot;
  short: string;
  regionHidden: boolean;
  regionLabel: string;
}

const slotContainers = $derived<SlotContainer[]>(
  PLACEMENT_ORDER.map((slot) => {
    const region = slotRegion(slot);
    return {
      id: slot,
      slot,
      label: t(SHELL_SLOT_MESSAGES[slot]),
      short: t(SHELL_SLOT_SHORT_MESSAGES[slot]),
      regionLabel: t(SHELL_REGION_MESSAGES[region]),
      regionHidden: !layout.isRegionVisible(region),
    };
  }),
);
const placementViews = $derived(layout.placementItems);
const placementItems = $derived<SortableItem[]>(
  PLACEMENT_ORDER.flatMap((slot) =>
    (layout.placements[slot] ?? []).map((view) => ({
      id: view.id,
      containerId: slot,
      label: view.label,
    })),
  ),
);

function onplace(move: SortableItemMove<SortableItem, SlotContainer>): void {
  layout.placeItem(move.item.id, move.targetContainer.slot);
}

function onselect(id: string, event: Event): void {
  const select = event.currentTarget as HTMLSelectElement;
  if (isShellSlot(select.value)) layout.placeItem(id, select.value);
}

function onmove(move: SortableItemMove<SortableItem, NavContainer>): void {
  layout.moveItem(move.item.id, move.target.containerId, move.target.index);
}

function oncontainermove(move: SortableContainerMove<NavContainer>): void {
  layout.moveSection(move.container.id, move.target);
}
</script>

<section class="smrt-shell-layout-editor" aria-labelledby={headingId} bind:this={rootEl}>
  <header>
    <div>
      <h2 id={headingId}>{t(M['ui.shell_layout_editor.heading'])}</h2>
      <p>{t(M['ui.shell_layout_editor.description'])}</p>
    </div>
    <Button
      variant="secondary"
      size="sm"
      disabled={!layout.customized}
      onclick={() => layout.reset()}
    >
      {t(M['ui.shell_layout_editor.reset'])}
    </Button>
  </header>

  <fieldset class="smrt-shell-layout-editor__panels">
    <legend>{t(M['ui.shell_layout_editor.panels'])}</legend>
    {#each panels as panel (panel.edge)}
      <div class="smrt-shell-layout-editor__row" data-edge={panel.edge}>
        {#if panel.available}
          <Switch
            interaction={false}
            checked={panel.visible}
            label={t(M['ui.shell_layout_editor.show_panel'], { panel: panel.label })}
            onchange={(event) =>
              layout.setPanel(panel.edge, { visible: event.currentTarget.checked })}
          />
          <Switch
            interaction={false}
            checked={panel.initial === 'expanded'}
            disabled={!panel.visible}
            label={t(M['ui.shell_layout_editor.start_expanded'], { panel: panel.label })}
            onchange={(event) =>
              layout.setPanel(panel.edge, {
                initial: event.currentTarget.checked ? 'expanded' : 'collapsed',
              })}
          />
        {:else}
          <span class="smrt-shell-layout-editor__muted">
            {t(M['ui.shell_layout_editor.panel_unavailable'], { panel: panel.label })}
          </span>
        {/if}
      </div>
    {/each}
  </fieldset>

  {#if placementViews.length > 0}
    <div class="smrt-shell-layout-editor__placement" data-testid="shell-placement">
      <h3>{t(M['ui.shell_layout_editor.placement'])}</h3>
      <p>{t(M['ui.shell_layout_editor.placement_description'])}</p>
      <Sortable
        containers={slotContainers}
        items={placementItems}
        label={t(M['ui.shell_layout_editor.placement_label'])}
        allowSameContainerReorder={false}
        onmove={onplace}
      >
        {#snippet containerHeader({ container })}
          {@const entry = slotContainers.find((candidate) => candidate.id === container.id)}
          <strong>{entry?.short}</strong>
          <span class="smrt-shell-layout-editor__muted smrt-shell-layout-editor__region">{entry?.regionLabel}</span>
          {#if entry?.regionHidden}
            <span
              class="smrt-shell-layout-editor__region-hidden"
              data-region-hidden=""
              title={t(M['ui.shell_layout_editor.region_hidden'], { region: entry.regionLabel })}
            >{t(M['ui.shell_layout_editor.region_hidden_short'])}</span>
          {/if}
        {/snippet}
        {#snippet item({ item: entry })}
          {@const view = placementViews.find((candidate) => candidate.id === entry.id)}
          <span class="smrt-shell-layout-editor__label">{entry.label}</span>
          <Select
            interaction={false}
            value={view?.slot ?? ''}
            aria-label={t(M['ui.shell_layout_editor.move_to'], { label: entry.label })}
            onchange={(event) => onselect(entry.id, event)}
          >
            {#each slotContainers as option (option.id)}
              <option value={option.slot}>{option.label}</option>
            {/each}
          </Select>
          {#if view?.moved}
            <Button
              variant="secondary"
              size="sm"
              aria-label={t(M['ui.shell_layout_editor.reset_item'], { label: entry.label })}
              onclick={() => layout.resetItem(entry.id)}
            >
              {t(M['ui.shell_layout_editor.reset_item_short'])}
            </Button>
          {/if}
        {/snippet}
      </Sortable>
      {#each slotContainers.filter((candidate) => candidate.regionHidden && placementItems.some((entry) => entry.containerId === candidate.slot)) as hidden (hidden.id)}
        <p class="smrt-shell-layout-editor__muted" data-region-note={hidden.slot}>
          {t(M['ui.shell_layout_editor.region_hidden'], { region: hidden.regionLabel })}
        </p>
      {/each}
    </div>
  {/if}

  <div class="smrt-shell-layout-editor__body">
    <div class="smrt-shell-layout-editor__nav">
      <div class="smrt-shell-layout-editor__nav-head">
        <h3>{t(M['ui.shell_layout_editor.navigation'])}</h3>
        <Button variant="secondary" size="sm" onclick={createSection}>
          {t(M['ui.shell_layout_editor.new_section'])}
        </Button>
      </div>
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
          {#if entry?.root}
            <strong>{container.label}</strong>
          {:else}
            <Input
              class="smrt-shell-layout-editor__name"
              interaction={false}
              data-section-name={container.id}
              aria-label={t(M['ui.shell_layout_editor.section_name'], { label: container.label })}
              value={container.label}
              onchange={(event) => rename(container.id, event)}
            />
            <Switch
              interaction={false}
              label={t(M['ui.shell_layout_editor.visible'])}
              checked={!entry?.hidden}
              aria-label={t(M['ui.shell_layout_editor.show_entry'], { label: container.label })}
              onchange={(event) => setShown(container.id, event.currentTarget.checked)}
            />
            <Switch
              interaction={false}
              checked={entry?.titleVisible ?? true}
              label={t(M['ui.shell_layout_editor.show_title'])}
              aria-label={t(M['ui.shell_layout_editor.show_title_for'], { label: container.label })}
              onchange={(event) => layout.setSectionTitleVisible(container.id, event.currentTarget.checked)}
            />
            {#if entry?.custom}
              <Button
                variant="secondary"
                size="sm"
                aria-label={t(M['ui.shell_layout_editor.delete_section'], { label: container.label })}
                onclick={() => deleteSection(container.id, container.label, entry.count)}
              >
                {t(M['ui.shell_layout_editor.delete'])}
              </Button>
            {/if}
          {/if}
        {/snippet}
        {#snippet item({ item: entry, container })}
          {@const hidden = layout.isHidden(entry.id)}
          <span class="smrt-shell-layout-editor__label" class:smrt-shell-layout-editor__muted={hidden || layout.isHidden(container.id)}>{entry.label}</span>
          <Switch
            interaction={false}
            checked={!hidden}
            aria-label={t(M['ui.shell_layout_editor.show_entry'], { label: entry.label })}
            onchange={(event) => setShown(entry.id, event.currentTarget.checked)}
          />
        {/snippet}
      </Sortable>
    </div>

    {#if preview}
      <div class="smrt-shell-layout-editor__preview">
        <h3>{t(M['ui.shell_layout_editor.preview'])}</h3>
        <div
          class="smrt-shell-layout-editor__preview-frame"
          role="group"
          aria-label={t(M['ui.shell_layout_editor.preview_label'])}
          inert
        >
          <TenantNav
            items={applied.nav}
            groups={applied.groups}
            {iconComponent}
            aria-label={t(M['ui.shell_layout_editor.preview_label'])}
          />
        </div>
      </div>
    {/if}
  </div>
</section>

<style>
  .smrt-shell-layout-editor { display: grid; gap: var(--smrt-spacing-4); min-inline-size: 0; overflow-wrap: anywhere; }
  .smrt-shell-layout-editor header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--smrt-spacing-3); }
  .smrt-shell-layout-editor h2, .smrt-shell-layout-editor h3, .smrt-shell-layout-editor p { margin: 0; }
  .smrt-shell-layout-editor p, .smrt-shell-layout-editor__muted { color: var(--smrt-color-on-surface-variant); }
  .smrt-shell-layout-editor h3 { font: var(--smrt-typography-title-small-font); margin-block-end: var(--smrt-spacing-2); }
  .smrt-shell-layout-editor__panels { display: grid; gap: var(--smrt-spacing-2); margin: 0; padding: var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-md); }
  .smrt-shell-layout-editor__panels legend { padding-inline: var(--smrt-spacing-1); font: var(--smrt-typography-title-small-font); }
  .smrt-shell-layout-editor__row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--smrt-spacing-4); }
  .smrt-shell-layout-editor__body { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: var(--smrt-spacing-4); align-items: start; }
  .smrt-shell-layout-editor__nav-head { display: flex; align-items: center; justify-content: space-between; gap: var(--smrt-spacing-3); }
  .smrt-shell-layout-editor__nav-head h3 { margin-block-end: 0; }
  :global(.smrt-shell-layout-editor__name) { flex: 1 1 8rem; min-inline-size: 0; }
  .smrt-shell-layout-editor__label { flex: 1 1 auto; min-inline-size: 0; }
  .smrt-shell-layout-editor__preview-frame { padding: var(--smrt-spacing-3); border: 1px dashed var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-md); background: var(--smrt-color-surface-container-low, var(--smrt-color-surface)); }
  .smrt-shell-layout-editor__placement { display: grid; gap: var(--smrt-spacing-2); }
  .smrt-shell-layout-editor__placement :global(.smrt-sortable) { grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: start; }
  .smrt-shell-layout-editor__placement :global(.smrt-sortable__container) { grid-column: span 1; }
  .smrt-shell-layout-editor__placement :global([data-smrt-sortable-container-id^='leftSidebar']) { grid-column: 1; }
  .smrt-shell-layout-editor__placement :global([data-smrt-sortable-container-id^='rightSidebar']) { grid-column: 3; }
  .smrt-shell-layout-editor__placement :global([data-smrt-sortable-container-id='leftSidebar.header']) { grid-row: 2; }
  .smrt-shell-layout-editor__placement :global([data-smrt-sortable-container-id='leftSidebar.footer']) { grid-row: 3; }
  .smrt-shell-layout-editor__placement :global([data-smrt-sortable-container-id='rightSidebar.header']) { grid-row: 2; }
  .smrt-shell-layout-editor__placement :global([data-smrt-sortable-container-id='rightSidebar.footer']) { grid-row: 3; }
  .smrt-shell-layout-editor__placement :global([data-smrt-sortable-container-id='footer.start']) { grid-row: 4; grid-column: 1; }
  .smrt-shell-layout-editor__placement :global([data-smrt-sortable-container-id='footer.center']) { grid-row: 4; grid-column: 2; }
  .smrt-shell-layout-editor__placement :global([data-smrt-sortable-container-id='footer.end']) { grid-row: 4; grid-column: 3; }
  .smrt-shell-layout-editor__placement :global(.smrt-sortable__container:has([data-region-hidden])) { opacity: 0.6; border-style: dashed; }
  .smrt-shell-layout-editor__placement :global(.smrt-sortable__item) { flex-wrap: wrap; }
  .smrt-shell-layout-editor__region { font: var(--smrt-typography-body-small-font); }
  .smrt-shell-layout-editor__region-hidden { padding-inline: var(--smrt-spacing-2); border-radius: var(--smrt-radius-full); background: var(--smrt-color-surface-container-high); font: var(--smrt-typography-label-small-font); }
  @media (max-width: 48rem) {
    .smrt-shell-layout-editor__placement :global(.smrt-sortable) { grid-template-columns: minmax(0, 1fr); }
    .smrt-shell-layout-editor__placement :global([data-smrt-sortable-container-id]) { grid-column: 1 !important; grid-row: auto !important; }
  }
  @media (max-width: 48rem) {
    .smrt-shell-layout-editor header { flex-direction: column; }
    .smrt-shell-layout-editor__body { grid-template-columns: minmax(0, 1fr); }
  }
</style>
