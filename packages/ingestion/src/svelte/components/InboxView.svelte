<script lang="ts">
import { FilePicker, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy, onMount } from 'svelte';
import type {
  InboxEntry,
  InboxState,
  IntakeReviewHost,
} from '../../review-dto.js';
import { M } from '../i18n.js';
export interface Props {
  host: IntakeReviewHost;
  onselect?: (itemId: string) => void;
}
let { host, onselect }: Props = $props();
const { t } = useI18n();
const states: InboxState[] = [
  'processing',
  'unresolved',
  'waiting',
  'failed',
  'deferred',
  'partially_completed',
  'completed',
];
let items = $state<InboxEntry[]>([]),
  selectedState = $state(''),
  assignee = $state(''),
  assignments = $state<Record<string, string>>({}),
  files = $state<File[]>([]),
  cursor = $state<string>(),
  pending = $state(false),
  error = $state(false);
let alive = true,
  epoch = 0;
onDestroy(() => {
  alive = false;
  epoch++;
});
async function load(more = false) {
  const ticket = ++epoch;
  pending = true;
  error = false;
  const prior = more ? items : [];
  const next = more ? cursor : undefined;
  items = [];
  assignments = {};
  try {
    const page = await host.list({
      state: selectedState ? (selectedState as InboxState) : undefined,
      assigneeId: assignee || undefined,
      cursor: next,
    });
    if (!alive || ticket !== epoch) return;
    items = [...prior, ...page.items];
    cursor = page.nextCursor;
    assignments = Object.fromEntries(
      items.map((entry) => [entry.item.id, entry.assignment.assigneeId ?? '']),
    );
  } catch {
    if (alive && ticket === epoch) {
      items = [];
      cursor = undefined;
      error = true;
    }
  } finally {
    if (alive && ticket === epoch) pending = false;
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
    files = [];
    if (selected && result && typeof result === 'object' && 'itemId' in result)
      onselect?.(String(result.itemId));
    await load();
  } catch {
    if (alive && ticket === epoch) {
      items = [];
      assignments = {};
      files = [];
      error = true;
      pending = false;
    }
  }
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
<FilePicker bind:files multiple label={t(M['ingestion.files'])} description={t(M['ingestion.filesHelp'])} disabled={pending} />
<Button disabled={pending || !files.length} onclick={() => mutate(() => host.upload([...files],crypto.randomUUID()),true)}>{t(M['ingestion.upload'])}</Button>
{#if error}<p role="alert">{t(M['ingestion.error'])}</p>{/if}
{#if pending}<p role="status">{t(M['ingestion.loading'])}</p>{/if}
{#if !pending && !error && !items.length}<p>{t(M['ingestion.empty'])}</p>{/if}
<ul>{#each items as entry (entry.item.id)}<li>
<h2>{entry.label}</h2><p>{t(M[`ingestion.${entry.state}`])}</p>
<Button onclick={() => onselect?.(entry.item.id)} disabled={pending}>{t(M['ingestion.open'])}</Button>
<Input aria-label={`${t(M['ingestion.assignee'])}: ${entry.label}`} bind:value={assignments[entry.item.id]} disabled={pending} />
<Button disabled={pending} onclick={() => mutate(() => host.assign({itemId:entry.item.id,expectedVersion:entry.assignment.version,assigneeId:assignments[entry.item.id] || null,requestId:crypto.randomUUID()}))}>{t(M['ingestion.assign'])}</Button>
</li>{/each}</ul>
{#if cursor}<Button disabled={pending} onclick={() => load(true)}>{t(M['ingestion.more'])}</Button>{/if}
</section>
<style>
section{max-width:72rem;margin-inline:auto;padding:1rem;color:var(--smrt-color-on-surface,#222)}.toolbar{display:flex;flex-wrap:wrap;gap:.75rem;margin-block:1rem}ul{list-style:none;padding:0}li{padding:1rem;border-block-end:1px solid var(--smrt-color-outline-variant,#ccc);display:grid;gap:.75rem}h2{font-size:1.1rem}
</style>
