<script lang="ts">
/**
 * ProductionRunList — production runs with their progress ("12 of 25 done")
 * and status, and, when the host passes `oncomplete`, a field on each open run
 * to report finished units. Presentational: the host loads runs through
 * `ProductionRunService`, adapts them with `toProductionRunView`, and records
 * the completion it is handed (the service checks the quantity again under
 * its lock).
 */

import { Button, ProgressBar, StatusBadge } from '@happyvertical/smrt-ui';
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import {
  isProductionRunOpen,
  type ProductionRunView,
  productionRunStatusLabelKey,
  productionRunStatusTone,
  validateCompletionQty,
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
  /** Message shown when there are no runs. */
  emptyMessage?: string;
}

const { runs, oncomplete, emptyMessage }: ProductionRunListProps = $props();

const uid = $props.id();

let drafts = $state<Record<string, string>>({});
let errors = $state<Record<string, string>>({});
let busy = $state<Record<string, boolean>>({});

function remainingOf(run: ProductionRunView): number {
  return Math.max(0, run.targetQty - run.completedQty);
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
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
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

  .run-list-error {
    margin: 0.25rem 0 0;
    color: var(--smrt-color-error, inherit);
  }

  .run-list-empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
</style>
