<script lang="ts">
// A record's page (smrt#3718 record view): the framework's `RecordScreen`
// over one sample row. Its fields read-only at the top, then the record's
// own editable overview (`detail:<pkg>.<Model>`, saved in the cookbook with
// the section pages'): a summary strip, the line items with the record's
// totals, and the related records as tabs, each with its "View all" to the
// list narrowed to this record. Edit is the `/edit/` route of the same page:
// the form (with the line-items editor under it) opens beside the header on
// desktop and as a sheet on phones. Everything is generic, from the
// catalog's foreign keys and the framework's field roles.
//
// No `$app` import: the static route and the mounted `Planner` both render
// it, giving it their own `href` and `navigate`.
import {
  RecordScreen,
  type ScreenField,
  type ScreenRelation,
} from '@happyvertical/smrt-svelte/screens';
import {
  catalog,
  getModel,
  getModelByQualifiedName,
} from '../catalog/index.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { useDataSource } from '../data/context.ts';
import {
  derivedFieldNames,
  isAllocationModel,
  isLineModel,
} from '../data/derived.ts';
import { recordHeading } from '../data/display.ts';
import type { ModelRecord } from '../data/fakes.ts';
import { humanize, labelKey, pluralize } from '../data/format.ts';
import {
  isProfileLabelled,
  recordLabel,
  relationLabels,
} from '../data/labels.ts';
import {
  detailOverviewFor,
  detailOverviewId,
} from '../overviews/definitions.ts';
import { overviewRegistry } from '../overviews/registry.ts';
import { appHref } from '../planner/app.svelte.ts';
import {
  filteredListPath,
  modelPath,
  type RecordMode,
  recordPath,
} from '../planner/routes.ts';
import { recipes, recipesById } from '../recipes/index.ts';
import { childLinks, childTitle, lineageNames } from '../recipes/plumbing.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { screenDefinition, screenPolicy } from '../screens/definition.ts';
import { appModels, screenRelations } from '../screens/relations.ts';
import ChildRecords from './ChildRecords.svelte';

interface RecordViewProps {
  packageId: string;
  modelName: string;
  recordId: string;
  mode?: RecordMode;
  /** An in-app path as a link; the planner's `appHref` by default. */
  href?: (path: string) => string;
  /** Go to an in-app path; defaults to following `href`. */
  navigate?: (path: string) => void;
}

let {
  packageId,
  modelName,
  recordId,
  mode = 'view',
  href = appHref,
  navigate = (path) => {
    location.assign(href(path));
  },
}: RecordViewProps = $props();

const source = useDataSource();

const catalogModel = $derived(getModel(packageId, modelName));
// Recipe options (field policies, narrowed exposure) shape what is shown.
const applied = $derived(
  catalogModel ? recipeState.apply(catalogModel) : undefined,
);
const definition = $derived(
  catalogModel ? screenDefinition(catalogModel) : undefined,
);
// A customer or vendor is named by its Profile: in view mode that field is
// the page title, so the header and the details card leave it out. The
// edit form keeps it (it is how the name is changed).
const policy = $derived(
  catalogModel && applied
    ? screenPolicy(
        catalogModel,
        mode === 'view' && isProfileLabelled(catalogModel)
          ? applied.fields.filter((f) => f.name !== 'profileId')
          : applied.fields,
      )
    : undefined,
);
const added = $derived(
  recipeState.ids.flatMap((id) => {
    const recipe = recipesById.get(id);
    return recipe ? [recipe] : [];
  }),
);
const inApp = $derived(appModels(added, recipeState.features));
const relations = $derived(
  catalogModel ? screenRelations(catalog, catalogModel.id, inApp) : [],
);
const overviewId = $derived(detailOverviewId(packageId, modelName));
const overview = $derived(detailOverviewFor(overviewId, inApp));
// Line items and other dependent records are edited under their parent.
const childTables = $derived.by(() => {
  if (!catalogModel) return [];
  const parentNames = lineageNames(catalog, catalogModel.id);
  return childLinks(catalog, recipes, catalogModel.id).map((link) => {
    const view = recipeState.apply(link.model);
    return {
      model: view.model,
      fields: view.fields,
      fk: link.fk,
      title: childTitle(link.model.name, parentNames),
    };
  });
});
/** Shown but never typed: a line's amount, a parent's totals. */
const calculated = $derived(
  catalogModel
    ? derivedFieldNames(
        catalogModel,
        childTables.some((c) => isLineModel(c.model)),
        childTables.some((c) => isAllocationModel(c.model)),
      )
    : new Set<string>(),
);

let record = $state<ModelRecord | undefined>(undefined);
let loaded = $state(false);
/**
 * The header's title for a record with a name (a customer's Profile name);
 * a document gets none, so the header leads with its kind and identifier
 * ("Order GRA-3159", the identifier monospace).
 */
let title = $state<string | undefined>(undefined);
/** Labels of the records this one points at, by `labelKey`. */
let labelMap = $state(new Map<string, string>());
let submitting = $state(false);
let deleting = $state(false);
let error = $state<string | null>(null);

