<script lang="ts">
import { tick, untrack } from 'svelte';
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
let reviewActivated = $state(false);
let reviewElement = $state<HTMLElement | null>(null);

const keyOf = (snapshot: ControlSnapshot) =>
  JSON.stringify([
    snapshot.identity.formId,
    snapshot.identity.controlId,
    snapshot.identity.subject?.type ?? null,
    snapshot.identity.subject?.id ?? null,
  ]);

const draftKeyOf = (snapshot: ControlSnapshot) =>
  JSON.stringify([keyOf(snapshot), snapshot.state.staged?.revision ?? null]);

function formatValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatIdentity(snapshot: ControlSnapshot): string {
  const { formId, controlId, subject } = snapshot.identity;
  return subject
    ? `${formId}/${controlId} · ${subject.type}:${subject.id}`
    : `${formId}/${controlId}`;
}

function refresh(): void {
  const nextSnapshots = registry
    .list(formId)
    .filter((snapshot) => snapshot.state.staged !== undefined);
  if (nextSnapshots.length > 0) reviewActivated = true;
  const next = { ...untrack(() => drafts) };
  for (const snapshot of nextSnapshots) {
    const key = draftKeyOf(snapshot);
    if (!(key in next) && !snapshot.state.staged?.valueRedacted) {
      next[key] = formatValue(snapshot.state.staged?.value);
    }
  }
  const live = new Set(nextSnapshots.map(draftKeyOf));
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
  const refreshAfterReset = () => queueMicrotask(refresh);
  const discardAfterResetGesture = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const resetControl = target.closest<HTMLElement>(
      'button[type="reset"], input[type="reset"]',
    );
    if (!resetControl || !element.contains(resetControl)) return;
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
  element.addEventListener('reset', refreshAfterReset);
  element.addEventListener('click', discardAfterResetGesture, true);
  return () => {
    element.removeEventListener('input', refreshAfterFieldEdit);
    element.removeEventListener('change', refreshAfterFieldEdit);
    element.removeEventListener('reset', refreshAfterReset);
    element.removeEventListener('click', discardAfterResetGesture, true);
  };
});

// A control can become effectively disabled when an ancestor fieldset changes,
// even though the control's own attributes do not. Refresh the shared registry
// from the shared review component so base and Provider-backed Forms agree on
// the live DOM state. The review surface changes its own action-button state,
// so ignore its mutations to avoid observing our own rendering feedback.
$effect(() => {
  const element = formElement;
  const MutationObserverConstructor =
    element?.ownerDocument.defaultView?.MutationObserver;
  if (!element || !MutationObserverConstructor) return;
  const observer = new MutationObserverConstructor((records) => {
    if (
      records.some(
        ({ target }) =>
          target instanceof Element &&
          !target.closest('[data-staged-control-review]'),
      )
    ) {
      registry.refresh?.(formId);
    }
  });
  observer.observe(element, {
    attributes: true,
    subtree: true,
    attributeFilter: ['disabled', 'readonly'],
  });
  for (
    let ancestor = element.parentElement;
    ancestor;
    ancestor = ancestor.parentElement
  ) {
    if (ancestor instanceof HTMLFieldSetElement) {
      observer.observe(ancestor, {
        attributes: true,
        attributeFilter: ['disabled'],
      });
    }
  }
  return () => observer.disconnect();
});

$effect(() => {
  if (!formElement) return;
  const stagedKeys = new Set(
    snapshots.map((snapshot) =>
      JSON.stringify([
        snapshot.identity.controlId,
        snapshot.identity.subject?.type ?? null,
        snapshot.identity.subject?.id ?? null,
      ]),
    ),
  );
  const controls = formElement.querySelectorAll<HTMLElement>(
    '[data-smrt-control]',
  );
  controls.forEach((control) => {
    const controlKey = JSON.stringify([
      control.dataset.smrtControl ?? '',
      control.dataset.smrtSubjectType ?? null,
      control.dataset.smrtSubjectId ?? null,
    ]);
    if (stagedKeys.has(controlKey)) {
      control.dataset.smrtStaged = 'true';
    } else {
      delete control.dataset.smrtStaged;
    }
  });
  return () => {
    controls.forEach((control) => {
      delete control.dataset.smrtStaged;
    });
  };
});

