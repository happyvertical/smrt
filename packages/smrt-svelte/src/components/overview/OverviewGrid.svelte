<script lang="ts">
/**
 * OverviewGrid - a customizable overview as a flow grid of widgets (#3727).
 *
 * Widgets keep an order and a column span of 1 to 4 (the grid draws 4, 2 or 1
 * columns by its own width); there is no free x/y. Rendering needs nothing but
 * the controller: widget data arrives with the page's server load, so a
 * server render and the hydrated client are the same tree.
 *
 * Edit mode is the shell's: inside an `AppShell` with `layoutEditing`, the
 * same pencil that edits the navigation edits the grid (pass `editing` to
 * drive it without a shell). While editing, each widget shows icon-only
 * controls (a drag handle, configure, remove), is rendered exactly as it is
 * on the site inside an `inert` wrapper, and has a resize handle on its end
 * edge. Everything works from the keyboard: Space on the handle picks a widget
 * up, the arrow keys move it, Enter drops, Escape cancels; the resize handle
 * is a slider (arrows, Home, End).
 */
import { Modal } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import { M } from '../../i18n/strings.overview.js';
import {
  createSortable,
  type SortableAnnouncement,
} from '../sortable/controller.svelte.js';
import { tryUseShellLayout } from '../workspace/admin-shell/layout-context.js';
import ShellIconButton from '../workspace/admin-shell/ShellIconButton.svelte';
import ShellSectionIcon from '../workspace/admin-shell/ShellSectionIcon.svelte';
import type { OverviewOpResult } from './controller.svelte.js';
import type { OverviewGridProps } from './grid-types.js';
import { spanFromKey, spanFromPointer } from './resize.js';
import { defaultWidgetOptions } from './schema.js';
import type { OverviewOptions, OverviewWidget } from './types.js';
import WidgetOptionsForm from './WidgetOptionsForm.svelte';

let {
  controller,
  components,
  editing: editingProp,
  label,
  headingLevel = 2,
  heading,
  presentation = 'card',
  models,
  iconComponent,
}: OverviewGridProps = $props();

const { t, locale } = useI18n();
const uid = $props.id();
const LIST = '__smrt-overview__';
const shellLayout = tryUseShellLayout();

const editing = $derived(
  controller.canCustomize && (editingProp ?? shellLayout?.editing ?? false),
);
const gridLabel = $derived(label ?? t(M['ui.overview.label']));
const registry = $derived(controller.registry);

interface Row {
  widget: OverviewWidget;
  title: string;
  status: 'ready' | 'loading' | 'error';
  data: unknown;
  def: ReturnType<typeof registry.get>;
}

const rows = $derived<Row[]>(
  controller.document.widgets.map((widget) => {
    const def = registry.get(widget.type);
    const custom =
      typeof widget.options.title === 'string'
        ? widget.options.title.trim()
        : '';
    const entry = controller.entry(widget);
    return {
      widget,
      def,
      title: custom || (def ? t(def.title) : widget.type),
      status: entry.status,
      data: entry.data,
    };
  }),
);
const rowById = $derived(new Map(rows.map((row) => [row.widget.id, row])));

// Data for widgets the entries do not cover yet (an add, a host-owned change).
// Client only: effects never run during server render.
$effect(() => {
  controller.document;
  untrack(() => controller.sync());
});

let rootEl: HTMLElement | undefined = $state();
let listEl: HTMLElement | undefined = $state();
let liveMessage = $state('');
let resizing = $state<{ id: string; span: number } | null>(null);
let addOpen = $state(false);
let configure = $state<{
  id: string | null;
  type: string;
  initial: OverviewOptions;
} | null>(null);

function say(message: string): void {
  liveMessage = message;
}

function sortableMessage(announcement: SortableAnnouncement): string {
  switch (announcement.type) {
    case 'pickup':
      return t(M['ui.overview.announce_pickup'], { widget: announcement.item });
    case 'position':
      return t(M['ui.overview.announce_position'], {
        widget: announcement.item,
        position: announcement.position,
        count: announcement.count,
      });
    case 'drop':
      return t(M['ui.overview.announce_drop'], {
        widget: announcement.item,
        position: announcement.position,
        count: announcement.count,
      });
    case 'cancel':
      return t(M['ui.overview.announce_cancel'], { widget: announcement.item });
    case 'failed':
      return t(M['ui.overview.announce_failed'], { widget: announcement.item });
    default:
      return '';
  }
}

