<script lang="ts">
/**
 * RecordScreen - the record page (#3718): a header (back link, the title or
 * a document's "Order GRA-3159", the monospace identifier, a status badge
 * and key facts by role; Edit as the one primary action and an overflow
 * menu with the host's extra actions and Delete), a details card of the
 * remaining fields (empty ones behind "Show empty fields"), and a
 * customizable `OverviewGrid` below: by default a summary strip of metric
 * tiles, the `line-items` table and totals when the model has line items,
 * and one tabbed `related` widget (`recordOverview`, persisted per model
 * kind). The edit form is a mode of the same screen: `mode: 'edit'` opens
 * `EditForm` beside the header on desktop (`min-width: 48rem`) and in a
 * full-screen `PhoneSheet` on phones. Closing the form calls `oncancel`.
 *
 * A related-records panel (a `records` widget with `filter: 'parent'` on one
 * of the relations) is headed `Orders · 3` with its one "View all" link
 * (`viewAllHref`, else the loaded data's `href`); the panel body then lists
 * the rows only, so the count and the link never repeat.
 *
 * The widget loaders run in the browser with the record context
 * (`ctx.record = { model, id }`); the host owns the data access. `related`
 * and `line-items` load through `loaders.records`. The registry and
 * overview are fixed at mount: remount (`{#key}`) to change the model kind.
 * A record change reloads every widget.
 */
import { PhoneSheet } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { onDestroy, untrack } from 'svelte';
import { M } from '../../i18n/strings.screens.js';
import { createOverview } from '../overview/controller.svelte.js';
import type { OverviewModelChoice } from '../overview/grid-types.js';
import { safeHref } from '../overview/markdown.js';
import OverviewGrid from '../overview/OverviewGrid.svelte';
import { recordOverview } from '../overview/record.js';
import { createWidgetRegistry } from '../overview/registry.js';
import type { OverviewWidget, WidgetLoadContext } from '../overview/types.js';
import { registerCoreWidgets } from '../overview/widgets/core.js';
import { isRecord } from '../overview/widgets/data.js';
import { registerRecordWidgets } from '../overview/widgets/record-widgets.js';
import DetailScreen from './DetailScreen.svelte';
import EditForm from './EditForm.svelte';
import {
  deriveScreenFields,
  screenSourceError,
  screenTitles,
} from './fields.js';
import RecordHeader from './RecordHeader.svelte';
import {
  deriveRecordHeader,
  recordTotals,
  totalsFields,
} from './record-header.js';
import type { ScreenRelation } from './relations.js';
import { currencyCodeField, deriveFieldRoles } from './roles.js';
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
  statusTones,
  derivedFields,
  items,
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

const roles = $derived(deriveFieldRoles(definition));
const viewFields = $derived(
  screenSourceError(definition, policy)
    ? []
    : deriveScreenFields(definition, policy, { mode: 'view', include: fields }),
);
const header = $derived(
  deriveRecordHeader(definition, viewFields, record, roles, { title }),
);
const hasItems = $derived(relations.some((r) => r.kind === 'items'));
const currencyField = $derived(currencyCodeField(definition));
/** The record's currency: the prop, else its own currency-code field. */
const recordCurrency = $derived.by(() => {
  if (currency) return currency;
  const value = currencyField ? record[currencyField] : undefined;
  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value.trim())
    ? value.trim().toUpperCase()
    : undefined;
});
/**
 * The details card leaves out what the header shows, the currency code
 * (every amount is formatted in it) and, when line items carry the totals
 * block, the subtotal / discount / tax / total fields.
 */
/** Derived fields of the edit form: the host's, else the totals under line items. */
const formDerived = $derived(
  derivedFields ?? (hasItems ? totalsFields(roles) : []),
);
const detailExclude = $derived([
  ...header.shown,
  ...(currencyField ? [currencyField] : []),
  ...(hasItems ? totalsFields(roles) : []),
]);

// The registry and the overview definition are fixed for the life of the
// component (a controller is built once); the loaders read live props.
const widgetRegistry = untrack(() => {
  if (registry) return registry;
  const own = createWidgetRegistry();
  registerCoreWidgets(own, loaders ?? {});
  // `related` and `line-items` load through the `records` loader, one
  // parent-filtered load per relation.
  if (loaders?.records) {
    registerRecordWidgets(own, {
      relations,
      records: loaders.records,
      viewAllHref: (relation) => viewAllHref?.(relation),
      totals: () => recordTotals(record, roles, viewFields),
      currency: () => recordCurrency,
    });
  }
  return own;
});
const overviewDefinition = untrack(
  () => overview ?? recordOverview(definition, relations),
);
const hostOwned = untrack(() => override !== undefined);

