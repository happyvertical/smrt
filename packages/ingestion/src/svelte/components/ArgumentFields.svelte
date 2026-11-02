<script lang="ts">
import {
  Checkbox,
  Combobox,
  Input,
  Select,
  Textarea,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { onDestroy } from 'svelte';
import type {
  ProposalCandidate,
  ProposalCatalogEntry,
} from '../../proposal-dto.js';
import type { IntakeReviewHost } from '../../review-dto.js';
import {
  type ArgumentField,
  argumentFields,
  localDateTime,
} from '../argument-fields.js';
import { M } from '../i18n.js';
import { argumentsObject } from '../view-utils.js';
export interface Props {
  /** The arguments draft as JSON text (bindable); the fields edit it in place. */
  value: string;
  /** Accessible name of the JSON textarea. */
  label: string;
  /** The handler whose `argsSchema`/`references` shape the fields; JSON only when absent. */
  catalog?: ProposalCatalogEntry;
  /** Candidates already known (the generation's offer), for reference labels. */
  candidates?: readonly ProposalCandidate[];
  /** Originals an evidence reference may name. */
  evidence?: ReadonlyArray<{ id: string; label: string }>;
  readonly?: boolean;
  rows?: number;
  host: IntakeReviewHost;
  itemId: string;
  /** A failed candidate search fails closed: the owning view discards its payloads. */
  deny: () => void;
}
let {
  value = $bindable(),
  label,
  catalog,
  candidates = [],
  evidence = [],
  readonly = false,
  rows = 8,
  host,
  itemId,
  deny,
}: Props = $props();
const { t } = useI18n();
const fields = $derived(
  catalog ? argumentFields(catalog.argsSchema, catalog.references) : [],
);
const parsed = $derived.by((): Record<string, unknown> | undefined => {
  try {
    return argumentsObject(value);
  } catch {
    return undefined;
  }
});
// Labels of candidates seen in this editor (searched or offered), by model and id.
let found = $state<Record<string, ProposalCandidate[]>>({}),
  known = $state<Record<string, string>>({}),
  searching = $state<Record<string, boolean>>({});
let alive = true;
// Newest search per field; an older answer is dropped.
const searches: Record<string, number> = {};
onDestroy(() => {
  alive = false;
});
function candidateLabel(model: string, id: unknown): string | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  return (
    known[`${model}:${id}`] ??
    candidates.find((entry) => entry.model === model && entry.id === id)?.label
  );
}
function set(name: string, next: unknown) {
  if (!parsed) return;
  const draft = { ...parsed };
  if (next === undefined) delete draft[name];
  else draft[name] = next;
  value = JSON.stringify(draft, null, 2);
}
async function search(
  field: ArgumentField & { kind: 'candidate' },
  query: string,
) {
  if (!catalog) return;
  const ticket = (searches[field.name] ?? 0) + 1;
  searches[field.name] = ticket;
  searching[field.name] = true;
  try {
    const page = await host.candidates({
      itemId,
      handlerId: catalog.id,
      handlerVersion: catalog.version,
      query,
    });
    if (!alive || ticket !== searches[field.name]) return;
    const matches = page.items.filter((entry) => entry.model === field.model);
    found[field.name] = matches;
    for (const entry of matches)
      known[`${entry.model}:${entry.id}`] = entry.label;
  } catch {
    if (alive) deny();
  } finally {
    if (alive && ticket === searches[field.name]) searching[field.name] = false;
  }
}
function choose(field: ArgumentField & { kind: 'candidate' }, id: string) {
  // Only an id from the authorized page (or the current value) is accepted.
  if (!id) return set(field.name, undefined);
  if (
    found[field.name]?.some((entry) => entry.id === id) ||
    candidates.some((entry) => entry.model === field.model && entry.id === id)
  )
    set(field.name, id);
}
function number(field: ArgumentField, text: string) {
  if (!text.trim()) return set(field.name, undefined);
  const next = Number(text);
  if (!Number.isFinite(next)) return;
  if (field.kind === 'integer' && !Number.isSafeInteger(next)) return;
  set(field.name, next);
}
function text(input: unknown): string {
  return typeof input === 'string' || typeof input === 'number'
    ? String(input)
    : '';
}
</script>
{#if fields.length}
<fieldset class="argument-fields" data-testid="argument-fields" disabled={readonly}>
<legend>{t(M['ingestion.fields'])}</legend>
{#if !parsed}<p role="status">{t(M['ingestion.fieldsUnavailable'])}</p>{/if}
{#each fields as field (field.name)}
{@const current = parsed?.[field.name]}
{@const name = field.required ? `${field.title} *` : field.title}
<div class="field" data-field={field.name}>
{#if field.kind === 'candidate'}
{@const options = (found[field.name] ?? []).map((entry) => ({ value: entry.id, label: entry.label }))}
<Combobox label={name} {options} value={text(current)} valueLabel={candidateLabel(field.model, current) ?? text(current)} filter={false} disabled={readonly || !parsed} busy={!!searching[field.name]} status={searching[field.name] ? t(M['ingestion.searching']) : options.length ? undefined : t(M['ingestion.noMatches'])} onquery={(query) => search(field, query)} onvaluechange={(id) => choose(field, id)} />
{:else if field.kind === 'boolean'}
<Checkbox label={name} checked={current === true} disabled={readonly || !parsed} onchange={(event) => set(field.name, (event.currentTarget as HTMLInputElement).checked)} />
{:else if field.kind === 'enum'}
<Select aria-label={name} value={text(current)} disabled={readonly || !parsed} onchange={(event) => { const chosen = (event.currentTarget as HTMLSelectElement).value; set(field.name, chosen === '' ? undefined : field.options.find((option) => String(option) === chosen)); }}><option value="">{t(M['ingestion.unset'])}</option>{#each field.options as option (option)}<option value={String(option)}>{option}</option>{/each}</Select>
{:else if field.kind === 'evidence' && evidence.length}
<Select aria-label={name} value={text(current)} disabled={readonly || !parsed} onchange={(event) => { const chosen = (event.currentTarget as HTMLSelectElement).value; set(field.name, chosen || undefined); }}><option value="">{t(M['ingestion.unset'])}</option>{#each evidence as part (part.id)}<option value={part.id}>{part.label}</option>{/each}</Select>
{:else if field.kind === 'number' || field.kind === 'integer'}
<Input type="number" aria-label={name} value={text(current)} step={field.kind === 'integer' ? 1 : 'any'} min={field.minimum} max={field.maximum} disabled={readonly || !parsed} oninput={(event) => number(field, (event.currentTarget as HTMLInputElement).value)} />
{:else if field.kind === 'date'}
<Input type="date" aria-label={name} value={text(current)} disabled={readonly || !parsed} oninput={(event) => { const chosen = (event.currentTarget as HTMLInputElement).value; set(field.name, chosen || undefined); }} />
{:else if field.kind === 'date-time'}
<Input type="datetime-local" aria-label={name} value={localDateTime(current)} disabled={readonly || !parsed} oninput={(event) => { const chosen = (event.currentTarget as HTMLInputElement).value; const at = chosen ? new Date(chosen) : undefined; if (at && Number.isNaN(at.getTime())) return; set(field.name, at?.toISOString()); }} />
{:else}
<Input aria-label={name} value={text(current)} maxlength={field.kind === 'text' ? field.maxLength : undefined} disabled={readonly || !parsed} oninput={(event) => { const chosen = (event.currentTarget as HTMLInputElement).value; set(field.name, chosen === '' ? undefined : chosen); }} />
{/if}
</div>
{/each}
</fieldset>
<details class="advanced" data-testid="advanced-arguments"><summary>{t(M['ingestion.advanced'])}</summary>
<Textarea aria-label={label} bind:value {readonly} {rows} />
</details>
{:else}
<Textarea aria-label={label} bind:value {readonly} {rows} />
{/if}
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
.argument-fields{display:grid;gap:.75rem;min-width:0;margin-block:.5rem}.field{min-width:0}.advanced{margin-block:.5rem}
}
</style>
