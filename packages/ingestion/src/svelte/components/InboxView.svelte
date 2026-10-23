<script lang="ts">
import { FilePicker, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, onMount, type Snippet } from 'svelte';
import type {
  InboxEntry,
  InboxState,
  IntakeReviewHost,
} from '../../review-dto.js';
import { M } from '../i18n.js';
import { evidenceUrl } from '../view-utils.js';
export interface Props {
  host: IntakeReviewHost;
  onselect?: (itemId: string) => void;
  /**
   * Optional per-row aside; without it a row shows the host's original
   * link/preview. Rendered in a plain `div`, not an `aside` landmark, so a
   * page of rows does not add one complementary landmark per row.
   */
  rowAside?: Snippet<[InboxEntry]>;
  /** The row a workspace has open; marked `aria-current`. */
  selectedId?: string;
  /** The displayed rows after every load, page append or patch, and whether more pages exist. */
  onitems?: (items: InboxEntry[], more: boolean) => void;
  /** A row's status text; the listed inbox state is shown when omitted or undefined. */
  status?: (entry: InboxEntry) => string | undefined;
  /** Show the per-row "Handled, no action" control (a workspace resolves in its item pane). */
  resolveInRow?: boolean;
}
let {
  host,
  onselect,
  rowAside,
  selectedId,
  onitems,
  status,
  resolveInRow = true,
}: Props = $props();
const { t } = useI18n();
const states: InboxState[] = [
  'processing',
  'unresolved',
  'waiting',
  'failed',
  'deferred',
  'partially_completed',
  'completed',
  'resolved',
];
let items = $state<InboxEntry[]>([]),
  selectedState = $state(''),
  assignee = $state(''),
  assignments = $state<Record<string, string>>({}),
  reasons = $state<Record<string, string>>({}),
  files = $state<File[]>([]),
  cursor = $state<string>(),
  pending = $state(false),
  error = $state(false);
let alive = true,
  epoch = 0;
let uploadRequestId: string | undefined;
// The filter the displayed rows were listed under (the inputs may have been
// edited since); `patch` keeps a row only while it still matches it.
let listed: { state?: InboxState; assigneeId?: string } = {};
function publish() {
  onitems?.($state.snapshot(items) as InboxEntry[], !!cursor);
}
/**
 * Replace one displayed row with a fresher entry for the same item (item,
 * state, assignment), keeping its listed label and preview: `load` entries
 * carry no preview and a host may label them differently. Unless `keep` is
 * set, a row that no longer matches the listed filter leaves the list. Rows
 * that are not displayed are never added. Returns the displayed rows.
 */