const sortable = createSortable({
  root: () => rootEl,
  selectors: {
    container: '[data-smrt-overview-list]',
    containerKey: 'smrtOverviewList',
    item: '[data-smrt-overview-item]',
    itemKey: 'smrtOverviewItem',
  },
  containers: () => [{ id: LIST, label: gridLabel }],
  itemIds: () => rows.map((row) => row.widget.id),
  itemLabel: (id) => rowById.get(id)?.title,
  allowSameContainerReorder: () => true,
  enabled: () => editing,
  orientation: () => 'vertical',
  flow: () => true,
  announce: sortableMessage,
  focusTarget: (element) =>
    element.querySelector<HTMLElement>('[data-smrt-overview-handle]'),
  commit(move) {
    const result = controller.move(move.itemId, move.target.index);
    if (!result.ok && result.reason !== 'unchanged') {
      throw new Error(result.reason);
    }
  },
});

// Where a drag would drop: before the item at this rank, or after the last.
const dragged = $derived(sortable.drag?.itemId);
const dropAt = $derived(sortable.drag?.target.index);
const restCount = $derived(
  rows.filter((row) => row.widget.id !== dragged).length,
);

function dropMark(index: number): 'before' | 'after' | undefined {
  if (dropAt === undefined || dragged === undefined) return undefined;
  const id = rows[index].widget.id;
  if (id === dragged) return undefined;
  let rank = 0;
  for (let i = 0; i < index; i += 1)
    if (rows[i].widget.id !== dragged) rank += 1;
  if (rank === dropAt) return 'before';
  if (dropAt >= restCount && rank === restCount - 1) return 'after';
  return undefined;
}

function spanOf(row: Row): number {
  return resizing?.id === row.widget.id ? resizing.span : row.widget.span;
}

function isRtl(): boolean {
  return rootEl !== undefined && getComputedStyle(rootEl).direction === 'rtl';
}

function commitResize(row: Row, span: number): void {
  const result = controller.resize(row.widget.id, span);
  if (result.ok) {
    say(
      t(M['ui.overview.announce_resized'], {
        widget: row.title,
        span,
        max: row.def?.maxSpan ?? 4,
      }),
    );
  } else if (result.reason === 'not_allowed') {
    say(t(M['ui.overview.announce_denied']));
  }
}

function resizeKey(event: KeyboardEvent, row: Row): void {
  if (!row.def) return;
  const next = spanFromKey(
    event.key,
    row.widget.span,
    row.def.minSpan,
    row.def.maxSpan,
    isRtl(),
  );
  if (next === null) return;
  event.preventDefault();
  if (next !== row.widget.span) commitResize(row, next);
}

function resizeDown(event: PointerEvent, row: Row): void {
  if (event.button !== 0 || !row.def) return;
  event.preventDefault();
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  resizing = { id: row.widget.id, span: row.widget.span };
}

function resizeMove(event: PointerEvent, row: Row): void {
  if (resizing?.id !== row.widget.id || !row.def || !listEl) return;
  const item = (event.currentTarget as HTMLElement).closest(
    '[data-smrt-overview-item]',
  );
  if (!item) return;
  const list = listEl.getBoundingClientRect();
  const tile = item.getBoundingClientRect();
  const rtl = isRtl();
  const columns = getComputedStyle(listEl)
    .gridTemplateColumns.split(' ')
    .filter(Boolean).length;
  const span = spanFromPointer({
    pointer: event.clientX,
    start: rtl ? tile.right : tile.left,
    rtl,
    gridWidth: list.width,
    columns: columns || 1,
    gap: 0,
    min: row.def.minSpan,
    max: row.def.maxSpan,
  });
  if (span !== resizing.span) resizing = { id: row.widget.id, span };
}

function resizeUp(event: PointerEvent, row: Row): void {
  if (resizing?.id !== row.widget.id) return;
  const span = resizing.span;
  resizing = null;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture?.(event.pointerId)) {
    target.releasePointerCapture(event.pointerId);
  }
  if (span !== row.widget.span) commitResize(row, span);
}

function remove(row: Row): void {
  const result = controller.remove(row.widget.id);
  if (result.ok)
    say(t(M['ui.overview.announce_removed'], { widget: row.title }));
}

function reset(): void {
  const result = controller.reset();
  if (result.ok) say(t(M['ui.overview.announce_reset']));
}

function startConfigure(row: Row): void {
  configure = {
    id: row.widget.id,
    type: row.widget.type,
    initial: row.widget.options,
  };
}

