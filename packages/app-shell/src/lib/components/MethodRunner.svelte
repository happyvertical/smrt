<script lang="ts">
import { invalidate } from '$app/navigation';
import { ApiError, runMethodTool } from '$lib/ui/api';
import { DEPENDS } from '$lib/ui/events';
import type { FormValues } from '$lib/ui/fields';
import {
  fieldSpec,
  humanize,
  initialValues,
  serializeForm,
} from '$lib/ui/fields';
import type { MethodInfo } from '$lib/ui/types';
import FieldInput from './FieldInput.svelte';

interface Props {
  className: string;
  name: string;
  method: MethodInfo;
  /** The record the method runs on; null runs it on the model. */
  recordId?: string | null;
}

let { className, name, method, recordId = null }: Props = $props();

const uid = `m-${Math.random().toString(36).slice(2, 8)}`;
const paramDefs = $derived(
  Object.fromEntries(
    Object.entries(method.params).map(([k, p]) => [k, { ...p }]),
  ),
);
const specs = $derived(
  Object.entries(paramDefs).map(([k, d]) => fieldSpec(k, d)),
);
let values: FormValues = $state({});
let errors: Record<string, string> = $state({});
let busy = $state(false);
let failure = $state('');
let outcome: { text: string; applied?: number } | null = $state(null);

$effect(() => {
  values = initialValues(paramDefs);
});

async function run(event: SubmitEvent) {
  event.preventDefault();
  failure = '';
  outcome = null;
  const { data, errors: found } = serializeForm(paramDefs, values);
  errors = found;
  if (Object.keys(found).length) return;
  const args: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (v !== null) args[k] = v;
  if (recordId) args.id = recordId;
  busy = true;
  try {
    const r = await runMethodTool(className, name, args);
    if (r.isError) {
      failure = r.text || 'The method failed.';
    } else {
      const shown =
        r.result === undefined ? r.text : JSON.stringify(r.result, null, 2);
      outcome = { text: shown, applied: r.applied };
      await invalidate(DEPENDS.records);
    }
  } catch (e) {
    failure = e instanceof ApiError ? e.message : 'The method failed.';
  } finally {
    busy = false;
  }
}
</script>

<form class="sh-card method" onsubmit={run} novalidate>
  <p class="label"><strong>{humanize(name)}</strong></p>
  {#if method.description}<p class="sh-muted">{method.description}</p>{/if}
  {#each specs as spec (spec.name)}
    <FieldInput
      id="{uid}-{spec.name}"
      {spec}
      bind:value={values[spec.name]}
      error={errors[spec.name]}
      disabled={busy}
    />
  {/each}
  <button type="submit" class="sh-btn sh-btn-small" disabled={busy}>
    {busy ? 'Running…' : `Run ${humanize(name).toLowerCase()}`}
  </button>
  <div aria-live="polite">
    {#if failure}<p class="sh-alert sh-alert-error" role="alert">{failure}</p>{/if}
    {#if outcome}
      <p class="sh-alert sh-alert-ok">
        Done{#if outcome.applied} · {outcome.applied}
          {outcome.applied === 1 ? 'change' : 'changes'} saved{/if}.
      </p>
      {#if outcome.text && outcome.text !== 'null'}
        <!-- svelte-ignore a11y_no_noninteractive_tabindex (keyboard scrolling of long output) -->
        <pre class="sh-code" tabindex="0">{outcome.text}</pre>
      {/if}
    {/if}
  </div>
</form>

<style>
  .method {
    margin-block-start: var(--smrt-spacing-md, 0.75rem);
  }
  .label {
    margin: 0;
  }
</style>