function editedValue(snapshot: ControlSnapshot): unknown {
  const staged = snapshot.state.staged;
  if (!staged || staged.valueRedacted) return staged?.value;
  const draft = drafts[draftKeyOf(snapshot)] ?? '';
  const original = staged.value;
  if (typeof original === 'number') {
    if (draft.trim().length === 0) throw new Error('invalid_number');
    const number = Number(draft);
    if (!Number.isFinite(number)) throw new Error('invalid_number');
    return number;
  }
  if (typeof original === 'boolean') {
    if (draft !== 'true' && draft !== 'false') {
      throw new Error('invalid_boolean');
    }
    return draft === 'true';
  }
  if (original === null) return JSON.parse(draft);
  if (original !== null && typeof original === 'object')
    return JSON.parse(draft);
  return draft;
}

function failureStatus(reason?: string): string {
  return reason === 'staged_value_stale' || reason === 'stale_revision'
    ? text.stale
    : text.invalid;
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

function controlFor(snapshot: ControlSnapshot): HTMLElement | undefined {
  return Array.from(
    formElement?.querySelectorAll<HTMLElement>('[data-smrt-control]') ?? [],
  ).find(
    (control) =>
      control.dataset.smrtControl === snapshot.identity.controlId &&
      (control.dataset.smrtSubjectType ?? undefined) ===
        snapshot.identity.subject?.type &&
      (control.dataset.smrtSubjectId ?? undefined) ===
        snapshot.identity.subject?.id,
  );
}

async function restoreReviewFocus(
  removed: ControlSnapshot,
  removedIndex: number,
): Promise<void> {
  const originalControl = controlFor(removed);
  await tick();
  const focusOriginalControl = async () => {
    const focused = await registry.execute(
      { action: 'focus', identity: removed.identity },
      { source: 'user' },
    );
    const registryFocusedOriginal =
      focused.ok &&
      document.activeElement instanceof HTMLElement &&
      document.activeElement !== document.body &&
      formElement?.contains(document.activeElement) === true &&
      reviewElement?.contains(document.activeElement) !== true;
    if (registryFocusedOriginal) return;
    const directControl =
      originalControl &&
      !originalControl.matches(':disabled') &&
      originalControl.matches(
        'button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])',
      )
        ? originalControl
        : undefined;
    const focusableSelector =
      'button:not(:disabled), input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
    const candidates = [
      ...(directControl ? [directControl] : []),
      ...Array.from(
        originalControl?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ),
      ...Array.from(
        formElement?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
      ),
    ];
    for (const candidate of candidates) {
      candidate.focus();
      if (
        document.activeElement === candidate ||
        candidate.contains(document.activeElement)
      ) {
        return;
      }
    }
  };
  if (
    !registry
      .list(formId)
      .some((snapshot) => snapshot.state.staged !== undefined)
  ) {
    await focusOriginalControl();
    return;
  }
  const items = reviewElement?.querySelectorAll<HTMLElement>(
    '[data-staged-review-item]',
  );
  const target = items?.[Math.min(removedIndex, Math.max(0, items.length - 1))];
  const nextAction = target?.querySelector<HTMLButtonElement>(
    'button:not(:disabled)',
  );
  const fallback = reviewElement?.querySelector<HTMLButtonElement>(
    '.batch-actions button:not(:disabled)',
  );
  if (nextAction ?? fallback) {
    (nextAction ?? fallback)?.focus();
    return;
  }
  await focusOriginalControl();
}

async function applyOne(
  snapshot: ControlSnapshot,
  event: MouseEvent,
): Promise<void> {
  const removedIndex = snapshots.findIndex(
    (candidate) => keyOf(candidate) === keyOf(snapshot),
  );
  try {
    const result = await executeLocalControlCommand(
      registry,
      commandFor(snapshot, 'apply'),
      event,
    );
    status = result.ok ? text.appliedStatus : failureStatus(result.reason);
    if (result.ok) await restoreReviewFocus(snapshot, removedIndex);
  } catch {
    status = text.invalid;
  }
}

async function discardOne(
  snapshot: ControlSnapshot,
  event: MouseEvent,
): Promise<void> {
  const removedIndex = snapshots.findIndex(
    (candidate) => keyOf(candidate) === keyOf(snapshot),
  );
  const result = await executeLocalControlCommand(
    registry,
    commandFor(snapshot, 'discard'),
    event,
  );
  status = result.ok ? text.discardedStatus : failureStatus(result.reason);
  if (result.ok) await restoreReviewFocus(snapshot, removedIndex);
}

async function applyAll(event: MouseEvent): Promise<void> {
  const total = snapshots.length;
  const eligible = snapshots.filter(
    (snapshot) =>
      !snapshot.state.disabled &&
      !snapshot.state.readonly &&
      !snapshot.state.staged?.stale &&
      snapshot.state.staged?.valid !== false,
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
    .replace('{total}', String(total));
  if (completed > 0 && eligible[0]) await restoreReviewFocus(eligible[0], 0);
}

async function discardAll(event: MouseEvent): Promise<void> {
  const total = snapshots.length;
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
    .replace('{total}', String(total));
  if (completed > 0 && eligible[0]) await restoreReviewFocus(eligible[0], 0);
}
</script>

{#if summary && snapshots.length > 0}
  <section
    bind:this={reviewElement}
    class="staged-review"
    data-staged-control-review
    aria-label={text.region}
  >
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
        <li data-staged-review-item class:stale={staged?.stale} class:invalid={staged?.valid === false}>
          <div class="proposal-heading">
            <div><strong>{label}</strong><code>{formatIdentity(snapshot)}</code></div>
            <span>{text.proposedBy} {staged?.provenance.actorId ?? staged?.provenance.source} · {text.stagedAt} {staged ? new Date(staged.stagedAt).toLocaleString() : ''}</span>
          </div>
          <dl>
            <div><dt>{text.before}</dt><dd>{snapshot.state.valueRedacted ? text.redacted : formatValue(snapshot.state.value)}</dd></div>
            <div>
              <dt>{text.after}</dt>
              <dd>
                {#if staged?.valueRedacted}
                  {text.redacted}
                {:else if typeof staged?.value === 'boolean'}
                  <input
                    type="checkbox"
                    aria-label={`${text.edit} ${label}`}
                    checked={(drafts[draftKeyOf(snapshot)] ?? 'false') === 'true'}
                    onchange={(event) => {
                      drafts = {
                        ...drafts,
                        [draftKeyOf(snapshot)]: String(event.currentTarget.checked),
                      };
                    }}
                    onkeydown={(event) => {
                      if (event.key === 'Enter') event.preventDefault();
                    }}
                  />
                {:else}
                  <input
                    aria-label={`${text.edit} ${label}`}
                    value={drafts[draftKeyOf(snapshot)] ?? ''}
                    oninput={(event) => {
                      drafts = { ...drafts, [draftKeyOf(snapshot)]: event.currentTarget.value };
                    }}
                    onkeydown={(event) => {
                      if (event.key === 'Enter') event.preventDefault();
                    }}
                  />
                {/if}
              </dd>
            </div>
          </dl>
          {#if staged?.stale}<p class="problem" role="alert">{text.stale}</p>{/if}
          {#if staged?.valid === false}<p class="problem" role="alert">{staged.validationMessage ?? text.invalid}</p>{/if}
          <div class="item-actions">
            <button
              type="button"
              disabled={staged?.stale || snapshot.state.disabled || snapshot.state.readonly}
              onclick={(event) => applyOne(snapshot, event)}
            >{text.apply}</button>
            <button type="button" class="secondary" onclick={(event) => discardOne(snapshot, event)}>{text.discard}</button>
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}

{#if summary && reviewActivated}
  <p class="status visually-hidden" role="status" aria-live="polite" aria-atomic="true">{status}</p>
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
  input[type="checkbox"] { width: auto; }
  button { min-height: 2.25rem; padding: .4rem .75rem; color: var(--smrt-color-on-primary, #fff); background: var(--smrt-color-primary, #005ac1); border: 1px solid transparent; border-radius: var(--smrt-radius-small, .375rem); cursor: pointer; }
  button.secondary { color: var(--smrt-color-primary, #005ac1); background: transparent; border-color: var(--smrt-color-outline, #64748b); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--smrt-color-primary, #005ac1); outline-offset: 2px; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  .item-actions { margin-block-start: var(--smrt-spacing-3, .75rem); }
  .problem { margin-block-start: var(--smrt-spacing-2, .5rem); color: var(--smrt-color-error, #b3261e); }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  :global([data-smrt-staged='true']) { outline: 3px solid var(--smrt-color-tertiary, #7d5260); outline-offset: 3px; }
  @media (max-width: 40rem) { header, .proposal-heading { align-items: stretch; flex-direction: column; } dl { grid-template-columns: 1fr; } }
</style>