function titleFor(type: string): string {
  const def = registry.get(type);
  return def ? t(def.title) : type;
}

function chooseType(type: string): void {
  const result = controller.add(type);
  addOpen = false;
  if (result.ok) {
    say(t(M['ui.overview.announce_added'], { widget: titleFor(type) }));
    return;
  }
  if (result.reason === 'invalid_options') {
    const def = registry.get(type);
    configure = {
      id: null,
      type,
      initial: def ? defaultWidgetOptions(def.options) : {},
    };
  }
}

function saveOptions(
  options: OverviewOptions,
): { key: string; code: string }[] | null {
  const current = configure;
  if (!current) return null;
  const result: OverviewOpResult =
    current.id === null
      ? controller.add(current.type, options)
      : controller.setOptions(current.id, options);
  if (result.ok) {
    say(
      t(
        M[
          current.id === null
            ? 'ui.overview.announce_added'
            : 'ui.overview.announce_configured'
        ],
        { widget: titleFor(current.type) },
      ),
    );
    configure = null;
    return null;
  }
  if (result.reason === 'invalid_options') return result.issues ?? [];
  if (result.reason === 'not_allowed') say(t(M['ui.overview.announce_denied']));
  configure = null;
  return null;
}

const configureDef = $derived(
  configure ? registry.get(configure.type) : undefined,
);
const configureTitle = $derived(
  configure
    ? t(
        M[
          configure.id === null
            ? 'ui.overview.options_new_title'
            : 'ui.overview.options_title'
        ],
        {
          widget: titleFor(configure.type),
        },
      )
    : '',
);
const headingTag = $derived(`h${headingLevel}`);
</script>