export function patch(entry: InboxEntry, keep = false): InboxEntry[] {
  const index = items.findIndex((row) => row.item.id === entry.item.id);
  if (index < 0) return $state.snapshot(items) as InboxEntry[];
  const matches =
    (!listed.state || entry.state === listed.state) &&
    (!listed.assigneeId || entry.assignment.assigneeId === listed.assigneeId);
  if (keep || matches) {
    const previous = items[index];
    const evidence = previous.evidence;
    items[index] = {
      item: entry.item,
      label: previous.label,
      state: entry.state,
      assignment: entry.assignment,
      ...(evidence ? { evidence } : {}),
    };
    // An unsaved assignee the reviewer typed survives unless the durable
    // assignment itself changed.
    if (entry.assignment.version !== previous.assignment.version)
      assignments[entry.item.id] = entry.assignment.assigneeId ?? '';
  } else items = items.filter((row) => row.item.id !== entry.item.id);
  publish();
  return $state.snapshot(items) as InboxEntry[];
}
/** Append the next page, if any; resolves with the displayed rows. */
export async function more(): Promise<InboxEntry[]> {
  if (cursor && !pending) await load(true);
  return $state.snapshot(items) as InboxEntry[];
}
onDestroy(() => {
  alive = false;
  epoch++;
  files = [];
  uploadRequestId = undefined;
});
async function load(more = false) {
  const ticket = ++epoch;
  pending = true;
  error = false;
  const prior = more ? items : [];
  const next = more ? cursor : undefined;
  items = [];
  assignments = {};
  reasons = {};
  const filter = more
    ? listed
    : {
        state: selectedState ? (selectedState as InboxState) : undefined,
        assigneeId: assignee || undefined,
      };
  try {
    const page = await host.list({ ...filter, cursor: next });
    if (!alive || ticket !== epoch) return;
    listed = filter;
    items = [...prior, ...page.items];
    cursor = page.nextCursor;
    assignments = Object.fromEntries(
      items.map((entry) => [entry.item.id, entry.assignment.assigneeId ?? '']),
    );
    reasons = Object.fromEntries(items.map((entry) => [entry.item.id, '']));
  } catch {
    if (alive && ticket === epoch) {
      items = [];
      cursor = undefined;
      error = true;
    }
  } finally {
    if (alive && ticket === epoch) {
      pending = false;
      publish();
    }
  }
}
async function mutate(operation: () => Promise<unknown>, selected = false) {
  if (pending) return;
  pending = true;
  error = false;
  const ticket = ++epoch;
  try {
    const result = await operation();
    if (!alive || ticket !== epoch) return;
    if (selected) {
      files = [];
      uploadRequestId = undefined;
    }
    if (selected && result && typeof result === 'object' && 'itemId' in result)
      onselect?.(String(result.itemId));
    await load();
  } catch {
    if (alive && ticket === epoch) {
      items = [];
      assignments = {};
      error = true;
      pending = false;
      publish();
    }
  }
}
async function upload() {
  if (pending || !files.length) return;
  uploadRequestId ??= crypto.randomUUID();
  const requestId = uploadRequestId;
  const originals = [...files];
  await mutate(() => host.upload(originals, requestId), true);
}
onMount(() => {
  void load();
});
</script>
<section data-testid="intake-inbox" aria-busy={pending}>
<h1>{t(M['ingestion.inbox'])}</h1>
<div class="toolbar">
<Select aria-label={t(M['ingestion.filter'])} bind:value={selectedState} disabled={pending} onchange={() => load()}><option value="">{t(M['ingestion.all'])}</option>{#each states as value}<option {value}>{t(M[`ingestion.${value}`])}</option>{/each}</Select>
<Input aria-label={t(M['ingestion.assignee'])} bind:value={assignee} disabled={pending} />
<Button onclick={() => load()} disabled={pending}>{t(M['ingestion.refresh'])}</Button>
</div>
<!-- Keep retry Files separately; an unchanged native FileList must not suppress a deliberate reselection. -->
<FilePicker bind:files onclick={(event) => { event.currentTarget.value = ''; }} onchangefiles={() => { uploadRequestId = undefined; }} multiple label={t(M['ingestion.files'])} description={t(M['ingestion.filesHelp'])} disabled={pending} />
<Button disabled={pending || !files.length} onclick={upload}>{t(M['ingestion.upload'])}</Button>
{#if error}<p role="alert">{t(M['ingestion.error'])}</p>{/if}
{#if pending}<p role="status">{t(M['ingestion.loading'])}</p>{/if}
{#if !pending && !error && !items.length}<p>{t(M['ingestion.empty'])}</p>{/if}
<ul>{#each items as entry (entry.item.id)}<li data-item-id={entry.item.id} aria-current={entry.item.id === selectedId ? 'true' : undefined} class:selected={entry.item.id === selectedId}>
<h2>{entry.label}</h2><p data-testid="row-status">{status?.(entry) ?? t(M[`ingestion.${entry.state}`])}</p>
{#if rowAside}<div class="row-aside">{@render rowAside(entry)}</div>{:else if entry.evidence}{@const original = evidenceUrl(entry.evidence.viewUrl)}{@const thumbnail = evidenceUrl(entry.evidence.thumbnailUrl)}{#if thumbnail || original}<div class="row-aside">
{#if thumbnail}<img src={thumbnail} alt={entry.evidence.label} loading="lazy" />{/if}
{#if original}<a href={original} target="_blank" rel="noopener noreferrer" aria-label={`${t(M['ingestion.original'])}: ${entry.label}`}>{t(M['ingestion.original'])}</a>{/if}
</div>{/if}{/if}
<Button onclick={() => onselect?.(entry.item.id)} disabled={pending}>{t(M['ingestion.open'])}</Button>
<Input aria-label={`${t(M['ingestion.assignee'])}: ${entry.label}`} bind:value={assignments[entry.item.id]} disabled={pending} />
<Button disabled={pending} onclick={() => mutate(() => host.assign({itemId:entry.item.id,expectedVersion:entry.assignment.version,assigneeId:assignments[entry.item.id] || null,requestId:crypto.randomUUID()}))}>{t(M['ingestion.assign'])}</Button>
{#if resolveInRow && host.resolve && !entry.item.disposition}
<Input aria-label={`${t(M['ingestion.resolveReason'])}: ${entry.label}`} bind:value={reasons[entry.item.id]} disabled={pending} />
<Button disabled={pending} onclick={() => { const close = host.resolve; const reason = reasons[entry.item.id]; if (close) void mutate(() => close({itemId:entry.item.id,disposition:'resolve_no_action',requestId:crypto.randomUUID(),...(reason ? { reason } : {})})); }}>{t(M['ingestion.resolveNoAction'])}</Button>
{/if}
</li>{/each}</ul>
{#if cursor}<Button disabled={pending} onclick={() => load(true)}>{t(M['ingestion.more'])}</Button>{/if}
</section>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
section{max-width:72rem;margin-inline:auto;padding:1rem;color:var(--smrt-color-on-surface)}.toolbar{display:flex;flex-wrap:wrap;gap:.75rem;margin-block:1rem}ul{list-style:none;padding:0}li{padding:1rem;border-block-end:var(--smrt-hairline);display:grid;gap:.75rem}li.selected{border-inline-start:.25rem solid var(--smrt-color-primary)}h2{font-size:1.1rem}.row-aside{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem}.row-aside img{max-block-size:6rem;max-inline-size:100%;object-fit:contain}
}
</style>
