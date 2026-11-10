<script lang="ts">
/**
 * ExecutedAgreementsList — referrer agreement versions (#1933).
 *
 * Table of agreement versions: version, status, effective window, the pinned
 * commission plan (`key@version`), clearing days, approval mode, and the
 * immutable Asset-backed signed document and audit evidence when executed.
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
  /** Build an authorized application URL for an agreement evidence artifact. */
  artifactHref?: (
    agreementId: string,
    kind: 'signed_document' | 'audit_trail',
  ) => string;
}

let { agreements = [], locale, artifactHref }: Props = $props();
</script>

<div class="smrt-executed-agreements-list__root" data-smrt-component="ExecutedAgreementsList">
  {#if agreements.length === 0}
    <p class="smrt-executed-agreements-list__empty" data-smrt-part="empty">No agreements yet.</p>
  {:else}
    <table>
      <thead data-smrt-part="header">
        <tr>
          <th scope="col">Version</th>
          <th scope="col">Status</th>
          <th scope="col">Effective</th>
          <th scope="col">Commission plan</th>
          <th scope="col" class="smrt-executed-agreements-list__number" data-smrt-part="cell">Clearing</th>
          <th scope="col">Approval</th>
          <th scope="col">Executed artifact</th>
        </tr>
      </thead>
      <tbody data-smrt-part="body">
        {#each agreements as agreement (agreement.id)}
          <tr data-smrt-part="row">
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
            <td class="smrt-executed-agreements-list__number" data-smrt-part="cell">{agreement.clearingDays} days</td>
            <td>{agreement.approvalMode}</td>
            <td>
              {#if agreement.signedDocumentAssetId}
                {#if artifactHref}
                  <a
                    href={artifactHref(agreement.id, 'signed_document')}
                    target="_blank"
                    rel="noopener noreferrer"
                  >signed copy</a>
                {:else}
                  <code title={agreement.signedDocumentAssetId}>signed asset</code>
                {/if}
                {#if agreement.signedDocumentSha256}
                  <code
                    class="smrt-executed-agreements-list__hash"
                    data-smrt-part="meta"
                    title={agreement.signedDocumentSha256}
                  >
                    {agreement.signedDocumentSha256.slice(0, 12)}…
                  </code>
                {/if}
                {#if agreement.auditTrailAssetId}
                  <span class="smrt-executed-agreements-list__separator" data-smrt-part="indicator">·</span>
                  {#if artifactHref}
                    <a
                      href={artifactHref(agreement.id, 'audit_trail')}
                      target="_blank"
                      rel="noopener noreferrer"
                    >audit trail</a>
                  {:else}
                    <code title={agreement.auditTrailAssetId}>audit asset</code>
                  {/if}
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-executed-agreements-list__root {
    width: 100%;
    overflow-x: auto;
  }
  .smrt-executed-agreements-list__empty {
    margin: 0;
  }
  table {
    width: 100%;
  }
  th {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    white-space: nowrap;
  }
  td {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-executed-agreements-list__number {
    white-space: nowrap;
  }
  .smrt-executed-agreements-list__hash {
    margin-left: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-executed-agreements-list__separator {
    margin: 0 var(--smrt-spacing-1, 0.25rem);
  }
}

@layer smrt.theme {
  .smrt-executed-agreements-list__empty {
    color: var(--smrt-color-on-surface-variant);
    font-style: italic;
  }
  table {
    border-collapse: collapse;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
  th {
    text-align: left;
    font-weight: var(--smrt-typography-weight-semibold, 600);
    background: var(--smrt-color-surface-container);
    border-bottom: var(--smrt-hairline);
  }
  td {
    border-bottom: var(--smrt-hairline);
    vertical-align: top;
  }
  .smrt-executed-agreements-list__number {
    text-align: right;
  }
  code {
    font-family: var(--smrt-font-family-mono, ui-monospace, monospace);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
  .smrt-executed-agreements-list__hash {
    color: var(--smrt-color-on-surface-variant);
  }
  a {
    color: var(--smrt-color-primary);
  }
}

</style>
