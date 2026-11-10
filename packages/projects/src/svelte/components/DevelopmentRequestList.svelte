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
  <div class="smrt-development-request-list__empty" data-smrt-component="DevelopmentRequestList">
    <p>{emptyMessage}</p>
  </div>
{:else}
  <div class="smrt-development-request-list__root" data-smrt-component="DevelopmentRequestList">
    {#each visibleRequests as request (request.id)}
      <article class="smrt-development-request-list__card" data-smrt-part="item">
        <header>
          <div>
            <p class="smrt-development-request-list__eyebrow" data-smrt-part="label">{request.type}</p>
            <h3>{request.description}</h3>
          </div>
          <span class="smrt-development-request-list__status smrt-development-request-list__status-{request.status}" data-smrt-part="status">{request.status}</span>
        </header>

        <dl class="smrt-development-request-list__meta" data-smrt-part="meta">
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
          <p class="smrt-development-request-list__discussion" data-smrt-part="body">{request.discussion}</p>
        {/if}

        {#if request.evidence?.length}
          <ul class="smrt-development-request-list__evidence-list" data-smrt-part="list">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-development-request-list__empty {
    padding: 2rem 1rem;
  }
  .smrt-development-request-list__root {
    display: grid;
    gap: 1rem;
  }
  .smrt-development-request-list__card {
    padding: 1rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: start;
  }
  h3 {
    margin: 0.15rem 0 0;
  }
  .smrt-development-request-list__eyebrow {
    margin: 0;
  }
  .smrt-development-request-list__status {
    padding: 0.3rem 0.65rem;
    white-space: nowrap;
  }
  .smrt-development-request-list__meta {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    margin: 1rem 0 0;
  }
  .smrt-development-request-list__meta div {
    margin: 0;
  }
  dd {
    margin: 0.15rem 0 0;
  }
  .smrt-development-request-list__discussion {
    margin: 1rem 0 0;
  }
  .smrt-development-request-list__evidence-list {
    margin: 0.85rem 0 0;
    padding-left: 1.2rem;
  }
  @media (max-width: 700px) {
    header {
      flex-direction: column;
    }
  }
}

@layer smrt.theme {
  .smrt-development-request-list__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-development-request-list__card {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-large);
    background: linear-gradient(
      180deg,
      var(--smrt-color-surface),
      var(--smrt-color-surface-container-lowest)
    );
  }
  h3 {
    font-size: 1rem;
  }
  .smrt-development-request-list__eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-development-request-list__status {
    border-radius: 999px;
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font-size: 0.82rem;
  }
  .smrt-development-request-list__status-completed {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-development-request-list__status-declined {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-development-request-list__status-in_progress {
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
  }
  dt {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-development-request-list__discussion {
    color: var(--smrt-color-on-surface-variant);
  }
  a {
    color: var(--smrt-color-primary);
  }
}

</style>
