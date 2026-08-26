<script lang="ts">
import { untrack } from 'svelte';
import { M, useI18n } from '../../i18n/index.js';
import type {
  ControlCommand,
  ControlInteractionRegistry,
  ControlSnapshot,
} from './control-interaction.js';
import {
  executeLocalControlBatch,
  executeLocalControlCommand,
} from './control-interaction.js';
import type { StagedControlReviewLabels } from './staged-control-review.js';

const { t } = useI18n();

export interface Props {
  registry: ControlInteractionRegistry;
  formId: string;
  formElement?: HTMLFormElement | null;
  summary?: boolean;
  labels?: Partial<StagedControlReviewLabels>;
}

let {
  registry,
  formId,
  formElement = null,
  summary = true,
  labels,
}: Props = $props();
const text = $derived({
  region: t(M['ui.staged_control_review.region']),
  heading: t(M['ui.staged_control_review.heading']),
  description: t(M['ui.staged_control_review.description']),
  proposedBy: t(M['ui.staged_control_review.proposed_by']),
  stagedAt: t(M['ui.staged_control_review.staged_at']),
  before: t(M['ui.staged_control_review.before']),
  after: t(M['ui.staged_control_review.after']),
  redacted: t(M['ui.staged_control_review.redacted']),
  stale: t(M['ui.staged_control_review.stale']),
  invalid: t(M['ui.staged_control_review.invalid']),
  apply: t(M['ui.staged_control_review.apply']),
  discard: t(M['ui.staged_control_review.discard']),
  applyAll: t(M['ui.staged_control_review.apply_all']),
  discardAll: t(M['ui.staged_control_review.discard_all']),
  edit: t(M['ui.staged_control_review.edit']),
  appliedStatus: t(M['ui.staged_control_review.applied_status']),
  discardedStatus: t(M['ui.staged_control_review.discarded_status']),
  batchStatus: t(M['ui.staged_control_review.batch_status']),
  ...labels,
});
let snapshots = $state<ControlSnapshot[]>([]);
let drafts = $state<Record<string, string>>({});
let status = $state('');

const keyOf = (snapshot: ControlSnapshot) =>
  `${snapshot.identity.formId}\u0000${snapshot.identity.controlId}`;

function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function refresh(): void {
  const nextSnapshots = registry
    .list(formId)
    .filter((snapshot) => snapshot.state.staged !== undefined);
  const next = { ...untrack(() => drafts) };
  for (const snapshot of nextSnapshots) {
    const key = keyOf(snapshot);
    if (!(key in next) && !snapshot.state.staged?.valueRedacted) {
      next[key] = formatValue(snapshot.state.staged?.value);
    }
  }
  const live = new Set(nextSnapshots.map(keyOf));
  for (const key of Object.keys(next)) {
    if (!live.has(key)) delete next[key];
  }
  snapshots = nextSnapshots;
  drafts = next;
}

$effect(() => {
  refresh();
  return registry.subscribe(() => refresh());
});

$effect(() => {
  if (!formElement) return;
  const element = formElement;
  const refreshAfterFieldEdit = () => refresh();
  const discardAfterReset = (event: Event) => {
    const commands = registry
      .list(formId)
      .filter((snapshot) => snapshot.state.staged)
      .map((snapshot) => ({
        action: 'discard' as const,
        identity: snapshot.identity,
        revision: snapshot.state.staged?.revision,
      }));
    void executeLocalControlBatch(registry, commands, event);
  };
  element.addEventListener('input', refreshAfterFieldEdit);
  element.addEventListener('change', refreshAfterFieldEdit);
  element.addEventListener('reset', discardAfterReset);
  return () => {
    element.removeEventListener('input', refreshAfterFieldEdit);
    element.removeEventListener('change', refreshAfterFieldEdit);
    element.removeEventListener('reset', discardAfterReset);
  };
});

$effect(() => {
  if (!formElement) return;
  const stagedIds = new Set(
    snapshots.map((snapshot) => snapshot.identity.controlId),
  );
  const controls = formElement.querySelectorAll<HTMLElement>(
    '[data-smrt-control]',
  );
  for (const control of controls) {
    if (stagedIds.has(control.dataset.smrtControl ?? '')) {
      control.dataset.smrtStaged = 'true';
    } else {
      delete control.dataset.smrtStaged;
    }
  }
  return () => {
    for (const control of controls) delete control.dataset.smrtStaged;
  };
});

