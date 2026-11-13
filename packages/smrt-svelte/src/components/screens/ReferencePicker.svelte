<script lang="ts">
/** Manifest-driven adapter over the shared, keyboard accessible relation control. */
import { FormGroup, Input, RelationInput } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n/strings.screens.js';
import { screenRecordLabel } from './references.js';
import type {
  ScreenField,
  ScreenRecord,
  ScreenReferenceSource,
} from './types.js';

interface Props {
  field: ScreenField;
  target?: ScreenReferenceSource;
  value?: string;
  disabled?: boolean;
  error?: string;
}
let {
  field,
  target,
  value = $bindable(''),
  disabled = false,
  error,
}: Props = $props();
const { t } = useI18n();
const PAGE_SIZE = 25;
let hasMore = $state(false);
let offset = 0;
let query = '';
let generation = 0;
const unavailable = $derived(
  !target
    ? t(M['ui.screens.reference_missing_target'])
    : !target.source.search
      ? t(M['ui.screens.reference_missing_label'])
      : undefined,
);

function options(rows: readonly ScreenRecord[]) {
  return rows.flatMap((row) => {
    const id = row[target?.definition.idField ?? 'id'];
    const label = target
      ? screenRecordLabel(target.definition, row)
      : undefined;
    return (typeof id === 'string' || typeof id === 'number') && label
      ? [{ id: String(id), label }]
      : [];
  });
}
async function page(
  requestedQuery: string,
  requestedOffset: number,
  token: number,
) {
  const result = await target?.source.search?.({
    query: requestedQuery,
    offset: requestedOffset,
    limit: PAGE_SIZE,
  });
  if (token !== generation || !result) return [];
  offset = requestedOffset + result.rows.length;
  hasMore = result.hasMore;
  return options(result.rows);
}
async function search(next: string) {
  query = next;
  hasMore = false;
  return page(next, 0, ++generation);
}
async function resolve(id: string) {
  const row = await target?.source.get?.(id).catch(() => undefined);
  const label =
    row && target ? screenRecordLabel(target.definition, row) : undefined;
  return { id, label: label ?? t(M['ui.screens.reference_unavailable']) };
}
</script>

<div data-smrt-component="ReferencePicker">
  {#if unavailable}
    <FormGroup label={field.label} hint={unavailable} {error} required={field.required}>
      <Input name={field.name} disabled value={value ? t(M['ui.screens.reference_unavailable']) : ''} />
    </FormGroup>
    {#if !field.required && value}
      <Button variant="ghost" size="sm" {disabled} onclick={() => { value = ''; }}>
        {t(M['ui.screens.reference_clear'], { name: field.label })}
      </Button>
    {/if}
  {:else}
    <RelationInput name={field.name} label={field.label} bind:value {disabled} {error}
      required={field.required} description={field.help ?? undefined} {search} {resolve}
      loadMore={() => page(query, offset, generation)} {hasMore}
      placeholder={t(M['ui.screens.reference_search'], { name: field.label.toLowerCase() })}
      clearLabel={t(M['ui.screens.reference_clear'], { name: field.label })}
      loadingText={t(M['ui.screens.reference_loading'])}
      emptyText={t(M['ui.screens.reference_empty'])}
      errorText={t(M['ui.screens.reference_error'])}
      resultsText={(count) => t(M['ui.screens.reference_results'], { count })}
      moreLabel={t(M['ui.screens.reference_more'])} />
  {/if}
</div>
