<script lang="ts">
import { Input, Switch } from '@happyvertical/smrt-ui/forms';
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
import ShellIconButton from './ShellIconButton.svelte';
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
      label: entry.label,
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
            <ShellIconButton
              icon={entry?.hidden ? 'eyeOff' : 'eye'}
              pressed={!entry?.hidden}
              label={t(M['ui.shell_layout_editor.show_entry'], { label: container.label })}
              onclick={() => setShown(container.id, !!entry?.hidden)}
            />
            <ShellIconButton
              icon={entry?.titleVisible === false ? 'headingOff' : 'heading'}
              pressed={entry?.titleVisible ?? true}
              label={t(M['ui.shell_layout_editor.show_title_for'], { label: container.label })}
              onclick={() => layout.setSectionTitleVisible(container.id, !(entry?.titleVisible ?? true))}
            />
            {#if entry?.custom}
              <ShellIconButton
                icon="trash"
                label={t(M['ui.shell_layout_editor.delete_section'], { label: container.label })}
                onclick={() => deleteSection(container.id, container.label, entry.count)}
              />
            {/if}
          {/if}
        {/snippet}
        {#snippet item({ item: entry, container })}
          {@const hidden = layout.isHidden(entry.id)}
          <span class="smrt-shell-layout-editor__label" class:smrt-shell-layout-editor__muted={hidden || layout.isHidden(container.id)}>{entry.label}</span>
          <ShellIconButton
            icon={hidden ? 'eyeOff' : 'eye'}
            pressed={!hidden}
            label={t(M['ui.shell_layout_editor.show_entry'], { label: entry.label })}
            onclick={() => setShown(entry.id, hidden)}
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
  /* Label on its own line (never broken mid-word); the select and Reset share the next line. */
  @media (max-width: 48rem) {
    .smrt-shell-layout-editor header { flex-direction: column; }
    .smrt-shell-layout-editor__body { grid-template-columns: minmax(0, 1fr); }
  }
</style>