function editedValue(snapshot: ControlSnapshot): unknown {
  const staged = snapshot.state.staged;
  if (!staged || staged.valueRedacted) return staged?.value;
  const draft = drafts[keyOf(snapshot)] ?? '';
  const original = staged.value;
  if (typeof original === 'number') {
    const number = Number(draft);
    if (!Number.isFinite(number)) throw new Error('invalid_number');
    return number;
  }
  if (typeof original === 'boolean') return draft === 'true';
  if (original !== null && typeof original === 'object')
    return JSON.parse(draft);
  return draft;
}

function commandFor(
  snapshot: ControlSnapshot,
  action: 'apply' | 'discard',
): ControlCommand {
  const revision = snapshot.state.staged?.revision;
  if (action === 'discard')
    return { action, identity: snapshot.identity, revision };
  return {
    action,
    identity: snapshot.identity,
    revision,
    value: editedValue(snapshot),
  };
}

async function applyOne(
  snapshot: ControlSnapshot,
  event: MouseEvent,
): Promise<void> {
  try {
    const result = await executeLocalControlCommand(
      registry,
      commandFor(snapshot, 'apply'),
      event,
    );
    status = result.ok ? text.appliedStatus : (result.reason ?? text.invalid);
  } catch {
    status = text.invalid;
  }
}

async function discardOne(
  snapshot: ControlSnapshot,
  event: MouseEvent,
): Promise<void> {
  const result = await executeLocalControlCommand(
    registry,
    commandFor(snapshot, 'discard'),
    event,
  );
  status = result.ok ? text.discardedStatus : (result.reason ?? text.stale);
}

async function applyAll(event: MouseEvent): Promise<void> {
  const eligible = snapshots.filter(
    (snapshot) =>
      !snapshot.state.staged?.stale && snapshot.state.staged?.valid !== false,
  );
  const commands: ControlCommand[] = [];
  for (const snapshot of eligible) {
    try {
      commands.push(commandFor(snapshot, 'apply'));
    } catch {
      // An invalid edit is reported by omission and remains staged for review.
    }
  }
  const batch = await executeLocalControlBatch(registry, commands, event);
  const completed = batch.results.filter((result) => result.ok).length;
  status = text.batchStatus
    .replace('{completed}', String(completed))
    .replace('{total}', String(snapshots.length));
}

async function discardAll(event: MouseEvent): Promise<void> {
  const eligible = snapshots.filter(
    (snapshot) =>
      !snapshot.state.staged?.stale && snapshot.state.staged?.valid !== false,
  );
  const batch = await executeLocalControlBatch(
    registry,
    eligible.map((snapshot) => commandFor(snapshot, 'discard')),
    event,
  );
  const completed = batch.results.filter((result) => result.ok).length;
  status = text.batchStatus
    .replace('{completed}', String(completed))
    .replace('{total}', String(snapshots.length));
}
</script>

