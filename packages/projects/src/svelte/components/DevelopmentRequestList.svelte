<script lang="ts">
import type {
  DevelopmentRequestEvidence,
  DevelopmentRequestOrigin,
  DevelopmentRequestStatus,
  DevelopmentRequestType,
  DevelopmentRequestVisibility,
} from '../../types.js';

export interface DevelopmentRequestListItem {
  id: string;
  requesterId: string;
  type: DevelopmentRequestType;
  description: string;
  status: DevelopmentRequestStatus;
  visibility?: DevelopmentRequestVisibility;
  origin?: DevelopmentRequestOrigin;
  discussion?: string;
  evidence?: DevelopmentRequestEvidence[];
  createdAt?: Date | string;
}

export interface Props {
  /** Filters requests to show only those from a specific requester. */
  requesterId?: string;
  /** Development requests to display in the list. */
  requests: DevelopmentRequestListItem[];
  /** Message shown when no requests match the filter. */
  emptyMessage?: string;
}

let {
  requesterId,
  requests,
  emptyMessage = 'No development requests yet',
}: Props = $props();

const visibleRequests = $derived(
  requesterId
    ? requests.filter((request) => request.requesterId === requesterId)
    : requests,
);

function formatWhen(value?: Date | string): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
</script>

{#if visibleRequests.length === 0}
  <div class="empty-state">
    <p>{emptyMessage}</p>
  </div>
{:else}
  <div class="request-list">
    {#each visibleRequests as request (request.id)}
      <article class="request-card">
        <header>
          <div>
            <p class="eyebrow">{request.type}</p>
            <h3>{request.description}</h3>
          </div>
          <span class="status status-{request.status}">{request.status}</span>
        </header>

        <dl class="meta">
          <div>
            <dt>Visibility</dt>
            <dd>{request.visibility ?? 'requester'}</dd>
          </div>
          {#if request.origin}
            <div>
              <dt>Origin</dt>
              <dd>{request.origin}</dd>
            </div>
          {/if}
          {#if formatWhen(request.createdAt)}
            <div>
              <dt>Submitted</dt>
              <dd>{formatWhen(request.createdAt)}</dd>
            </div>
          {/if}
          <div>
            <dt>Evidence</dt>
            <dd>{request.evidence?.length ?? 0}</dd>
          </div>
        </dl>

        {#if request.discussion}
          <p class="discussion">{request.discussion}</p>
        {/if}

        {#if request.evidence?.length}
          <ul class="evidence-list">
            {#each request.evidence as item, index (item.url + index)}
              <li>
                <a href={item.url}>{item.label ?? item.url}</a>
              </li>
            {/each}
          </ul>
        {/if}
      </article>
    {/each}
  </div>
{/if}

<style>
  .empty-state {
    padding: 2rem 1rem;
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #5f6472);
  }

  .request-list {
    display: grid;
    gap: 1rem;
  }

  .request-card {
    padding: 1rem;
    border: 1px solid var(--smrt-color-outline-variant, #d5d8e1);
    border-radius: var(--smrt-radius-large, 16px);
    background: linear-gradient(
      180deg,
      var(--smrt-color-surface, #fff),
      var(--smrt-color-surface-container-lowest, #f8f9fc)
    );
  }

  header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
  }

  h3 {
    margin: 0.15rem 0 0;
    font-size: 1rem;
  }

  .eyebrow {
    margin: 0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, #5f6472);
  }

  .status {
    padding: 0.3rem 0.65rem;
    border-radius: 999px;
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font-size: 0.82rem;
    white-space: nowrap;
  }

  .status-completed {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }

  .status-declined {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }

  .status-in_progress {
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }

  .meta {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    margin: 1rem 0 0;
  }

  .meta div {
    margin: 0;
  }

  dt {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--smrt-color-on-surface-variant, #5f6472);
  }

  dd {
    margin: 0.15rem 0 0;
  }

  .discussion {
    margin: 1rem 0 0;
    color: var(--smrt-color-on-surface-variant, #3d4454);
  }

  .evidence-list {
    margin: 0.85rem 0 0;
    padding-left: 1.2rem;
  }

  a {
    color: var(--smrt-color-primary, #1f6feb);
  }

  @media (max-width: 700px) {
    header {
      flex-direction: column;
    }
  }
</style>