{#snippet body(row: Row)}
  {@const Widget = components?.get(row.widget.type) ?? row.def?.component}
  <article class="smrt-overview__widget" aria-labelledby="{uid}-title-{row.widget.id}">
    <svelte:element this={headingTag} class="smrt-overview__title" id="{uid}-title-{row.widget.id}">{#if heading}{@render heading(row.widget, row.title)}{:else}{row.title}{/if}</svelte:element>
    <div class="smrt-overview__content" aria-busy={row.status === 'loading'}>
      {#if !row.def}
        <p class="smrt-overview__state">{t(M['ui.overview.unavailable'])}</p>
      {:else if row.status === 'loading'}
        <p class="smrt-overview__state">{t(M['ui.overview.loading'])}</p>
      {:else if row.status === 'error'}
        <p class="smrt-overview__state" role="status">{t(M['ui.overview.error'])}</p>
        <Button type="button" variant="ghost" size="sm" onclick={() => controller.reload(row.widget.id)}>
          {t(M['ui.overview.retry'])}
        </Button>
      {:else if Widget}
        <Widget
          id={row.widget.id}
          options={row.widget.options}
          data={row.data}
          span={spanOf(row)}
          title={row.title}
          {locale}
          {iconComponent}
        />
      {:else}
        <p class="smrt-overview__state">{t(M['ui.overview.unavailable'])}</p>
      {/if}
    </div>
  </article>
{/snippet}

<div class="smrt-overview" bind:this={rootEl} data-editing={editing ? '' : undefined} data-presentation={presentation}>
  {#if editing}
    <div class="smrt-overview__toolbar" role="toolbar" aria-label={t(M['ui.overview.toolbar'])}>
      <ShellIconButton
        icon="add"
        label={t(M['ui.overview.add'])}
        disabled={controller.full || controller.addable.length === 0}
        onclick={() => (addOpen = true)}
      />
      <ShellIconButton
        icon="undo"
        label={t(M['ui.overview.reset'])}
        disabled={!controller.customized}
        onclick={reset}
      />
    </div>
  {/if}

  {#if rows.length === 0}
    <p class="smrt-overview__empty">{t(M['ui.overview.empty'])}</p>
  {/if}
  <div
    bind:this={listEl}
    class="smrt-overview__list"
    role="list"
    aria-label={gridLabel}
    data-smrt-overview-list={LIST}
    ondragover={(event) => event.preventDefault()}
    ondrop={(event) => {
      if (sortable.drag) sortable.dropOnContainer(event, LIST);
    }}
  >
    {#each rows as row, index (row.widget.id)}
      {@const mark = dropMark(index)}
      <div
        role="listitem"
        class="smrt-overview__item"
        data-span={spanOf(row)}
        data-smrt-overview-item={row.widget.id}
        data-dragging={dragged === row.widget.id ? '' : undefined}
        data-drop={mark}
        style:--span={spanOf(row)}
        ondragover={(event) => event.preventDefault()}
        ondrop={(event) => {
          if (!sortable.drag) return;
          event.stopPropagation();
          sortable.dropOnItem(event, LIST, index);
        }}
      >
        <div class="smrt-overview__tile">
          {#if editing}
            <div class="smrt-overview__chrome">
              <!-- raw-primitive-allow: native button owns keyboard pickup and HTML drag/drop -->
              <button
                type="button"
                class="smrt-overview__handle"
                data-smrt-overview-handle
                draggable={sortable.nativeDraggable}
                aria-label={t(M['ui.overview.move'], { widget: row.title })}
                aria-pressed={dragged === row.widget.id}
                onclick={() => sortable.consumeClick(row.widget.id)}
                onkeydown={(event) => sortable.keydown(event, row.widget.id)}
                onblur={(event) => sortable.blur(event, row.widget.id)}
                onpointerdown={(event) => sortable.pointerDown(event, row.widget.id)}
                onpointermove={(event) => sortable.pointerMove(event)}
                onpointerup={(event) => sortable.pointerUp(event)}
                onpointercancel={(event) => sortable.pointerCancel(event)}
                ondragstart={(event) => sortable.dragStart(event, row.widget.id)}
                ondragend={() => sortable.dragEnd()}
              ><span aria-hidden="true">⠿</span></button>
              <span class="smrt-overview__chrome-title" aria-hidden="true">{row.title}</span>
              {#if row.def && row.def.options.length > 0}
                <ShellIconButton
                  icon="settings"
                  label={t(M['ui.overview.configure'], { widget: row.title })}
                  onclick={() => startConfigure(row)}
                />
              {/if}
              <ShellIconButton
                icon="trash"
                label={t(M['ui.overview.remove'], { widget: row.title })}
                onclick={() => remove(row)}
              />
            </div>
            <div class="smrt-overview__inert" inert>
              {@render body(row)}
            </div>
            {#if row.def}
              <div
                class="smrt-overview__resize"
                role="slider"
                tabindex="0"
                aria-label={t(M['ui.overview.resize'], { widget: row.title })}
                aria-orientation="horizontal"
                aria-valuemin={row.def.minSpan}
                aria-valuemax={row.def.maxSpan}
                aria-valuenow={spanOf(row)}
                aria-valuetext={t(M['ui.overview.resize_value'], { span: spanOf(row), max: row.def.maxSpan })}
                onkeydown={(event) => resizeKey(event, row)}
                onpointerdown={(event) => resizeDown(event, row)}
                onpointermove={(event) => resizeMove(event, row)}
                onpointerup={(event) => resizeUp(event, row)}
                onpointercancel={(event) => resizeUp(event, row)}
              ></div>
            {/if}
          {:else}
            {@render body(row)}
          {/if}
        </div>
      </div>
    {/each}
  </div>

  <div class="smrt-overview__live" role="status" aria-live="polite" aria-atomic="true">{liveMessage}{sortable.announcement ? ` ${sortable.announcement}` : ''}</div>
</div>

{#if editing}
  <Modal bind:open={() => addOpen, (v) => (addOpen = v)} title={t(M['ui.overview.add_title'])} size="sm">
    {#if controller.addable.length === 0 || controller.full}
      <p>{t(M['ui.overview.add_none'])}</p>
    {:else}
      <ul class="smrt-overview__choices">
        {#each controller.addable as def (def.type)}
          <li>
            <Button type="button" variant="ghost" fullWidth onclick={() => chooseType(def.type)}>
              <span class="smrt-overview__choice">
                {#if def.icon}<ShellSectionIcon name={def.icon} {iconComponent} />{/if}
                <span class="smrt-overview__choice-text">
                  <strong>{t(def.title)}</strong>
                  {#if def.description}<small>{t(def.description)}</small>{/if}
                </span>
              </span>
            </Button>
          </li>
        {/each}
      </ul>
    {/if}
  </Modal>

  <Modal
    bind:open={() => configure !== null, (v) => { if (!v) configure = null; }}
    title={configureTitle}
    size="md"
  >
    {#if configure && configureDef}
      {#key `${configure.id ?? 'new'}:${configure.type}`}
        <WidgetOptionsForm
          definition={configureDef}
          initial={configure.initial}
          {models}
          onsave={saveOptions}
          oncancel={() => (configure = null)}
        />
      {/key}
    {/if}
  </Modal>
{/if}

<style>
  .smrt-overview { container-type: inline-size; min-inline-size: 0; }
  .smrt-overview__toolbar { display: flex; gap: var(--smrt-spacing-1); margin-block-end: var(--smrt-spacing-2); }
  .smrt-overview__empty { margin: 0; color: var(--smrt-color-on-surface-variant); }
  /* Gaps are tile padding, not grid gap, so a pointer never crosses a dead
     zone between tiles while dragging. */
  .smrt-overview__list { --_pad: var(--smrt-spacing-2); display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: calc(-1 * var(--_pad)); }
  .smrt-overview__item { position: relative; grid-column: span var(--span, 1); min-inline-size: 0; padding: var(--_pad); }
  .smrt-overview__item[data-dragging] { opacity: 0.5; }
  .smrt-overview__item[data-drop]::before { content: ''; position: absolute; inset-block: var(--_pad); inline-size: 0.1875rem; border-radius: var(--smrt-radius-full, 9999px); background: var(--smrt-color-primary); }
  .smrt-overview__item[data-drop='before']::before { inset-inline-start: 0; }
  .smrt-overview__item[data-drop='after']::before { inset-inline-end: 0; }
  .smrt-overview__tile { position: relative; block-size: 100%; box-sizing: border-box; padding: var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-large, var(--smrt-radius-medium)); background: var(--smrt-color-surface); color: var(--smrt-color-on-surface); }
  [data-presentation='plain']:not([data-editing]) .smrt-overview__tile { padding: 0; border: 0; border-radius: 0; background: transparent; }
  [data-editing] .smrt-overview__tile { border-style: dashed; }
  .smrt-overview__widget { display: grid; gap: var(--smrt-spacing-2); align-content: start; min-inline-size: 0; }
  .smrt-overview__title { margin: 0; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-title-small-size, 0.875rem); font-weight: var(--smrt-typography-weight-medium, 500); }
  .smrt-overview__state { margin: 0; color: var(--smrt-color-on-surface-variant); }
  .smrt-overview__chrome { display: flex; align-items: center; gap: var(--smrt-spacing-1); margin-block-end: var(--smrt-spacing-2); }
  .smrt-overview__chrome-title { flex: 1 1 auto; min-inline-size: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--smrt-color-on-surface-variant); font-size: var(--smrt-typography-label-large-size, 0.875rem); }
  .smrt-overview__handle { display: inline-grid; place-items: center; flex: 0 0 auto; inline-size: 2rem; block-size: 2rem; padding: 0; border: 0; border-radius: var(--smrt-radius-small); background: transparent; color: var(--smrt-color-on-surface-variant); cursor: grab; touch-action: none; }
  .smrt-overview__handle:active { cursor: grabbing; }
  .smrt-overview__handle:hover { background: var(--smrt-color-surface-container-high); }
  .smrt-overview__handle:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .smrt-overview__handle[aria-pressed='true'] { background: var(--smrt-color-primary-container); color: var(--smrt-color-on-primary-container); }
  .smrt-overview__resize { position: absolute; inset-block-start: 50%; inset-inline-end: -0.4375rem; inline-size: 0.875rem; block-size: 2.75rem; transform: translateY(-50%); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-full, 9999px); background: var(--smrt-color-surface-container-high); cursor: ew-resize; touch-action: none; }
  .smrt-overview__resize:hover { background: var(--smrt-color-primary-container); }
  .smrt-overview__resize:focus-visible { outline: 2px solid var(--smrt-color-primary); outline-offset: 2px; }
  .smrt-overview__choices { display: grid; gap: var(--smrt-spacing-1); margin: 0; padding: 0; list-style: none; }
  .smrt-overview__choice { display: flex; align-items: center; gap: var(--smrt-spacing-3); text-align: start; }
  .smrt-overview__choice-text { display: grid; }
  .smrt-overview__choice-text small { color: var(--smrt-color-on-surface-variant); }
  .smrt-overview__live { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; }

  /* Responsive columns follow the grid's own width, not the viewport. */
  @container (max-width: 40rem) {
    .smrt-overview__list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .smrt-overview__item[data-span='3'], .smrt-overview__item[data-span='4'] { grid-column: span 2; }
  }
  @container (max-width: 22rem) {
    .smrt-overview__list { grid-template-columns: minmax(0, 1fr); }
    .smrt-overview__list .smrt-overview__item[data-span] { grid-column: span 1; }
  }
</style>
