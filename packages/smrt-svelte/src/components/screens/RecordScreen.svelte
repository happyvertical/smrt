<script lang="ts">
/**
 * RecordScreen - the record view (#3718 record view): the `DetailScreen`
 * header and fields at the top, a customizable `OverviewGrid` of related
 * records below (one panel per `children` relation, persisted per model
 * kind), and the edit form as a mode of the same screen: `mode: 'edit'`
 * opens `EditForm` beside the header on desktop (`min-width: 48rem`) and in
 * a full-screen `PhoneSheet` on phones. Closing the form calls `oncancel`.
 *
 * The widget loaders run in the browser with the record context
 * (`ctx.record = { model, id }`); the host owns the data access. The
 * registry and overview are fixed at mount: remount (`{#key}`) to change the
 * model kind. A record change reloads every widget.
 */
import { PhoneSheet } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { onDestroy, untrack } from 'svelte';
import { M } from '../../i18n/strings.screens.js';
import { createOverview } from '../overview/controller.svelte.js';
import type { OverviewModelChoice } from '../overview/grid-types.js';
import OverviewGrid from '../overview/OverviewGrid.svelte';
import { recordOverview } from '../overview/record.js';
import { createWidgetRegistry } from '../overview/registry.js';
import type { OverviewWidget, WidgetLoadContext } from '../overview/types.js';
import { registerCoreWidgets } from '../overview/widgets/core.js';
import DetailScreen from './DetailScreen.svelte';
import EditForm from './EditForm.svelte';
import { screenTitles } from './fields.js';
import type { ScreenRelation } from './relations.js';
import type { RecordScreenProps } from './types.js';

let {
  definition,
  policy = null,
  record,
  relations = [],
  mode,
  loaders,
  registry,
  widgetContext,
  overview,
  override,
  onoverviewchange,
  layoutEditing,
  canCustomize = true,
  hrefFor,
  labels,
  viewAllHref,
  title,
  fields,
  currency,
  locale,
  backLabel,
  deleting = false,
  submitting = false,
  fieldErrors,
  error = null,
  onback,
  onedit,
  oncancel,
  onsave,
  ondelete,
  extraActions,
  children,
}: RecordScreenProps = $props();

const { t } = useI18n();

/** Desktop breakpoint: the edit form sits beside the header from here up. */
const DESKTOP_QUERY = '(min-width: 48rem)';

const titles = $derived(screenTitles(definition));
const idField = $derived(definition.idField ?? 'id');
const recordId = $derived(
  record[idField] === undefined || record[idField] === null
    ? ''
    : String(record[idField]),
);
const editing = $derived(mode === 'edit');
const editTitle = $derived(
  t(M['ui.screens.edit_title'], { name: titles.singular.toLowerCase() }),
);

// The registry and the overview definition are fixed for the life of the
// component (a controller is built once); the loaders read live props.
const widgetRegistry = untrack(() => {
  if (registry) return registry;
  const own = createWidgetRegistry();
  registerCoreWidgets(own, loaders ?? {});
  return own;
});
const overviewDefinition = untrack(
  () => overview ?? recordOverview(definition, relations),
);
const hostOwned = untrack(() => override !== undefined);

const controller = createOverview({
  definition: overviewDefinition,
  registry: widgetRegistry,
  override: hostOwned ? () => override ?? null : undefined,
  onchange: (next) => onoverviewchange?.(next),
  canCustomize: () => canCustomize,
  loadWidget: (widget, signal) => {
    const load = widgetRegistry.get(widget.type)?.load;
    if (!load) return Promise.resolve(undefined);
    const ctx: WidgetLoadContext = {
      ...widgetContext,
      overviewId: overviewDefinition.id,
      signal,
      locale:
        typeof widgetContext?.locale === 'string'
          ? widgetContext.locale
          : locale,
      record: { model: definition.objectRef, id: recordId },
    };
    return Promise.resolve(load(widget.options, ctx));
  },
});
onDestroy(() => controller.destroy());

// A host-owned override can change outside the controller; a record change
// means every panel reads a different parent.
let loadedFor = untrack(() => recordId);
$effect(() => {
  const id = recordId;
  if (id === loadedFor) return;
  loadedFor = id;
  untrack(() => {
    for (const widget of controller.document.widgets)
      controller.reload(widget.id);
  });
});
$effect(() => {
  if (!hostOwned) return;
  void override;
  untrack(() => controller.sync());
});

const children_ = $derived(relations.filter((r) => r.kind === 'children'));
const modelChoices = $derived.by((): OverviewModelChoice[] => {
  const out: OverviewModelChoice[] = [];
  for (const relation of children_) {
    if (out.some((c) => c.value === relation.model)) continue;
    out.push({ value: relation.model, label: relation.label });
  }
  return out;
});

