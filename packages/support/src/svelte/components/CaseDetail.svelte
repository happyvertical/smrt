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

<article class="smrt-case-detail__root" data-smrt-component="CaseDetail">
  <header class="smrt-case-detail__header" data-smrt-part="header">
    <p class="smrt-case-detail__number" data-smrt-part="value">{caseView.caseNumber}</p>
    <h2 class="smrt-case-detail__subject" data-smrt-part="title">{caseView.subject}</h2>
    <div class="smrt-case-detail__badges" data-smrt-part="meta">
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
        <span class="smrt-case-detail__severity" data-smrt-part="meta">{caseView.severity}</span>
      {/if}
      {#if caseView.reopenCount > 0}
        <span class="smrt-case-detail__reopens" data-smrt-part="meta">
          reopened ×{caseView.reopenCount}
        </span>
      {/if}
    </div>
  </header>

  <dl class="smrt-case-detail__meta" data-smrt-part="meta">
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
    <section class="smrt-case-detail__resolution" data-smrt-part="description" aria-label="Resolution">
      <h3>Resolution</h3>
      <p>{caseView.resolutionSummary}</p>
    </section>
  {/if}

  {#if workLinks.length > 0}
    <section class="smrt-case-detail__work" data-smrt-part="group" aria-label="Linked work">
      <h3>Linked work</h3>
      <ul>
        {#each workLinks as link (link.id)}
          <li>
            <span class="smrt-case-detail__work-kind" data-smrt-part="meta">
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

  <section class="smrt-case-detail__timeline" data-smrt-part="list" aria-label="Case history">
    <h3>History</h3>
    {#if timeline.length === 0}
      <p class="smrt-case-detail__empty" data-smrt-part="empty">No activity yet</p>
    {:else}
      <ol>
        {#each timeline as item, index (index)}
          <li class="smrt-case-detail__timeline-item" data-kind={item.kind} data-smrt-part="row">
            <div class="smrt-case-detail__timeline-item-head" data-smrt-part="header">
              <span class="smrt-case-detail__timeline-actor" data-smrt-part="author">{item.actorKind}</span>
              <span class="smrt-case-detail__timeline-summary" data-smrt-part="summary">
                {item.kind === 'event'
                  ? item.summary
                  : humanizeStatus(item.summary)}
              </span>
              <time datetime={item.occurredAt}>
                {formatWhen(item.occurredAt)}
              </time>
            </div>
            {#if item.body}
              <p class="smrt-case-detail__timeline-body" data-smrt-part="body">{item.body}</p>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</article>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-case-detail__root {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .smrt-case-detail__number {
    margin: 0;
  }
  .smrt-case-detail__subject {
    margin: 0.125rem 0 0.5rem;
  }
  .smrt-case-detail__badges {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .smrt-case-detail__meta {
    display: flex;
    gap: 1.5rem;
    margin: 0;
    flex-wrap: wrap;
  }
  .smrt-case-detail__meta dd {
    margin: 0;
  }
  .smrt-case-detail__resolution h3,
  .smrt-case-detail__work h3,
  .smrt-case-detail__timeline h3 {
    margin: 0 0 0.5rem;
  }
  .smrt-case-detail__work ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .smrt-case-detail__work li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-case-detail__timeline ol {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  .smrt-case-detail__timeline-item {
    padding-left: 0.75rem;
  }
  .smrt-case-detail__timeline-item-head {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .smrt-case-detail__timeline-item time {
    margin-left: auto;
  }
  .smrt-case-detail__timeline-body {
    margin: 0.25rem 0 0;
    white-space: pre-wrap;
  }
}

@layer smrt.theme {
  .smrt-case-detail__number {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-case-detail__subject {
    font-size: 1.25rem;
  }
  .smrt-case-detail__severity,
  .smrt-case-detail__reopens {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-case-detail__meta dt {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-case-detail__resolution h3,
  .smrt-case-detail__work h3,
  .smrt-case-detail__timeline h3 {
    font-size: 0.875rem;
  }
  .smrt-case-detail__work-kind {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-case-detail__timeline-item {
    border-left: 2px solid var(--smrt-color-outline-variant, currentColor);
  }
  .smrt-case-detail__timeline-item[data-kind='interaction'] {
    border-left-color: var(--smrt-color-primary, currentColor);
  }
  .smrt-case-detail__timeline-actor {
    font-size: 0.6875rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-case-detail__timeline-summary {
    font-weight: 500;
  }
  .smrt-case-detail__timeline-item time {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-case-detail__empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
}

</style>