/** Relations a records panel can show: related records and line items. */
const children_ = $derived(relations.filter((r) => r.kind !== 'reference'));

/** What a related-records panel's heading shows: its count and View all. */
interface PanelSummary {
  count: number | null;
  href: string | null;
}
let summaries = $state<Record<string, PanelSummary>>({});

/**
 * A related-records panel's data, with its count and "View all" moved into
 * the heading: the widget body gets the rows only (no `total` / `href`
 * footer), so each panel carries exactly one View all.
 */
function headPanel(widget: OverviewWidget, data: unknown): unknown {
  if (widget.type !== 'records') return data;
  const relation = relationOf(widget);
  if (!relation || !isRecord(data)) return data;
  const { total, href, ...rest } = data;
  const rows = Array.isArray(rest.rows) ? rest.rows.length : null;
  summaries = {
    ...summaries,
    [widget.id]: {
      count: typeof total === 'number' && Number.isFinite(total) ? total : rows,
      href:
        viewAllHref?.(relation) ??
        (typeof href === 'string' ? safeHref(href) : null),
    },
  };
  return rest;
}

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
    return Promise.resolve(load(widget.options, ctx)).then((data) =>
      headPanel(widget, data),
    );
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

const modelChoices = $derived.by((): OverviewModelChoice[] => {
  const out: OverviewModelChoice[] = [];
  for (const relation of children_) {
    if (out.some((c) => c.value === relation.model)) continue;
    out.push({ value: relation.model, label: relation.label });
  }
  return out;
});

/** The `children` relation a parent-filtered widget shows, if any. */
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
  {@const panel =
    widget.type === 'records' &&
    relationOf(widget) &&
    controller.entry(widget).status === 'ready'
      ? summaries[widget.id]
      : undefined}
  <span class="smrt-record-screen__widget-heading">
    <span class="smrt-record-screen__widget-title">
      {widgetTitle}{#if panel && panel.count !== null}<span class="smrt-record-screen__count"
          >{' · '}{new Intl.NumberFormat(locale).format(panel.count)}</span
        >{/if}
    </span>
    {#if panel?.href}
      <a class="smrt-record-screen__view-all" href={panel.href}>{t(M['ui.screens.view_all'])}</a>
    {/if}
  </span>
{/snippet}

{#snippet editForm()}
  {#if onsave}
    {#key recordId}
      <EditForm
        {definition}
        {policy}
        currency={recordCurrency}
        {fields}
        {record}
        showHeader={false}
        {submitting}
        fieldErrors={fieldErrors ?? {}}
        {error}
        onsubmit={onsave}
        oncancel={cancel}
        derivedFields={formDerived}
      />
    {/key}
  {/if}
  {#if items}
    <section class="smrt-record-screen__items" aria-label={t(M['ui.screens.items'])}>
      {@render items()}
    </section>
  {/if}
{/snippet}

<div
  class="smrt-record-screen"
  class:smrt-record-screen--edit={editing}
  data-mode={mode}
  data-smrt-component="RecordScreen"
>
  <div class="smrt-record-screen__main">
    <RecordHeader
      {definition}
      model={header}
      {record}
      {relations}
      {hrefFor}
      {labels}
      currency={recordCurrency}
      {locale}
      {backLabel}
      {deleting}
      {statusTones}
      {onback}
      onedit={editing ? undefined : onedit}
      {ondelete}
      {extraActions}
    />
    <DetailScreen
      {definition}
      {policy}
      {record}
      {relations}
      {fields}
      currency={recordCurrency}
      {locale}
      {hrefFor}
      {labels}
      showHeader={false}
      exclude={detailExclude}
      hideEmpty
      variant="card"
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
        <div class="smrt-record-screen__sheet-body">{@render editForm()}</div>
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
  .smrt-record-screen__widget-heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
  .smrt-record-screen__count {
    color: var(--smrt-color-on-surface-variant);
    font-variant-numeric: tabular-nums;
  }
  .smrt-record-screen__view-all {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-normal, 400);
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
  .smrt-record-screen__items {
    min-inline-size: 0;
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
  /* The sheet body is edge to edge; the form gets the page gutter. */
  .smrt-record-screen__sheet-body {
    padding: var(--smrt-spacing-md, 1rem);
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
