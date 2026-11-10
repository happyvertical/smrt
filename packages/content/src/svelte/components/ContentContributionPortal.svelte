<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ContentContributionData } from '../../mock-smrt-client';
import { M } from '../i18n.contribution.js';

const { t } = useI18n();

export interface Props {
  /** List of contributions submitted by the user. */
  contributions?: ContentContributionData[];
  /** ID of the contribution currently displayed for detail viewing. */
  selectedId?: string | null;
  /** Message shown when the contributions list is empty. */
  emptyMessage?: string;
  /** Fired when the user selects a contribution from the list. */
  onSelect?: (contribution: ContentContributionData) => void;
  /** Fired when the user withdraws a pending contribution. */
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

<section class="smrt-content-contribution-portal__root" data-smrt-component="ContentContributionPortal">
  <header class="smrt-content-contribution-portal__header" data-smrt-part="header">
    <div>
      <h3>{t(M['content.contribution_portal.heading'])}</h3>
      <p>{t(M['content.contribution_portal.intro'])}</p>
    </div>
    <span class="smrt-content-contribution-portal__pill" data-smrt-part="badge">{contributions.length}</span>
  </header>

  {#if contributions.length === 0}
    <p class="smrt-content-contribution-portal__empty" data-smrt-part="empty">{emptyMessage}</p>
  {:else}
    <div class="smrt-content-contribution-portal__layout" data-smrt-part="body">
      <div class="smrt-content-contribution-portal__list" data-smrt-part="list">
        {#each contributions as contribution (contribution.id)}
          <!-- raw-primitive-allow: large pressable selection card wrapping rich content (title, status) with selected state; no Button primitive owns this list-row selection pattern -->
          <button
            type="button"
            class:smrt-content-contribution-portal__selected={selectedContribution?.id === contribution.id}
            data-smrt-part="item"
            onclick={() => onSelect?.(contribution)}
          >
            <strong>{contribution.title || contribution.contributionTypeKey || 'Untitled submission'}</strong>
            <span>{contribution.status || 'submitted'}</span>
          </button>
        {/each}
      </div>

      {#if selectedContribution}
        <article class="smrt-content-contribution-portal__detail" data-smrt-part="panel">
          <header>
            <h4>{selectedContribution.title || 'Untitled submission'}</h4>
            <span class="smrt-content-contribution-portal__pill" data-smrt-part="badge">{selectedContribution.status || 'submitted'}</span>
          </header>
          {#if selectedContribution.description}
            <p>{selectedContribution.description}</p>
          {/if}
          {#if selectedContribution.editorNotes}
            <div class="smrt-content-contribution-portal__callout" data-smrt-part="status">
              <strong>{t(M['content.contribution_portal.editor_notes'])}</strong>
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
            <Button variant="secondary" type="button" onclick={() => onWithdraw?.(selectedContribution)}>
              {t(M['content.contribution_portal.withdraw_submission'])}
            </Button>
          {/if}
        </article>
      {/if}
    </div>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-content-contribution-portal__root {
    display: grid;
    gap: 1rem;
  }
  .smrt-content-contribution-portal__header,
  .smrt-content-contribution-portal__layout {
    display: grid;
    gap: 1rem;
  }
  .smrt-content-contribution-portal__layout {
    grid-template-columns: minmax(14rem, 20rem) minmax(0, 1fr);
  }
  .smrt-content-contribution-portal__list {
    display: grid;
    gap: 0.5rem;
  }
  .smrt-content-contribution-portal__list button,
  .smrt-content-contribution-portal__detail {
    padding: 0.85rem;
  }
  .smrt-content-contribution-portal__list button {
    display: grid;
    gap: 0.35rem;
  }
  .smrt-content-contribution-portal__detail {
    display: grid;
    gap: 0.85rem;
  }
  .smrt-content-contribution-portal__detail header,
  dl {
    display: grid;
    gap: 0.5rem;
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .smrt-content-contribution-portal__pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.75rem;
    padding: 0.15rem 0.5rem;
  }
  .smrt-content-contribution-portal__callout {
    padding: 0.75rem;
  }
  @media (max-width: 720px) {
    .smrt-content-contribution-portal__layout {
      grid-template-columns: 1fr;
    }
  }
}

@layer smrt.theme {
  .smrt-content-contribution-portal__list button,
  .smrt-content-contribution-portal__detail {
    border: var(--smrt-hairline);
    border-radius: 0.75rem;
    background: var(--smrt-color-surface);
  }
  .smrt-content-contribution-portal__list button {
    text-align: left;
  }
  .smrt-content-contribution-portal__list button.smrt-content-contribution-portal__selected {
    border-color: var(--smrt-color-primary);
    box-shadow: 0 0 0 1px var(--smrt-color-primary);
  }
  .smrt-content-contribution-portal__pill {
    border-radius: var(--smrt-radius-full);
    background: var(--smrt-color-primary-container);
  }
  .smrt-content-contribution-portal__callout {
    border-radius: 0.75rem;
    background: var(--smrt-color-surface-container);
  }
}

</style>
