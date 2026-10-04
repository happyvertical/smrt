<script lang="ts">
/**
 * ExpiringQualificationsList — qualifications about to expire, across people,
 * soonest first. Presentational: the host calls
 * `QualificationService.expiringWithin`, adds each holder's name (HR holds no
 * identity data) and adapts rows with `toExpiringQualificationView`.
 */

import { Button } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import {
  type ExpiringQualificationView,
  expiryDistance,
  sortBySoonestExpiry,
} from '../types.js';

const { t } = useI18n();

export interface ExpiringQualificationsListProps {
  /** Qualifications close to expiry; the list sorts them soonest first. */
  items: ExpiringQualificationView[];
  /** Invoked with the held-qualification id when a row is activated. */
  onselect?: (id: string) => void;
  /** Message shown when nothing is expiring. */
  emptyMessage?: string;
}

const { items, onselect, emptyMessage }: ExpiringQualificationsListProps =
  $props();

const sorted = $derived(sortBySoonestExpiry(items));

function distance(daysUntilExpiry: number): string {
  const { key, days } = expiryDistance(daysUntilExpiry);
  return t(key, { days });
}
</script>

{#if sorted.length === 0}
  <p class="expiring-qualifications-empty">
    {emptyMessage ?? t(M['human_resources.expiring_qualifications_list.empty'])}
  </p>
{:else}
  <ul class="expiring-qualifications">
    {#each sorted as item (item.id)}
      <li class="expiring-qualification">
        <div class="expiring-qualification-main">
          {#if onselect}
            <Button
              variant="ghost"
              size="sm"
              onclick={() => onselect(item.id)}
              aria-label={t(M['human_resources.expiring_qualifications_list.select_aria'], { qualification: item.qualificationName, name: item.displayName })}
            >
              {item.qualificationName}
            </Button>
          {:else}
            <span class="expiring-qualification-name">{item.qualificationName}</span>
          {/if}
          <span class="expiring-qualification-person">{item.displayName}</span>
        </div>
        <div class="expiring-qualification-when">
          <span class="expiring-qualification-distance">{distance(item.daysUntilExpiry)}</span>
          <span>{t(M['human_resources.expiring_qualifications_list.expires_on'], { date: item.expiresOn })}</span>
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .expiring-qualifications {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .expiring-qualification {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.25rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant, transparent);
  }

  .expiring-qualification:last-child {
    border-bottom: none;
  }

  .expiring-qualification-main {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }

  .expiring-qualification-name,
  .expiring-qualification-distance {
    font-weight: 500;
  }

  .expiring-qualification-person,
  .expiring-qualification-when {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .expiring-qualification-when {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.125rem;
  }

  .expiring-qualifications-empty {
    color: var(--smrt-color-on-surface-variant, inherit);
    padding: 1rem 0;
  }
</style>
