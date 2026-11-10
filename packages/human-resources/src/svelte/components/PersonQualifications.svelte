<script lang="ts">
/**
 * PersonQualifications — what one person holds, each with its expiry state.
 * Presentational: the host calls `QualificationService.listForProfile` and
 * adapts rows with `toPersonQualificationView`. The state is always written
 * out as text beside the badge, never shown by colour alone.
 */

import { Button, StatusBadge } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import {
  DEFAULT_EXPIRING_SOON_DAYS,
  expiryDistance,
  type PersonQualificationView,
  qualificationExpiryState,
  qualificationKindLabelKey,
  qualificationStateBadgeKey,
  qualificationStateLabelKey,
} from '../types.js';

const { t } = useI18n();

export interface PersonQualificationsProps {
  /** The person's qualifications, in the host's order. */
  qualifications: PersonQualificationView[];
  /** Valid qualifications expiring within this many days are flagged. */
  expiringSoonDays?: number;
  /** Invoked with the held-qualification id when a name is activated. */
  onselect?: (id: string) => void;
  /** Message shown when the person holds nothing. */
  emptyMessage?: string;
}

const {
  qualifications,
  expiringSoonDays = DEFAULT_EXPIRING_SOON_DAYS,
  onselect,
  emptyMessage,
}: PersonQualificationsProps = $props();

function distance(daysUntilExpiry: number): string {
  const { key, days } = expiryDistance(daysUntilExpiry);
  return t(key, { days });
}
</script>

{#if qualifications.length === 0}
  <p class="smrt-person-qualifications__empty" data-smrt-component="PersonQualifications" >
    {emptyMessage ?? t(M['human_resources.person_qualifications.empty'])}
  </p>
{:else}
  <ul class="smrt-person-qualifications__root" data-smrt-component="PersonQualifications">
    {#each qualifications as qualification (qualification.id)}
      {@const state = qualificationExpiryState(qualification, expiringSoonDays)}
      <li class="smrt-person-qualifications__row" data-state={state} data-smrt-part="row">
        <div class="smrt-person-qualifications__main" data-smrt-part="body">
          {#if onselect}
            <Button
              variant="ghost"
              size="sm"
              onclick={() => onselect(qualification.id)}
              aria-label={t(M['human_resources.person_qualifications.select_aria'], { name: qualification.name })}
            >
              {qualification.name}
            </Button>
          {:else}
            <span class="smrt-person-qualifications__name" data-smrt-part="title">{qualification.name}</span>
          {/if}
          <span class="smrt-person-qualifications__detail" data-smrt-part="description">
            <span>{t(qualificationKindLabelKey(qualification.kind))}</span>
            {#if qualification.issuingBody}
              <span>{qualification.issuingBody}</span>
            {/if}
            {#if qualification.certificateNumber}
              <span>
                {t(M['human_resources.person_qualifications.certificate'], { certificateNumber: qualification.certificateNumber })}
              </span>
            {/if}
          </span>
        </div>
        <div class="smrt-person-qualifications__dates" data-smrt-part="meta">
          <span>{t(M['human_resources.person_qualifications.issued_on'], { date: qualification.issuedOn })}</span>
          {#if qualification.expiresOn === null}
            <span>{t(M['human_resources.person_qualifications.no_expiry'])}</span>
          {:else}
            <span>{t(M['human_resources.person_qualifications.expires_on'], { date: qualification.expiresOn })}</span>
            {#if qualification.daysUntilExpiry !== null && (state === 'valid' || state === 'expiring-soon' || state === 'expired')}
              <span class="smrt-person-qualifications__distance" data-smrt-part="meta">{distance(qualification.daysUntilExpiry)}</span>
            {/if}
          {/if}
        </div>
        <StatusBadge
          status={qualificationStateBadgeKey(state)}
          label={t(qualificationStateLabelKey(state))}
          size="sm"
        />
      </li>
    {/each}
  </ul>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-person-qualifications__root {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .smrt-person-qualifications__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.25rem;
  }
  .smrt-person-qualifications__main {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }
  .smrt-person-qualifications__detail,
  .smrt-person-qualifications__dates {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .smrt-person-qualifications__empty {
    padding: 1rem 0;
  }
}

@layer smrt.theme {
  .smrt-person-qualifications__row {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-person-qualifications__row:last-child {
    border-bottom: none;
  }
  .smrt-person-qualifications__name {
    font-weight: 500;
  }
  .smrt-person-qualifications__detail,
  .smrt-person-qualifications__dates {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-person-qualifications__distance {
    font-weight: 500;
  }
  .smrt-person-qualifications__empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
}

</style>
