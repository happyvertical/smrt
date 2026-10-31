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
import { uploadRefusalMessage } from '../upload-refusal.js';
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
  /**
   * The displayed rows after every settled load or page append (not after
   * `patch`, which returns them), whether more pages exist, and the entries
   * exactly as the page read returned them (`appended` for Load more), absent
   * when the read failed.
   */
  onitems?: (
    items: InboxEntry[],
    more: boolean,
    page?: { entries: InboxEntry[]; appended: boolean; issued?: number },
  ) => void;
  /** Called before a page request so a workspace can order concurrent follow reads. */
  onreadstart?: () => void;
  /** A row's status text; the listed inbox state is shown when omitted or undefined. */
  status?: (entry: InboxEntry) => string | undefined;
  /** Show the per-row "Handled, no action" control (a workspace resolves in its item pane). */
  resolveInRow?: boolean;
  /** Numbers each page read when its request starts (`issued` on the page). */
  stamp?: () => number;
  /**
   * File types the picker offers (the input's `accept`, e.g.
   * `application/pdf,image/*`); defaults to the host's `uploadAccept`. A hint
   * only: the host's upload still enforces its own allowlist.
   */
  accept?: string;
}
let {
  host,
  onselect,
  rowAside,
  selectedId,
  onitems,
  onreadstart,
  status,
  resolveInRow = true,
  stamp,
  accept,
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
  error = $state(false),
  // The host's reviewer-facing reason for refusing the last upload, if any.
  refusal = $state<string>();
let alive = true,
  epoch = 0;
let uploadRequestId: string | undefined;
// The filter the displayed rows were listed under (the inputs may have been
// edited since); `patch` keeps a row only while it still matches it.
let listed: { state?: InboxState; assigneeId?: string } = {};
function publish(page?: {
  entries: InboxEntry[];
  appended: boolean;
  issued?: number;
}) {
  onitems?.($state.snapshot(items) as InboxEntry[], !!cursor, page);
}
/**
 * Replace one displayed row with a fresher entry for the same item (item and
 * state; the assignment only when its version is newer), keeping its listed
 * label and preview: `load` entries
 * carry no preview and a host may label them differently. Unless `keep` is
 * set, a row that no longer matches the listed filter leaves the list. Rows
 * that are not displayed are never added. Returns the displayed rows.
 */
export function patch(entry: InboxEntry, keep = false): InboxEntry[] {
  const index = items.findIndex((row) => row.item.id === entry.item.id);
  if (index < 0) return $state.snapshot(items) as InboxEntry[];
  const previous = items[index];
  // Assignment is versioned (the host's compare-and-set): an entry carrying
  // an older or equal version never replaces the row's, so a view loaded
  // before an assignment cannot roll the row (and the next expected version)
  // back.
  const newer = entry.assignment.version > previous.assignment.version;
  const assignment = newer ? entry.assignment : previous.assignment;
  const matches =
    (!listed.state || entry.state === listed.state) &&
    (!listed.assigneeId || assignment.assigneeId === listed.assigneeId);
  if (keep || matches) {
    const evidence = previous.evidence;
    items[index] = {
      item: entry.item,
      label: previous.label,
      state: entry.state,
      assignment: $state.snapshot(assignment),
      ...(evidence ? { evidence } : {}),
    };
    // An unsaved assignee the reviewer typed survives unless the durable
    // assignment itself changed.
    if (newer) assignments[entry.item.id] = assignment.assigneeId ?? '';
  } else items = items.filter((row) => row.item.id !== entry.item.id);
  return $state.snapshot(items) as InboxEntry[];
}
/**
 * Append the next page, if any. Resolves with the displayed rows and what
 * happened: `appended` (or `none` when there is no further page), `pending`
 * when another read was in flight or superseded this one (nothing was
 * appended), or `failed` when the page read failed (the list failed closed
 * and its rows were cleared).
 */
export async function more(): Promise<{
  items: InboxEntry[];
  result: 'appended' | 'none' | 'pending' | 'failed';
}> {
  let result: 'appended' | 'none' | 'pending' | 'failed';
  if (pending) result = 'pending';
  else if (!cursor) result = 'none';
  else {
    const read = await load(true);
    result =
      read === 'shown' ? 'appended' : read === 'failed' ? 'failed' : 'pending';
  }
  return { items: $state.snapshot(items) as InboxEntry[], result };
}
onDestroy(() => {
  alive = false;
  epoch++;
  files = [];
  uploadRequestId = undefined;
});
/**
 * Resolves `shown` when this read's page was displayed, `failed` when it
 * failed (the rows were cleared), `superseded` when a newer read or the
 * component's end fenced it.
 */
async function load(more = false): Promise<'shown' | 'failed' | 'superseded'> {
  const ticket = ++epoch;
  onreadstart?.();
  pending = true;
  error = false;
  let page:
    | { entries: InboxEntry[]; appended: boolean; issued?: number }
    | undefined;
  const next = more ? cursor : undefined;
  // The displayed rows stay (controls disabled while pending) until the new
  // page arrives, so a workspace can keep patching and navigating them; a
  // failed read still clears them.
  const filter = more
    ? listed
    : {
        state: selectedState ? (selectedState as InboxState) : undefined,
        assigneeId: assignee || undefined,
      };
  try {
    const issued = stamp?.();
    const read = await host.list({ ...filter, cursor: next });
    if (!alive || ticket !== epoch) return 'superseded';
    listed = filter;
    // An appended page builds on the rows as displayed now (patches made
    // while it loaded included); a row already shown is not repeated.
    const shown = new Set(more ? items.map((entry) => entry.item.id) : []);
    const added = read.items.filter((entry) => !shown.has(entry.item.id));
    page = {
      entries: $state.snapshot(more ? added : read.items) as InboxEntry[],
      appended: more,
      ...(issued !== undefined ? { issued } : {}),
    };
    const kept = more ? { assignments, reasons } : undefined;
    items = more ? [...items, ...added] : read.items;
    cursor = read.nextCursor;
    assignments = Object.fromEntries(
      items.map((entry) => [
        entry.item.id,
        kept?.assignments[entry.item.id] ?? entry.assignment.assigneeId ?? '',
      ]),
    );
    reasons = Object.fromEntries(
      items.map((entry) => [entry.item.id, kept?.reasons[entry.item.id] ?? '']),
    );
  } catch {
    // Any failed read, Load more included, fails closed: the host cannot say
    // whether it was transient or a revoked grant.
    if (alive && ticket === epoch) {
      items = [];
      assignments = {};
      reasons = {};
      cursor = undefined;
      error = true;
    }
  } finally {
    if (alive && ticket === epoch) {
      pending = false;
      publish(page);
    }
  }
  return page ? 'shown' : alive && ticket === epoch ? 'failed' : 'superseded';
}
async function mutate(
  operation: () => Promise<unknown>,
  selected = false,
  refused?: (error: unknown) => string | undefined,
) {
  if (pending) return;
  pending = true;
  error = false;
  refusal = undefined;
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
  } catch (caught) {
    if (alive && ticket === epoch) {
      // A host refusal with a reviewer-facing reason (a file type its
      // allowlist refuses, say) is not an access result: the reason shows and
      // the listed rows stay. Anything else fails closed.
      const reason = refused?.(caught);
      if (reason) {
        refusal = reason;
        pending = false;
        return;
      }
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
  await mutate(
    () => host.upload(originals, requestId),
    true,
    uploadRefusalMessage,
  );
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
<FilePicker bind:files onclick={(event) => { event.currentTarget.value = ''; }} onchangefiles={() => { uploadRequestId = undefined; refusal = undefined; }} accept={accept ?? host.uploadAccept} multiple label={t(M['ingestion.files'])} description={t(M['ingestion.filesHelp'])} disabled={pending} />
<Button disabled={pending || !files.length} onclick={upload}>{t(M['ingestion.upload'])}</Button>
{#if error}<p role="alert">{t(M['ingestion.error'])}</p>{/if}
{#if refusal}<p role="alert" data-testid="upload-refused">{refusal}</p>{/if}
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