/** The relation a related-records widget shows, for its "View all" link. */
function relationOf(widget: OverviewWidget): ScreenRelation | undefined {
  const { filter, model, field } = widget.options;
  if (filter !== 'parent') return undefined;
  return children_.find((r) => r.model === model && r.field === field);
}

// Phones get the edit form as a full-screen sheet; the server and a browser
// without matchMedia render the desktop layout.
let desktop = $state(true);
$effect(() => {
  if (
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function'
  ) {
    return;
  }
  const media = window.matchMedia(DESKTOP_QUERY);
  const sync = () => {
    desktop = media.matches;
  };
  sync();
  media.addEventListener('change', sync);
  return () => media.removeEventListener('change', sync);
});

function cancel(): void {
  oncancel?.();
}
</script>

{#snippet widgetHeading(widget: OverviewWidget, widgetTitle: string)}
  {@const relation = relationOf(widget)}
  {@const href = relation ? viewAllHref?.(relation) : undefined}
  <span class="smrt-record-screen__widget-title">{widgetTitle}</span>
  {#if href}
    <a class="smrt-record-screen__view-all" {href}>{t(M['ui.screens.view_all'])}</a>
  {/if}
{/snippet}

{#snippet editForm()}
  {#if onsave}
    {#key recordId}
      <EditForm
        {definition}
        {policy}
        {currency}
        {fields}
        {record}
        showHeader={false}
        {submitting}
        fieldErrors={fieldErrors ?? {}}
        {error}
        onsubmit={onsave}
        oncancel={cancel}
      />
    {/key}
  {/if}
{/snippet}

<div
  class="smrt-record-screen"
  class:smrt-record-screen--edit={editing}
  data-mode={mode}
  data-smrt-component="RecordScreen"
>
  <div class="smrt-record-screen__main">
    <DetailScreen
      {definition}
      {policy}
      {record}
      {relations}
      {title}
      {fields}
      {currency}
      {locale}
      {backLabel}
      {deleting}
      {hrefFor}
      {labels}
      {onback}
      onedit={editing ? undefined : onedit}
      {ondelete}
      {extraActions}
    >
      {@render children?.()}
    </DetailScreen>
    <section class="smrt-record-screen__related" aria-label={t(M['ui.screens.related'])}>
      <OverviewGrid
        {controller}
        editing={layoutEditing}
        presentation="plain"
        headingLevel={2}
        heading={widgetHeading}
        label={t(M['ui.screens.related'])}
        models={modelChoices}
      />
    </section>
  </div>
  {#if editing && desktop}
    <aside class="smrt-record-screen__aside" aria-label={editTitle}>
      <h2 class="smrt-record-screen__aside-title">{editTitle}</h2>
      {@render editForm()}
    </aside>
  {/if}
</div>

{#if !desktop}
  <!-- A section, so the sheet's header is not a second banner landmark. -->
  <section class="smrt-record-screen__sheet" data-smrt-component="RecordScreen">
    <PhoneSheet open={editing} title={editTitle} onclose={cancel} variant="page">
      {#if editing}
        {@render editForm()}
      {/if}
    </PhoneSheet>
  </section>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .smrt-record-screen {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--smrt-spacing-lg, 1.5rem);
    align-items: start;
  }
  .smrt-record-screen__main {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-lg, 1.5rem);
    min-inline-size: 0;
  }
  .smrt-record-screen__related {
    min-inline-size: 0;
  }
  .smrt-record-screen__view-all {
    margin-inline-start: var(--smrt-spacing-sm, 0.5rem);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: normal;
  }
  .smrt-record-screen__aside {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-md, 1rem);
    padding: var(--smrt-spacing-md, 1rem);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-lg);
    background: var(--smrt-color-surface-container-low, var(--smrt-color-surface));
    animation: smrt-record-screen-in var(--smrt-duration-medium1)
      var(--smrt-easing-standard) both;
  }
  .smrt-record-screen__aside-title {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
  @media (min-width: 48rem) {
    .smrt-record-screen--edit {
      grid-template-columns: minmax(0, 1fr) minmax(20rem, 28rem);
    }
    .smrt-record-screen__aside {
      position: sticky;
      inset-block-start: var(--smrt-spacing-md, 1rem);
    }
  }
  .smrt-record-screen__sheet {
    position: fixed;
    inset: 0;
    z-index: var(--smrt-z-index-modal);
    pointer-events: none;
  }
  .smrt-record-screen__sheet > :global(*) {
    pointer-events: auto;
  }
  @keyframes smrt-record-screen-in {
    from {
      opacity: 0;
      transform: translateX(var(--smrt-spacing-md, 1rem));
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-record-screen__aside {
      animation: none;
    }
  }
}
</style>
