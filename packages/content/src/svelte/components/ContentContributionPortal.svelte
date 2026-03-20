<script lang="ts">
import type { ContentContributionData } from '../../mock-smrt-client';

export interface Props {
  contributions?: ContentContributionData[];
  selectedId?: string | null;
  emptyMessage?: string;
  onSelect?: (contribution: ContentContributionData) => void;
  onWithdraw?: (contribution: ContentContributionData) => void;
}

let {
  contributions = [],
  selectedId = null,
  emptyMessage = 'No submissions yet.',
  onSelect = undefined,
  onWithdraw = undefined,
}: Props = $props();

const selectedContribution = $derived(
  contributions.find((item) => item.id === selectedId) ||
    contributions[0] ||
    null,
);

function canWithdraw(contribution: ContentContributionData) {
  return !['promoted', 'rejected', 'withdrawn'].includes(
    contribution.status || '',
  );
}
</script>

<section class="portal">
  <header class="portal__header">
    <div>
      <h3>Your contributions</h3>
      <p>Track the status of your submissions and follow up when editors request changes.</p>
    </div>
    <span class="pill">{contributions.length}</span>
  </header>

  {#if contributions.length === 0}
    <p class="empty-copy">{emptyMessage}</p>
  {:else}
    <div class="portal__layout">
      <div class="portal__list">
        {#each contributions as contribution (contribution.id)}
          <button
            type="button"
            class:selected={selectedContribution?.id === contribution.id}
            onclick={() => onSelect?.(contribution)}
          >
            <strong>{contribution.title || contribution.contributionTypeKey || 'Untitled submission'}</strong>
            <span>{contribution.status || 'submitted'}</span>
          </button>
        {/each}
      </div>

      {#if selectedContribution}
        <article class="portal__detail">
          <header>
            <h4>{selectedContribution.title || 'Untitled submission'}</h4>
            <span class="pill">{selectedContribution.status || 'submitted'}</span>
          </header>
          {#if selectedContribution.description}
            <p>{selectedContribution.description}</p>
          {/if}
          {#if selectedContribution.editorNotes}
            <div class="callout">
              <strong>Editor notes</strong>
              <p>{selectedContribution.editorNotes}</p>
            </div>
          {/if}
          <dl>
            <div>
              <dt>Type</dt>
              <dd>{selectedContribution.contributionTypeKey || 'n/a'}</dd>
            </div>
            <div>
              <dt>Revisions</dt>
              <dd>{selectedContribution.revisionCount || 0}</dd>
            </div>
            <div>
              <dt>Updated</dt>
              <dd>{selectedContribution.updatedAt || selectedContribution.createdAt || 'n/a'}</dd>
            </div>
          </dl>

          {#if onWithdraw && canWithdraw(selectedContribution)}
            <button type="button" class="secondary" onclick={() => onWithdraw?.(selectedContribution)}>
              Withdraw submission
            </button>
          {/if}
        </article>
      {/if}
    </div>
  {/if}
</section>

<style>
  .portal {
    display: grid;
    gap: 1rem;
  }

  .portal__header,
  .portal__layout {
    display: grid;
    gap: 1rem;
  }

  .portal__layout {
    grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr);
  }

  .portal__list {
    display: grid;
    gap: 0.5rem;
  }

  .portal__list button,
  .portal__detail {
    border: 1px solid #d9d9d9;
    border-radius: 0.75rem;
    padding: 0.85rem;
    background: #fff;
  }

  .portal__list button {
    display: grid;
    gap: 0.35rem;
    text-align: left;
  }

  .portal__list button.selected {
    border-color: #0b5fff;
    box-shadow: 0 0 0 1px #0b5fff;
  }

  .portal__detail {
    display: grid;
    gap: 0.85rem;
  }

  .portal__detail header,
  dl {
    display: grid;
    gap: 0.5rem;
  }

  dl div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.75rem;
    padding: 0.15rem 0.5rem;
    border-radius: 999px;
    background: #eef3ff;
  }

  .callout {
    padding: 0.75rem;
    border-radius: 0.75rem;
    background: #f7f7f7;
  }

  @media (max-width: 720px) {
    .portal__layout {
      grid-template-columns: 1fr;
    }
  }
</style>