{#if summary && snapshots.length > 0}
  <section class="staged-review" aria-label={text.region}>
    <header>
      <div>
        <h2>{text.heading}</h2>
        <p>{text.description}</p>
      </div>
      <div class="batch-actions">
        <button type="button" onclick={applyAll}>{text.applyAll}</button>
        <button type="button" class="secondary" onclick={discardAll}>{text.discardAll}</button>
      </div>
    </header>

    <ul>
      {#each snapshots as snapshot (keyOf(snapshot))}
        {@const staged = snapshot.state.staged}
        {@const label = snapshot.metadata.label ?? snapshot.identity.controlId}
        <li class:stale={staged?.stale} class:invalid={staged?.valid === false}>
          <div class="proposal-heading">
            <div><strong>{label}</strong><code>{snapshot.identity.formId}/{snapshot.identity.controlId}</code></div>
            <span>{text.proposedBy} {staged?.provenance.actorId ?? staged?.provenance.source} · {text.stagedAt} {staged ? new Date(staged.stagedAt).toLocaleString() : ''}</span>
          </div>
          <dl>
            <div><dt>{text.before}</dt><dd>{snapshot.state.valueRedacted ? text.redacted : formatValue(snapshot.state.value)}</dd></div>
            <div>
              <dt>{text.after}</dt>
              <dd>
                {#if staged?.valueRedacted}
                  {text.redacted}
                {:else}
                  <input
                    aria-label={`${text.edit} ${label}`}
                    value={drafts[keyOf(snapshot)] ?? ''}
                    oninput={(event) => {
                      drafts = { ...drafts, [keyOf(snapshot)]: event.currentTarget.value };
                    }}
                  />
                {/if}
              </dd>
            </div>
          </dl>
          {#if staged?.stale}<p class="problem" role="alert">{text.stale}</p>{/if}
          {#if staged?.valid === false}<p class="problem" role="alert">{staged.validationMessage ?? text.invalid}</p>{/if}
          <div class="item-actions">
            <button type="button" disabled={staged?.stale || staged?.valid === false} onclick={(event) => applyOne(snapshot, event)}>{text.apply}</button>
            <button type="button" class="secondary" onclick={(event) => discardOne(snapshot, event)}>{text.discard}</button>
          </div>
        </li>
      {/each}
    </ul>
    <p class="status" role="status" aria-live="polite">{status}</p>
  </section>
{/if}

<style>
  .staged-review { margin-block-start: var(--smrt-spacing-5, 1.25rem); padding: var(--smrt-spacing-4, 1rem); color: var(--smrt-color-on-surface, #1f2937); background: var(--smrt-color-surface-container-low, #f8fafc); border: 1px solid var(--smrt-color-outline-variant, #cbd5e1); border-inline-start: 4px solid var(--smrt-color-tertiary, #7d5260); border-radius: var(--smrt-radius-medium, .5rem); }
  header, .proposal-heading, .batch-actions, .item-actions { display: flex; align-items: center; gap: var(--smrt-spacing-2, .5rem); }
  header { justify-content: space-between; align-items: flex-start; gap: var(--smrt-spacing-4, 1rem); }
  h2, p { margin: 0; } h2 { font: var(--smrt-typography-title-medium-font, 600 1rem/1.4 system-ui); }
  header p, .proposal-heading span, .proposal-heading code, dt { color: var(--smrt-color-on-surface-variant, #475569); font-size: .875rem; }
  .proposal-heading strong, .proposal-heading code { display: block; }
  ul { display: grid; gap: var(--smrt-spacing-3, .75rem); padding: 0; list-style: none; }
  li { padding: var(--smrt-spacing-3, .75rem); background: var(--smrt-color-surface, #fff); border: 1px solid var(--smrt-color-outline-variant, #cbd5e1); border-radius: var(--smrt-radius-small, .375rem); }
  li.stale, li.invalid { border-color: var(--smrt-color-error, #b3261e); }
  .proposal-heading { justify-content: space-between; }
  dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--smrt-spacing-3, .75rem); }
  dt { font-weight: 600; } dd { margin: .25rem 0 0; overflow-wrap: anywhere; }
  input { width: 100%; box-sizing: border-box; padding: .4rem .5rem; color: inherit; background: var(--smrt-color-surface, #fff); border: 1px solid var(--smrt-color-outline, #64748b); border-radius: var(--smrt-radius-small, .375rem); }
  button { min-height: 2.25rem; padding: .4rem .75rem; color: var(--smrt-color-on-primary, #fff); background: var(--smrt-color-primary, #005ac1); border: 1px solid transparent; border-radius: var(--smrt-radius-small, .375rem); cursor: pointer; }
  button.secondary { color: var(--smrt-color-primary, #005ac1); background: transparent; border-color: var(--smrt-color-outline, #64748b); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--smrt-color-primary, #005ac1); outline-offset: 2px; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  .item-actions { margin-block-start: var(--smrt-spacing-3, .75rem); }
  .problem { margin-block-start: var(--smrt-spacing-2, .5rem); color: var(--smrt-color-error, #b3261e); }
  .status:empty { display: none; }
  :global([data-smrt-staged='true']) { outline: 3px solid var(--smrt-color-tertiary, #7d5260); outline-offset: 3px; }
  @media (max-width: 40rem) { header, .proposal-heading { align-items: stretch; flex-direction: column; } dl { grid-template-columns: 1fr; } }
</style>
