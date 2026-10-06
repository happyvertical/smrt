<script lang="ts">
/**
 * ProductionRunList — production runs with their progress ("12 of 25 done")
 * and status, and, when the host passes `oncomplete`, a field on each open run
 * to report finished units. Presentational: the host loads runs through
 * `ProductionRunService`, adapts them with `toProductionRunView`, and records
 * the completion it is handed (the service checks the quantity again under
 * its lock).
 *
 * `onsettarget`, `onfinish` and `oncancel` add a management column to open
 * runs, each control rendered only when its handler is given: a target field,
 * and Finish and Cancel run buttons that ask for confirmation first. The host
 * calls `ProductionRunService.setTarget`, `finish` and `cancel` and refreshes
 * the runs.
 */

import { Button, ProgressBar, StatusBadge } from '@happyvertical/smrt-ui';
import { ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import {
  isProductionRunOpen,
  type ProductionRunView,
  productionRunStatusLabelKey,
  productionRunStatusTone,
  validateCompletionQty,
  validateTargetQty,
} from '../types.js';

const { t } = useI18n();

/** What a host handler may return: `false` (or a throw) keeps the field as typed. */
type HandlerResult = boolean | void | Promise<boolean | void>;

export interface ProductionRunListProps {
  /** Runs to show, in the host's order. */
  runs: ProductionRunView[];
  /**
   * Records `qty` finished units on the run; omit to hide reporting. Return
   * `false` or throw to report a failure.
   */
  oncomplete?: (runId: string, qty: number) => HandlerResult;
  /**
   * Changes the run's target quantity; omit to hide the target field. Return
   * `false` or throw to report a failure.
   */
  onsettarget?: (run: ProductionRunView, target: number) => HandlerResult;
  /**
   * Finishes the run, short of its target, once confirmed; omit to hide the
   * button. Return `false` or throw to report a failure.
   */
  onfinish?: (run: ProductionRunView) => HandlerResult;
  /**
   * Cancels the run once confirmed; omit to hide the button. Return `false` or
   * throw to report a failure.
   */
  oncancel?: (run: ProductionRunView) => HandlerResult;
  /** Message shown when there are no runs. */
  emptyMessage?: string;
}

const {
  runs,
  oncomplete,
  onsettarget,
  onfinish,
  oncancel,
  emptyMessage,
}: ProductionRunListProps = $props();

const manage = $derived(Boolean(onsettarget || onfinish || oncancel));

const uid = $props.id();

let drafts = $state<Record<string, string>>({});
let errors = $state<Record<string, string>>({});
let busy = $state<Record<string, boolean>>({});
let targetDrafts = $state<Record<string, string>>({});
let manageErrors = $state<Record<string, string>>({});
let confirming = $state<{
  kind: 'finish' | 'cancel';
  run: ProductionRunView;
} | null>(null);

/** What is left, at the six-decimal quantity precision the service uses. */
function remainingOf(run: ProductionRunView): number {
  return Math.max(0, Number((run.targetQty - run.completedQty).toFixed(6)));
}

async function report(run: ProductionRunView) {
  if (!oncomplete) return;
  const result = validateCompletionQty(drafts[run.id] ?? '', run);
  if (!result.ok) {
    errors[run.id] =
      result.reason === 'too_many'
        ? t(M['manufacturing.production_run_list.error_too_many'], {
            remaining: remainingOf(run),
          })
        : t(M['manufacturing.production_run_list.error_qty']);
    return;
  }
  errors[run.id] = '';
  busy[run.id] = true;
  try {
    if ((await oncomplete(run.id, result.qty)) === false) {
      errors[run.id] = t(M['manufacturing.production_run_list.error_failed']);
    } else {
      drafts[run.id] = '';
    }
  } catch {
    errors[run.id] = t(M['manufacturing.production_run_list.error_failed']);
  } finally {
    busy[run.id] = false;
  }
}

async function setTarget(run: ProductionRunView) {
  if (!onsettarget) return;
  const result = validateTargetQty(targetDrafts[run.id] ?? '', run);
  if (!result.ok) {
    manageErrors[run.id] =
      result.reason === 'below_done'
        ? t(M['manufacturing.production_run_list.error_target_low'], {
            completed: run.completedQty,
          })
        : t(M['manufacturing.production_run_list.error_target']);
    return;
  }
  manageErrors[run.id] = '';
  busy[run.id] = true;
  try {
    if ((await onsettarget(run, result.qty)) === false) {
      manageErrors[run.id] = t(
        M['manufacturing.production_run_list.target_failed'],
      );
    } else {
      targetDrafts[run.id] = '';
    }
  } catch {
    manageErrors[run.id] = t(
      M['manufacturing.production_run_list.target_failed'],
    );
  } finally {
    busy[run.id] = false;
  }
}

async function confirmAction() {
  const pending = confirming;
  if (!pending) return;
  const { kind, run } = pending;
  const handler = kind === 'finish' ? onfinish : oncancel;
  confirming = null;
  if (!handler) return;
  manageErrors[run.id] = '';
  busy[run.id] = true;
  try {
    if ((await handler(run)) === false) {
      manageErrors[run.id] = t(
        M[`manufacturing.production_run_list.${kind}_failed`],
      );
    }
  } catch {
    manageErrors[run.id] = t(
      M[`manufacturing.production_run_list.${kind}_failed`],
    );
  } finally {
    busy[run.id] = false;
  }
}
</script>

{#if runs.length === 0}
  <p class="run-list-empty">
    {emptyMessage ?? t(M['manufacturing.production_run_list.empty'])}
  </p>
{:else}
  <div class="run-list-scroll">
    <table class="run-list">
      <caption class="run-list-caption">{t(M['manufacturing.production_run_list.caption'])}</caption>
      <thead>
        <tr>
          <th scope="col">{t(M['manufacturing.production_run_list.build'])}</th>
          <th scope="col">{t(M['manufacturing.production_run_list.progress'])}</th>
          <th scope="col">{t(M['manufacturing.production_run_list.status'])}</th>
          {#if oncomplete}
            <th scope="col">{t(M['manufacturing.production_run_list.report'])}</th>
          {/if}
          {#if manage}
            <th scope="col">{t(M['manufacturing.production_run_list.manage'])}</th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#each runs as run (run.id)}
          {@const progressText = t(M['manufacturing.production_run_list.progress_value'], {
            completed: run.completedQty,
            target: run.targetQty,
          })}
          {@const errorId = `${uid}-${run.id}-error`}
          <tr>
            <th scope="row">{run.label}</th>
            <td class="run-list-progress">
              <ProgressBar
                value={run.completedQty}
                max={run.targetQty > 0 ? run.targetQty : 1}
                status="healthy"
                size="sm"
                showLabel
                label={progressText}
              />
            </td>
            <td>
              <StatusBadge
                status={run.status}
                tone={productionRunStatusTone(run.status)}
                label={t(productionRunStatusLabelKey(run.status))}
                size="sm"
              />
            </td>
            {#if oncomplete}
              <td>
                {#if isProductionRunOpen(run.status)}
                  <Form class="run-list-report" onsubmit={() => report(run)}>
                    <Input
                      type="number"
                      inputmode="decimal"
                      step="any"
                      min="0"
                      value={drafts[run.id] ?? ''}
                      oninput={(event) => {
                        drafts[run.id] = (event.currentTarget as HTMLInputElement).value;
                      }}
                      disabled={busy[run.id]}
                      aria-label={t(M['manufacturing.production_run_list.qty_aria'], { label: run.label })}
                      aria-invalid={errors[run.id] ? 'true' : undefined}
                      aria-describedby={errors[run.id] ? errorId : undefined}
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={busy[run.id]}
                      aria-label={t(M['manufacturing.production_run_list.submit_aria'], { label: run.label })}
                    >
                      {t(M['manufacturing.production_run_list.submit'])}
                    </Button>
                  </Form>
                  {#if errors[run.id]}
                    <p class="run-list-error" id={errorId} role="alert">{errors[run.id]}</p>
                  {/if}
                {/if}
              </td>
            {/if}
            {#if manage}
              {@const manageErrorId = `${uid}-${run.id}-manage-error`}
              <td>
                {#if isProductionRunOpen(run.status)}
                  <div class="run-list-manage">
                    {#if onsettarget}
                      <Form class="run-list-report" onsubmit={() => setTarget(run)}>
                        <Input
                          type="number"
                          inputmode="decimal"
                          step="any"
                          min="0"
                          value={targetDrafts[run.id] ?? ''}
                          placeholder={String(run.targetQty)}
                          oninput={(event) => {
                            targetDrafts[run.id] = (event.currentTarget as HTMLInputElement).value;
                          }}
                          disabled={busy[run.id]}
                          aria-label={t(M['manufacturing.production_run_list.target_aria'], { label: run.label })}
                          aria-invalid={manageErrors[run.id] ? 'true' : undefined}
                          aria-describedby={manageErrors[run.id] ? manageErrorId : undefined}
                        />
                        <Button
                          type="submit"
                          size="sm"
                          variant="secondary"
                          disabled={busy[run.id]}
                          aria-label={t(M['manufacturing.production_run_list.target_submit_aria'], { label: run.label })}
                        >
                          {t(M['manufacturing.production_run_list.target_submit'])}
                        </Button>
                      </Form>
                    {/if}
                    {#if onfinish || oncancel}
                      <div class="run-list-actions">
                        {#if onfinish}
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={busy[run.id]}
                            aria-label={t(M['manufacturing.production_run_list.finish_aria'], { label: run.label })}
                            onclick={() => (confirming = { kind: 'finish', run })}
                          >
                            {t(M['manufacturing.production_run_list.finish'])}
                          </Button>
                        {/if}
                        {#if oncancel}
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            disabled={busy[run.id]}
                            aria-label={t(M['manufacturing.production_run_list.cancel_aria'], { label: run.label })}
                            onclick={() => (confirming = { kind: 'cancel', run })}
                          >
                            {t(M['manufacturing.production_run_list.cancel'])}
                          </Button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                  {#if manageErrors[run.id]}
                    <p class="run-list-error" id={manageErrorId} role="alert">{manageErrors[run.id]}</p>
                  {/if}
                {/if}
              </td>
            {/if}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

{#if confirming}
  {@const pending = confirming}
  <ConfirmDialog
    open
    destructive={pending.kind === 'cancel'}
    title={t(M[`manufacturing.production_run_list.${pending.kind}_title`])}
    message={t(M[`manufacturing.production_run_list.${pending.kind}_message`], {
      label: pending.run.label,
      completed: pending.run.completedQty,
      target: pending.run.targetQty,
    })}
    confirmLabel={t(M[`manufacturing.production_run_list.${pending.kind}_confirm`])}
    cancelLabel={pending.kind === 'cancel'
      ? t(M['manufacturing.production_run_list.cancel_keep'])
      : undefined}
    onconfirm={confirmAction}
    oncancel={() => (confirming = null)}
  />
{/if}

<style>
  .run-list-scroll {
    overflow-x: auto;
  }

  .run-list {
    width: 100%;
    border-collapse: collapse;
  }

  .run-list-caption {
    text-align: left;
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    padding-bottom: 0.5rem;
  }

  .run-list th,
  .run-list td {
    padding: 0.5rem;
    text-align: left;
    vertical-align: top;
    border-bottom: 1px solid var(--smrt-color-outline-variant, transparent);
  }

  .run-list-progress {
    min-width: 10rem;
  }

  .run-list :global(.run-list-report) {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .run-list :global(.run-list-report input) {
    width: 6rem;
  }

  .run-list-manage {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .run-list-actions {
    display: flex;
    gap: 0.5rem;
  }

  .run-list-error {
    margin: 0.25rem 0 0;
    color: var(--smrt-color-error, inherit);
  }

  .run-list-empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
</style>
