<script lang="ts">
/**
 * Main-content tenant-admin destination for field defaults. The host supplies
 * the SettingsCatalog shell and generated-client adapter, keeping this package
 * independent of both smrt-svelte and smrt-web.
 */
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Component, Snippet } from 'svelte';
import type {
  FieldPolicyDetailItem,
  FieldPolicySettingsCatalogData,
  FieldPolicySettingsCatalogPage,
} from '../../settings-catalog.js';
import type {
  FieldPolicyAuditSnapshot,
  FieldPolicyEditorState,
} from '../../types.js';
import {
  editorStateErrorMessage,
  isFieldPolicyEditorState,
} from '../field-policy-editor.js';
import {
  auditObjectRefs,
  decorateCatalogPage,
  type FieldPolicyControlPanelAdapter,
  type FieldPolicyLayerCell,
  fieldPolicyCatalogPreservedParams,
  fieldPolicyRollup,
  orgRowIdsForObject,
  prunableDriftRows,
} from '../settings-catalog.js';
import FieldPolicyEditor from './FieldPolicyEditor.svelte';

export interface FieldPolicyCatalogComponentProps {
  page: FieldPolicySettingsCatalogPage;
  baseUrl: string;
  detail: Snippet<[{ item: FieldPolicyDetailItem }]>;
  preservedParams?: Record<string, string>;
  searchPlaceholder?: string;
}

export interface FieldPolicyControlPanelProps {
  data: FieldPolicySettingsCatalogData;
  adapter: FieldPolicyControlPanelAdapter;
  catalog: Component<FieldPolicyCatalogComponentProps>;
  baseUrl: string;
  permissions?: readonly string[];
  heading?: string;
  onchanged?: () => void;
  confirmAction?: (message: string) => boolean | Promise<boolean>;
}

let {
  data,
  adapter,
  catalog,
  baseUrl,
  permissions,
  heading = 'Field settings',
  onchanged,
  confirmAction,
}: FieldPolicyControlPanelProps = $props();

// Before client effects run (including SSR), render the server snapshot.
// Later mutations replace `audit`; prop changes continue to resync it below.
let audit = $state<FieldPolicyAuditSnapshot | null>(null);
let editorState = $state<FieldPolicyEditorState | null>(null);
let editorOpen = $state(false);
let loadingEditor = $state(false);
let busy = $state(false);
let error = $state<string | null>(null);
let generation = 0;

const Catalog = $derived(catalog);
const visibleAudit = $derived(audit ?? data.audit);
const canManage = $derived(
  visibleAudit.caller.canManageOrg &&
    (permissions === undefined || permissions.includes('fields.policy.manage')),
);
const selected = $derived(data.page.selected);
const decoratedPage = $derived(decorateCatalogPage(data.page, visibleAudit));
const preservedParams = $derived(fieldPolicyCatalogPreservedParams(data));

$effect(() => {
  data;
  audit = data.audit;
  editorState = null;
  editorOpen = false;
  error = null;
  void loadEditor();
});

async function loadEditor(): Promise<void> {
  if (!selected || !canManage) return;
  const token = ++generation;
  loadingEditor = true;
  try {
    const result = await adapter.load({ objectRef: selected.objectRef });
    if (token !== generation) return;
    if (isFieldPolicyEditorState(result, selected.objectRef)) {
      editorState = result;
    } else {
      error = editorStateErrorMessage(result);
    }
  } catch (cause) {
    if (token === generation)
      error =
        cause instanceof Error
          ? cause.message
          : 'Unable to load field settings.';
  } finally {
    if (token === generation) loadingEditor = false;
  }
}

async function refreshAudit(): Promise<boolean> {
  const refs = auditObjectRefs(data.page);
  try {
    audit = await adapter.loadAudit({ ...refs, includeDrift: true });
    return true;
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : 'Unable to refresh field settings.';
    return false;
  }
}

async function confirm(message: string): Promise<boolean> {
  if (confirmAction) return await confirmAction(message);
  return typeof window !== 'undefined' && window.confirm(message);
}

async function resetOrganization(): Promise<void> {
  if (!selected || busy) return;
  const ids = orgRowIdsForObject(visibleAudit, selected.objectRef);
  if (!ids.length) return;
  if (
    !(await confirm(
      'Reset every organization override for this object? This cannot be undone.',
    ))
  )
    return;
  busy = true;
  error = null;
  let changed = false;
  try {
    for (const id of ids) {
      await adapter.delete({ id });
      changed = true;
    }
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : 'Unable to reset organization overrides.';
  } finally {
    const refreshed = await refreshAudit();
    await loadEditor();
    if (changed && refreshed) onchanged?.();
    busy = false;
  }
}

async function prune(id: string): Promise<void> {
  if (busy) return;
  if (!(await confirm('Prune this stale policy row? This cannot be undone.')))
    return;
  busy = true;
  error = null;
  try {
    await adapter.delete({ id });
    if (await refreshAudit()) onchanged?.();
  } catch (cause) {
    error =
      cause instanceof Error ? cause.message : 'Unable to prune stale policy.';
  } finally {
    busy = false;
  }
}

