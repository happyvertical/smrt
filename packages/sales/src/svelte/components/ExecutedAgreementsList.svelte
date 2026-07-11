<script lang="ts">
/**
 * ExecutedAgreementsList — referrer agreement versions (#1933).
 *
 * Table of agreement versions: version, status, effective window, the pinned
 * commission plan (`key@version`), clearing days, approval mode, and the
 * executed-artifact evidence (URL + content hash) when the agreement has been
 * executed.
 */
import { Badge } from '@happyvertical/smrt-ui/ui';
import { formatDate } from '../format.js';
import type { AgreementVersionView } from '../types.js';
import { agreementStatusBadgeVariant, formatPlanRef } from '../types.js';

export interface Props {
  /** Agreement versions, newest first by convention. */
  agreements?: AgreementVersionView[];
  /** BCP 47 locale for date formatting. */
  locale?: string;
}

let { agreements = [], locale }: Props = $props();
</script>

<div class="sales-agreements">
  {#if agreements.length === 0}
    <p class="empty">No agreements yet.</p>
  {:else}
    <table>
      <thead>
        <tr>
          <th scope="col">Version</th>
          <th scope="col">Status</th>
          <th scope="col">Effective</th>
          <th scope="col">Commission plan</th>
          <th scope="col" class="num">Clearing</th>
          <th scope="col">Approval</th>
          <th scope="col">Executed artifact</th>
        </tr>
      </thead>
      <tbody>
        {#each agreements as agreement (agreement.id)}
          <tr>
            <td>v{agreement.version}</td>
            <td>
              <Badge variant={agreementStatusBadgeVariant(agreement.status)} size="sm">
                {agreement.status}
              </Badge>
            </td>
            <td>
              {formatDate(agreement.effectiveFrom, locale)}
              –
              {#if agreement.effectiveTo}
                {formatDate(agreement.effectiveTo, locale)}
              {:else}
                open-ended
              {/if}
            </td>
            <td>
              <code>{formatPlanRef(agreement.planKey, agreement.planVersion)}</code>
            </td>
            <td class="num">{agreement.clearingDays} days</td>
            <td>{agreement.approvalMode}</td>
            <td>
              {#if agreement.artifactUrl}
                <a href={agreement.artifactUrl} target="_blank" rel="noopener noreferrer">
                  executed copy
                </a>
                {#if agreement.artifactHash}
                  <code class="hash" title={agreement.artifactHash}>
                    {agreement.artifactHash.slice(0, 12)}…
                  </code>
                {/if}
              {:else}
                —
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

<style>
  .sales-agreements {
    width: 100%;
    overflow-x: auto;
  }

  .empty {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-style: italic;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  th {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    background: var(--smrt-color-surface-container, #f3f4f6);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    white-space: nowrap;
  }

  td {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    vertical-align: top;
  }

  .num {
    text-align: right;
    white-space: nowrap;
  }

  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }

  .hash {
    margin-left: var(--smrt-spacing-1, 0.25rem);
    color: var(--smrt-color-on-surface-variant, #64748b);
  }

  a {
    color: var(--smrt-color-primary, #2563eb);
  }
</style>
