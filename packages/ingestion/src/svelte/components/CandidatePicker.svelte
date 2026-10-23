<script lang="ts">
import { Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onDestroy } from 'svelte';
import type {
  CandidatePage,
  ProposalCatalogEntry,
} from '../../proposal-dto.js';
import type { IntakeReviewHost } from '../../review-dto.js';
import { M } from '../i18n.js';
export interface Props {
  host: IntakeReviewHost;
  itemId: string;
  catalog: ProposalCatalogEntry;
  /** A failed search fails closed: the owning view discards its payloads. */
  deny: () => void;
  /** Called only with a declared candidate field and an id from the current authorized page. */
  onchoose: (field: string, id: string) => void;
}
let { host, itemId, catalog, deny, onchoose }: Props = $props();
const { t } = useI18n();
let query = $state(''),
  field = $state(''),
  candidates = $state<CandidatePage>(),
  searching = $state(false);
let alive = true;
onDestroy(() => {
  alive = false;
});
const fields = $derived(
  Object.entries(catalog.references)
    .filter(([, ref]) => ref.kind === 'candidate')
    .map(([name]) => name),
);
async function search() {
  if (searching) return;
  searching = true;
  candidates = undefined;
  try {
    const result = await host.candidates({
      itemId,
      handlerId: catalog.id,
      handlerVersion: catalog.version,
      query,
    });
    if (alive) candidates = result;
  } catch {
    if (alive) deny();
  } finally {
    if (alive) searching = false;
  }
}
function choose(id: string) {
  const ref = catalog.references[field];
  if (
    ref?.kind !== 'candidate' ||
    !candidates?.items.some(
      (candidate) => candidate.id === id && candidate.model === ref.model,
    )
  )
    return;
  onchoose(field, id);
}
</script>
{#if fields.length}
<h4>{t(M['ingestion.candidates'])}</h4>
<Select aria-label={t(M['ingestion.field'])} bind:value={field}><option value="">{t(M['ingestion.field'])}</option>{#each fields as name (name)}<option value={name}>{name}</option>{/each}</Select>
<Input aria-label={t(M['ingestion.query'])} bind:value={query} />
<Button onclick={search} disabled={searching}>{t(M['ingestion.search'])}</Button>
{#if candidates}<ul>{#each candidates.items as candidate (candidate.key)}<li>{candidate.label} <Button disabled={!field} onclick={() => choose(candidate.id)}>{t(M['ingestion.choose'])}</Button></li>{/each}</ul>{#if candidates.truncated}<p>{t(M['ingestion.truncated'])}</p>{/if}{/if}
{/if}