async function editorMutated(): Promise<void> {
  if (await refreshAudit()) {
    await loadEditor();
    onchanged?.();
  }
}

function valueText(cell: FieldPolicyLayerCell): string {
  if (!cell.hasDefault) return 'No default';
  try {
    return JSON.stringify(cell.defaultValue) ?? 'undefined';
  } catch {
    return String(cell.defaultValue);
  }
}
</script>

{#if canManage}
  <section class="field-policy-control-panel" aria-label={heading}>
    <header>
      <h1>{heading}</h1>
      <p>Manage inherited defaults, visibility, help, labels, order, and locks for every registered field.</p>
    </header>
    {#if error}<p class="field-policy-control-panel__error" role="alert">{error}</p>{/if}
    <Catalog page={decoratedPage} {baseUrl} {preservedParams} searchPlaceholder="Search fields">
      {#snippet detail({ item }: { item: FieldPolicyDetailItem })}
        {@const rollup = fieldPolicyRollup(visibleAudit, item.objectRef, item.fieldName)}
        <article class="field-policy-control-panel__detail">
          <h2>{rollup.resolved?.label ?? item.label}</h2>
          <p>{rollup.resolved?.help ?? item.description ?? 'No help text.'}</p>
          <dl class="field-policy-control-panel__layers">
            <div><dt>Code {rollup.code.contributed ? 'override' : 'inherited'}</dt><dd><code>{valueText(rollup.code)}</code> · {rollup.code.visibility}{rollup.code.locked ? ' · locked' : ''}</dd></div>
            <div><dt>App {rollup.app.contributed ? 'override' : 'inherited'}</dt><dd><code>{valueText(rollup.app)}</code> · {rollup.app.visibility}{rollup.app.locked ? ' · locked' : ''}</dd></div>
            <div><dt>Organization {rollup.org.contributed ? 'override' : 'inherited'}</dt><dd><code>{valueText(rollup.org)}</code> · {rollup.org.visibility}{rollup.org.locked ? ' · locked' : ''}</dd></div>
            <div><dt>Users</dt><dd>{rollup.userCount} personal override{rollup.userCount === 1 ? '' : 's'}</dd></div>
          </dl>
          {#if rollup.orgRow}<p>Organization row last changed {rollup.orgRow.updatedAt ?? 'unknown'}{rollup.orgRow.updatedBy ? ` by ${rollup.orgRow.updatedBy}` : ''}.</p>{/if}
          {#if rollup.appRow}<p>App row is read-only{rollup.appRow.updatedBy ? ` (last changed by ${rollup.appRow.updatedBy})` : ''}.</p>{/if}
          <div class="field-policy-control-panel__actions">
            <Button type="button" disabled={busy || loadingEditor || !editorState} onclick={() => editorOpen = true}>Edit settings</Button>
            <Button type="button" variant="ghost" disabled={busy || orgRowIdsForObject(visibleAudit, item.objectRef).length === 0} onclick={resetOrganization}>Reset all organization overrides for this object</Button>
          </div>
        </article>
      {/snippet}
    </Catalog>
    {#if editorOpen && editorState && selected}
      <FieldPolicyEditor
        state={editorState}
        {adapter}
        fields={selected.fields}
        onclose={() => editorOpen = false}
        onmutated={editorMutated}
      />
    {/if}
    {#if prunableDriftRows(visibleAudit).length}
      <section class="field-policy-control-panel__drift" aria-label="Manifest drift">
        <h2>Manifest drift</h2>
        <p>These policy rows no longer match a registered field and are ignored by the resolver.</p>
        <ul>
          {#each prunableDriftRows(visibleAudit) as row (row.id)}
            <li><code>{row.objectRef}.{row.fieldName}</code> — {row.reason} <Button type="button" variant="ghost" disabled={busy} onclick={() => prune(row.id)}>Prune</Button></li>
          {/each}
        </ul>
      </section>
    {/if}
  </section>
{/if}

<style>
  .field-policy-control-panel { display: grid; gap: var(--smrt-spacing-4); }
  .field-policy-control-panel header p, .field-policy-control-panel__detail > p { color: var(--smrt-color-on-surface-variant); }
  .field-policy-control-panel__error { color: var(--smrt-color-error, #b42318); }
  .field-policy-control-panel__layers { display: grid; gap: var(--smrt-spacing-2); }
  .field-policy-control-panel__layers div { display: grid; grid-template-columns: 10rem minmax(0, 1fr); gap: var(--smrt-spacing-2); }
  .field-policy-control-panel__layers dt { font-weight: 600; }
  .field-policy-control-panel__layers dd { margin: 0; }
  .field-policy-control-panel__actions { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-2); }
  .field-policy-control-panel__drift ul { display: grid; gap: var(--smrt-spacing-2); padding-inline-start: var(--smrt-spacing-5); }
</style>
