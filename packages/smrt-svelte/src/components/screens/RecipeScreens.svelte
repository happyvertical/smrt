<script lang="ts">
/**
 * RecipeScreens - list, view, create and edit for any model, derived from its
 * manifest definition and resolved field policy (#3718). It is the default
 * screen set for a package that ships models but no consumer UI: tags, facts,
 * secrets, profiles, reports, prompts and the like.
 *
 * It composes `ListScreen`, `DetailScreen` and `EditForm` over a
 * transport-neutral `source` (list / get / create / update / delete). The
 * `view` and `recordId` props are bindable so an app can mirror them into its
 * router (`onnavigate` fires on every user navigation); left unbound, the
 * component keeps its own state. An operation is offered only when the source
 * implements it and `can` has not turned it off, so a read-only source yields
 * a read-only screen set.
 */
import { Alert } from '@happyvertical/smrt-ui/feedback';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import { M } from '../../i18n/strings.screens.js';
import DetailScreen from './DetailScreen.svelte';
import EditForm from './EditForm.svelte';
import { screenTitles } from './fields.js';
import ListScreen from './ListScreen.svelte';
import type {
  RecipeScreensProps,
  RecipeScreensSource,
  RecipeScreenView,
  ScreenCollectionDefinition,
  ScreenPolicy,
  ScreenRecord,
} from './types.js';

let {
  definition,
  policy = null,
  source,
  view = $bindable<RecipeScreenView>('list'),
  recordId = $bindable<string | null>(null),
  title,
  columns,
  fields,
  currency,
  locale,
  can = {},
  onnavigate,
}: RecipeScreensProps = $props();

const { t } = useI18n();

const titles = $derived(screenTitles(definition));
const idField = $derived(definition.idField ?? 'id');
const allowCreate = $derived(can.create !== false && !!source.create);
const allowUpdate = $derived(can.update !== false && !!source.update);
const allowDelete = $derived(can.delete !== false && !!source.delete);

let rows = $state<readonly ScreenRecord[]>([]);
let loading = $state(true);
let loadFailed = $state(false);
let saving = $state(false);
let deleting = $state(false);
let fetched = $state<ScreenRecord | undefined>(undefined);
let fetchSettled = $state(false);

async function refresh(): Promise<void> {
  loading = true;
  loadFailed = false;
  try {
    rows = await source.list();
  } catch {
    loadFailed = true;
  } finally {
    loading = false;
  }
}

$effect(() => {
  // Reload whenever the source (or object) changes; mutations call refresh().
  void source;
  void definition.objectRef;
  untrack(() => void refresh());
});

// Resolve the record for view / edit: `source.get` when provided, else the
// loaded list. A token drops answers for a record the user already left.
let fetchToken = 0;
$effect(() => {
  const id = recordId;
  const wanted = view === 'view' || view === 'edit';
  const get = source.get;
  const token = ++fetchToken;
  fetched = undefined;
  fetchSettled = false;
  if (!wanted || id === null || !get) return;
  void get
    .call(source, id)
    .then((found) => {
      if (token === fetchToken) fetched = found;
    })
    .catch(() => {
      if (token === fetchToken) fetched = undefined;
    })
    .finally(() => {
      if (token === fetchToken) fetchSettled = true;
    });
});

const current = $derived<ScreenRecord | undefined>(
  recordId === null
    ? undefined
    : (fetched ??
        (source.get && !fetchSettled
          ? undefined
          : rows.find((row) => String(row[idField]) === recordId))),
);
const resolving = $derived(
  (view === 'view' || view === 'edit') &&
    recordId !== null &&
    !current &&
    (loading || (!!source.get && !fetchSettled)),
);

function navigate(next: RecipeScreenView, id: string | null = null): void {
  view = next;
  recordId = id;
  onnavigate?.(next, id);
}

function idOf(record: ScreenRecord | undefined): string | null {
  const value = record?.[idField];
  return value === undefined || value === null ? null : String(value);
}

async function create(values: Record<string, unknown>): Promise<void> {
  saving = true;
  try {
    const created = await source.create?.(values);
    await refresh();
    const id = idOf(created);
    if (id) navigate('view', id);
    else navigate('list');
  } finally {
    saving = false;
  }
}

async function update(values: Record<string, unknown>): Promise<void> {
  if (recordId === null) return;
  saving = true;
  try {
    await source.update?.(recordId, values);
    await refresh();
    navigate('view', recordId);
  } finally {
    saving = false;
  }
}

async function remove(): Promise<void> {
  if (recordId === null) return;
  deleting = true;
  try {
    await source.delete?.(recordId);
    await refresh();
    navigate('list');
  } finally {
    deleting = false;
  }
}
</script>

<div class="smrt-recipe-screens">
  {#if view === 'create' && allowCreate}
          <EditForm
        {definition}
        {policy}
        {currency}
        {fields}
        submitting={saving}
        onsubmit={create}
        oncancel={() => navigate('list')}
      />
  {:else if (view === 'view' || view === 'edit') && recordId !== null}
    {#if current}
      {#if view === 'edit' && allowUpdate}
        {#key recordId}
          <EditForm
            {definition}
            {policy}
            {currency}
            {fields}
            record={current}
            submitting={saving}
            onsubmit={update}
            oncancel={() => navigate('view', recordId)}
          />
        {/key}
      {:else}
        <DetailScreen
          {definition}
          {policy}
          {currency}
          {locale}
          {fields}
          record={current}
          {deleting}
          onback={() => navigate('list')}
          onedit={allowUpdate ? () => navigate('edit', recordId) : undefined}
          ondelete={allowDelete ? remove : undefined}
        />
      {/if}
    {:else if !resolving}
      <Alert variant="warning">{t(M['ui.screens.not_found'])}</Alert>
      <Button variant="ghost" onclick={() => navigate('list')}>
        {t(M['ui.screens.back'], { name: titles.plural.toLowerCase() })}
      </Button>
    {/if}
  {:else}
    <ListScreen
      {definition}
      {policy}
      {rows}
      {title}
      {columns}
      {currency}
      {locale}
      {loading}
      error={loadFailed ? t(M['ui.screens.load_failed']) : null}
      onretry={() => void refresh()}
      onselect={(row) => {
        const id = idOf(row);
        if (id) navigate('view', id);
      }}
      oncreate={allowCreate ? () => navigate('create') : undefined}
    />
  {/if}
</div>
