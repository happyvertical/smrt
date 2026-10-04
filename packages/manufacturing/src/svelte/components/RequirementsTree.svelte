<script lang="ts">
/**
 * RequirementsTree — a read-only view of an exploded bill: each line with its
 * level, component, kind and required quantity, nested under the
 * sub-assembly whose bill it belongs to, and the totals. From a plan
 * (`BomService.planRequirements`) each line also shows the available stock
 * and how much is short; a short sub-assembly that was opened lists what
 * building the shortfall takes.
 *
 * The host adapts the result with `toRequirementTree` and
 * `toRequirementTotals`. This shows facts only: whether to build or buy is
 * the host's decision.
 */

import { Badge } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import type { RequirementLineView, RequirementTotalView } from '../types.js';
import RequirementsTreeLevel from './RequirementsTreeLevel.svelte';

const { t } = useI18n();

export interface RequirementsTreeProps {
  /** The top bill's lines, each with the lines walked below it. */
  lines: RequirementLineView[];
  /** Totals per component; omit to hide the table. */
  totals?: RequirementTotalView[];
  /** Accessible name for the tree; defaults to "Requirements". */
  label?: string;
}

const { lines, totals, label }: RequirementsTreeProps = $props();

const showShort = $derived(
  (totals ?? []).some((total) => total.short !== null),
);

function quantity(value: number): string {
  return String(Number(value.toFixed(6)));
}

function componentText(name: string, skuCode: string): string {
  const shown = name || t(M['manufacturing.requirements.unnamed']);
  return skuCode && skuCode !== name ? `${shown} (${skuCode})` : shown;
}
</script>

{#if lines.length === 0}
  <p class="requirements-empty">{t(M['manufacturing.requirements.empty'])}</p>
{:else}
  <RequirementsTreeLevel
    {lines}
    label={label ?? t(M['manufacturing.requirements.label'])}
  />
{/if}

{#if totals && totals.length > 0}
  <div class="requirements-scroll">
    <table class="requirements-totals">
      <caption>{t(M['manufacturing.requirements.totals_caption'])}</caption>
      <thead>
        <tr>
          <th scope="col">{t(M['manufacturing.requirements.component'])}</th>
          <th scope="col">{t(M['manufacturing.requirements.total_required'])}</th>
          <th scope="col">{t(M['manufacturing.requirements.uom'])}</th>
          {#if showShort}
            <th scope="col">{t(M['manufacturing.requirements.total_short'])}</th>
          {/if}
        </tr>
      </thead>
      <tbody>
        {#each totals as total (total.componentSkuId)}
          <tr>
            <th scope="row">{componentText(total.name, total.skuCode)}</th>
            <td class="requirements-number">{quantity(total.required)}</td>
            <td>{total.uom}</td>
            {#if showShort}
              <td class="requirements-number">
                {#if total.short !== null && total.short > 0}
                  <Badge size="sm" variant="error">{quantity(total.short)}</Badge>
                {:else}
                  {quantity(total.short ?? 0)}
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
  .requirements-empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .requirements-scroll {
    overflow-x: auto;
    margin-top: 1rem;
  }

  .requirements-totals {
    width: 100%;
    border-collapse: collapse;
  }

  .requirements-totals caption {
    text-align: left;
    font-weight: var(--smrt-typography-title-medium-weight, 500);
    padding-bottom: 0.5rem;
  }

  .requirements-totals th,
  .requirements-totals td {
    padding: 0.375rem 0.5rem;
    text-align: left;
    border-bottom: 1px solid var(--smrt-color-outline-variant, transparent);
  }

  .requirements-number {
    font-variant-numeric: tabular-nums;
  }
</style>
