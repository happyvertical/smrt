<script lang="ts">
/**
 * CaseDetail — reusable Support Case detail surface (issue #1926): header
 * with priority/status/assignment, resolution, linked work, and the merged
 * interaction + audit timeline. Presentational: the host loads the case view
 * and timeline (see `toSupportCaseView` / `toCaseTimelineItemView`).
 */

import { StatusBadge } from '@happyvertical/smrt-ui';
import {
  type CaseTimelineItemView,
  caseStatusBadgeKey,
  humanizeStatus,
  priorityBadgeKey,
  type SupportCaseView,
  type SupportWorkLinkView,
} from '../types.js';

export interface CaseDetailProps {
  /** Case details including status, priority, assignment, and metadata. */
  caseView: SupportCaseView;
  /** Array of timeline events including interactions and status changes. */
  timeline?: CaseTimelineItemView[];
  /** Array of linked work items associated with the case. */
  workLinks?: SupportWorkLinkView[];
}

const { caseView, timeline = [], workLinks = [] }: CaseDetailProps = $props();

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
</script>

<article class="case-detail">
  <header class="case-detail-header">
    <p class="case-detail-number">{caseView.caseNumber}</p>
    <h2 class="case-detail-subject">{caseView.subject}</h2>
    <div class="case-detail-badges">
      <StatusBadge
        status={priorityBadgeKey(caseView.priority)}
        label={caseView.priority}
        size="sm"
      />
      <StatusBadge
        status={caseStatusBadgeKey(caseView.status)}
        label={humanizeStatus(caseView.status)}
        size="sm"
      />
      {#if caseView.severity}
        <span class="case-detail-severity">{caseView.severity}</span>
      {/if}
      {#if caseView.reopenCount > 0}
        <span class="case-detail-reopens">
          reopened ×{caseView.reopenCount}
        </span>
      {/if}
    </div>
  </header>

  <dl class="case-detail-meta">
    <div>
      <dt>Assigned</dt>
      <dd>
        {caseView.assignedSpecialistName ??
          (caseView.assignedSpecialistId ? 'assigned' : 'unassigned')}
      </dd>
    </div>
    {#if caseView.channelKind}
      <div>
        <dt>Channel</dt>
        <dd>{caseView.channelKind}</dd>
      </div>
    {/if}
    {#if caseView.projectId}
      <div>
        <dt>Project</dt>
        <dd>{caseView.projectId}</dd>
      </div>
    {/if}
  </dl>

  {#if caseView.resolutionSummary}
    <section class="case-detail-resolution" aria-label="Resolution">
      <h3>Resolution</h3>
      <p>{caseView.resolutionSummary}</p>
    </section>
  {/if}

  {#if workLinks.length > 0}
    <section class="case-detail-work" aria-label="Linked work">
      <h3>Linked work</h3>
      <ul>
        {#each workLinks as link (link.id)}
          <li>
            <span class="case-detail-work-kind">
              {link.linkKind === 'development_work_item'
                ? 'delivery'
                : 'support'}
            </span>
            {#if link.externalUrl}
              <a href={link.externalUrl} target="_blank" rel="noreferrer">
                {link.targetLabel || link.externalUrl}
              </a>
            {:else}
              <span>{link.targetLabel}</span>
            {/if}
            <StatusBadge status="pending" label={link.status} size="sm" />
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section class="case-detail-timeline" aria-label="Case history">
    <h3>History</h3>
    {#if timeline.length === 0}
      <p class="case-detail-empty">No activity yet</p>
    {:else}
      <ol>
        {#each timeline as item, index (index)}
          <li class="timeline-item" data-kind={item.kind}>
            <div class="timeline-item-head">
              <span class="timeline-actor">{item.actorKind}</span>
              <span class="timeline-summary">
                {item.kind === 'event'
                  ? item.summary
                  : humanizeStatus(item.summary)}
              </span>
              <time datetime={item.occurredAt}>
                {formatWhen(item.occurredAt)}
              </time>
            </div>
            {#if item.body}
              <p class="timeline-body">{item.body}</p>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</article>

<style>
  .case-detail {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .case-detail-number {
    margin: 0;
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .case-detail-subject {
    margin: 0.125rem 0 0.5rem;
    font-size: 1.25rem;
  }

  .case-detail-badges {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .case-detail-severity,
  .case-detail-reopens {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .case-detail-meta {
    display: flex;
    gap: 1.5rem;
    margin: 0;
    flex-wrap: wrap;
  }

  .case-detail-meta dt {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .case-detail-meta dd {
    margin: 0;
  }

  .case-detail-resolution h3,
  .case-detail-work h3,
  .case-detail-timeline h3 {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
  }

  .case-detail-work ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .case-detail-work li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .case-detail-work-kind {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .case-detail-timeline ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }

  .timeline-item {
    border-left: 2px solid var(--smrt-color-outline-variant, currentColor);
    padding-left: 0.75rem;
  }

  .timeline-item[data-kind='interaction'] {
    border-left-color: var(--smrt-color-primary, currentColor);
  }

  .timeline-item-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .timeline-actor {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .timeline-summary {
    font-weight: 500;
  }

  .timeline-item time {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
    margin-left: auto;
  }

  .timeline-body {
    margin: 0.25rem 0 0;
    white-space: pre-wrap;
  }

  .case-detail-empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
</style>