async function load() {
  if (!catalogModel) {
    loaded = true;
    return;
  }
  const found = await source.get(catalogModel, recordId);
  record = found;
  if (found) {
    let name: string;
    [name, labelMap] = await Promise.all([
      recordLabel(source, catalogModel, found),
      relationLabels(source, catalogModel.fields, [found]),
    ]);
    title =
      recordHeading(catalogModel, found, name, humanize(modelName)) === name
        ? name
        : undefined;
  }
  loaded = true;
}

$effect(() => {
  // Reload when the record (or the model) changes.
  recordId;
  catalogModel?.id;
  loaded = false;
  void load();
});
// A reset (a cookbook applied, the app reset) swaps the rows underneath.
$effect(() => source.onReset?.(() => void load()));

const listPath = $derived(modelPath(packageId, modelName));
const backLabel = $derived(pluralize(humanize(modelName)));

/** The target model of a reference field, through the relations. */
function targetOf(field: ScreenField): ScreenRelation | undefined {
  return relations.find(
    (r) => r.kind === 'reference' && r.field === field.name,
  );
}

/**
 * A referenced record's view page, when its model is in the app; a target
 * outside it (a customer's Profile in an app without profiles) shows its
 * label without a link.
 */
function hrefFor(field: ScreenField, id: string): string | undefined {
  const target = targetOf(field);
  if (!target || !inApp.has(target.model)) return undefined;
  const found = getModelByQualifiedName(target.model);
  return found?.model.exposed
    ? href(recordPath(found.pkg.id, found.model.name, id))
    : undefined;
}

// Display names for the referenced records, keyed by their model.
const labels = $derived(
  Object.fromEntries(
    relations
      .filter((r) => r.kind === 'reference')
      .map((r) => [
        r.model,
        (id: string) => labelMap.get(labelKey(r.model, id)),
      ]),
  ),
);

function viewAllHref(relation: ScreenRelation): string | undefined {
  const found = getModelByQualifiedName(relation.model);
  return found?.model.exposed
    ? href(
        filteredListPath(
          found.pkg.id,
          found.model.name,
          relation.field,
          recordId,
        ),
      )
    : undefined;
}

async function save(values: Record<string, unknown>) {
  if (!catalogModel) return;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (!calculated.has(key)) next[key] = value;
  }
  submitting = true;
  error = null;
  try {
    await source.update(catalogModel, recordId, next);
    await load();
    navigate(recordPath(packageId, modelName, recordId));
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  } finally {
    submitting = false;
  }
}

async function remove() {
  if (!catalogModel) return;
  deleting = true;
  try {
    await source.delete(catalogModel, recordId);
    navigate(listPath);
  } finally {
    deleting = false;
  }
}

/** A line item changed: the record's calculated totals moved. */
async function refreshDerived() {
  if (!catalogModel) return;
  const fresh = await source.get(catalogModel, recordId);
  if (fresh) record = fresh;
}

/**
 * What the record page's own widgets read (the planner widget context):
 * the app's relations for the related tabs and the line items. The
 * line-items loader reads the record's totals itself, fresh at load time.
 */
const widgetContext = $derived({ source, href, relations, viewAllHref });
</script>

<!-- Line items and other dependent records are edited with the record:
     RecordScreen renders this under the edit form, in the edit column on
     desktop and inside the edit sheet on phones. In view mode the overview's
     line-items widget shows them, so there is no second panel. -->
{#snippet items()}
  {#each childTables as child (child.model.id)}
    <ChildRecords
      model={child.model}
      fields={child.fields}
      fk={child.fk}
      title={child.title}
      parentId={recordId}
      onchanged={refreshDerived}
    />
  {/each}
{/snippet}

{#if !loaded}
  <p>Loading...</p>
{:else if !catalogModel || !definition || !record || !overview}
  <div class="missing">
    <h1>Record not found</h1>
    <p>
      This record is not in your app's sample data.
      <a href={href(listPath)}>Back to {backLabel.toLowerCase()}</a>
    </p>
  </div>
{:else}
  {#key `${overviewId}:${inApp.size}`}
    <div class="record-view" data-record-view={record.id} data-mode={mode}>
      <RecordScreen
        {definition}
        {policy}
        {record}
        {relations}
        {mode}
        registry={overviewRegistry}
        {widgetContext}
        {overview}
        override={cookbookStore.overview(overviewId)}
        onoverviewchange={(override) =>
          cookbookStore.setOverview(overviewId, override)}
        {hrefFor}
        {labels}
        {viewAllHref}
        {title}
        {backLabel}
        {submitting}
        {deleting}
        {error}
        onback={() => navigate(listPath)}
        onedit={() => navigate(recordPath(packageId, modelName, recordId, 'edit'))}
        oncancel={() => navigate(recordPath(packageId, modelName, recordId))}
        onsave={save}
        ondelete={remove}
        derivedFields={[...calculated]}
        items={childTables.length ? items : undefined}
      />
    </div>
  {/key}
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .record-view {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .missing h1 {
    margin: 0 0 var(--smrt-spacing-2);
  }
}
</style>
