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
  <p class="smrt-expiring-qualifications__empty" data-smrt-component="ExpiringQualificationsList" data-smrt-part="empty">
    {emptyMessage ?? t(M['human_resources.expiring_qualifications_list.empty'])}
  </p>
{:else}
  <ul class="smrt-expiring-qualifications__root" data-smrt-component="ExpiringQualificationsList">
    {#each sorted as item (item.id)}
      <li class="smrt-expiring-qualifications__row" data-smrt-part="row">
        <div class="smrt-expiring-qualifications__main" data-smrt-part="body">
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
            <span class="smrt-expiring-qualifications__name">{item.qualificationName}</span>
          {/if}
          <span class="smrt-expiring-qualifications__person">{item.displayName}</span>
        </div>
        <div class="smrt-expiring-qualifications__when" data-smrt-part="meta">
          <span class="smrt-expiring-qualifications__distance">{distance(item.daysUntilExpiry)}</span>
          <span>{t(M['human_resources.expiring_qualifications_list.expires_on'], { date: item.expiresOn })}</span>
        </div>
      </li>
    {/each}
  </ul>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-expiring-qualifications__root {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .smrt-expiring-qualifications__row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0.25rem;
  }
  .smrt-expiring-qualifications__main {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.125rem;
    min-width: 0;
    flex: 1;
  }
  .smrt-expiring-qualifications__when {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.125rem;
  }
  .smrt-expiring-qualifications__empty {
    padding: 1rem 0;
  }
}

@layer smrt.theme {
  .smrt-expiring-qualifications__row {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-expiring-qualifications__row:last-child {
    border-bottom: none;
  }
  .smrt-expiring-qualifications__name,
  .smrt-expiring-qualifications__distance {
    font-weight: 500;
  }
  .smrt-expiring-qualifications__person,
  .smrt-expiring-qualifications__when {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-expiring-qualifications__empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
}

</style>
