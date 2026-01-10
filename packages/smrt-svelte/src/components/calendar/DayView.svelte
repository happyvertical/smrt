<script lang="ts">
/**
 * DayView Component
 * Full event list for a specific day with optional weather
 */

import type { DayEventDetail, DayForecast } from '../../types-generic';

interface Props {
  date: Date;
  events?: DayEventDetail[] | null;
  forecast?: DayForecast | null;
  calendarUrl?: string;
  /** Callback when an event card is clicked */
  onEventClick?: (eventType: string, eventName: string) => void;
}

const {
  date,
  events = null,
  forecast = null,
  calendarUrl = '/events',
  onEventClick,
}: Props = $props();

// Format full date
const formattedDate = $derived(
  date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }),
);

// Get event icon
function getEventIcon(type: DayEventDetail['type']): string {
  switch (type) {
    case 'game':
      return '\u{1F3D2}'; // hockey stick and puck
    case 'meeting':
      return '\u{1F3DB}'; // classical building
    case 'event':
      return '\u{1F4C5}'; // calendar
    default:
      return '\u{1F4C5}';
  }
}

// Get event URL based on type
function getEventUrl(event: DayEventDetail): string | null {
  if (event.type === 'game') {
    return `/sports/hockey/games/${event.slug}/`;
  }
  if (event.type === 'meeting' && event.councilSlug) {
    return `/meetings/${event.councilSlug}/${event.slug}/`;
  }
  // Other events don't have detail pages
  return null;
}

// Group events by type for display
const groupedEvents = $derived(() => {
  if (!events || events.length === 0) return null;

  const groups: Record<string, DayEventDetail[]> = {};
  for (const event of events) {
    if (!groups[event.type]) {
      groups[event.type] = [];
    }
    groups[event.type].push(event);
  }
  return groups;
});

// Get type label
function getTypeLabel(type: string): string {
  switch (type) {
    case 'game':
      return 'Games';
    case 'meeting':
      return 'Meetings';
    case 'event':
      return 'Events';
    default:
      return 'Other';
  }
}
</script>

<div class="day-view">
  <header class="day-header">
    <a href={calendarUrl} class="back-link">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Back to Calendar
    </a>
    <h1 class="date-title">{formattedDate}</h1>

    {#if forecast}
      <div class="weather-summary">
        <span class="weather-icon">{forecast.icon}</span>
        <span class="weather-temps">
          <span class="high">{forecast.high}°</span>
          <span class="low">{forecast.low}°</span>
        </span>
      </div>
    {/if}
  </header>

  <div class="day-content">
    {#if !events || events.length === 0}
      <div class="empty-state">
        <span class="empty-icon">{'\u{1F4C5}'}</span>
        <p class="empty-text">No events scheduled for this day</p>
      </div>
    {:else if groupedEvents()}
      {#each Object.entries(groupedEvents()!) as [type, typeEvents]}
        <section class="event-group">
          <h2 class="group-title">
            <span class="group-icon">{getEventIcon(type as DayEventDetail['type'])}</span>
            {getTypeLabel(type)}
            <span class="group-count">({typeEvents.length})</span>
          </h2>

          <div class="event-list">
            {#each typeEvents as event}
              {@const url = getEventUrl(event)}
              {#if url}
                <a href={url} class="event-card event-card--link" onclick={() => onEventClick?.(event.type, event.name)}>
                  <div class="event-time">{event.startTime}</div>
                  <div class="event-details">
                    <span class="event-name">{event.name}</span>
                    {#if event.venue}
                      <span class="event-venue">{event.venue}</span>
                    {/if}
                  </div>
                  <span class="event-arrow">→</span>
                </a>
              {:else}
                <div class="event-card" onclick={() => onEventClick?.(event.type, event.name)}>
                  <div class="event-time">{event.startTime}</div>
                  <div class="event-details">
                    <span class="event-name">{event.name}</span>
                    {#if event.venue}
                      <span class="event-venue">{event.venue}</span>
                    {/if}
                  </div>
                </div>
              {/if}
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
  .day-view {
    --view-bg: var(--color-neutral-white, #ffffff);
    --view-border: var(--color-neutral-gray200, #e5e7eb);
    --header-bg: var(--color-neutral-gray100, #f5f5f5);
    --card-hover: var(--color-neutral-gray100, #f5f5f5);

    background: var(--view-bg);
  }

  /* Dark mode */
  :global([data-theme="dark"]) .day-view {
    --view-bg: #242424;
    --view-border: #3a3a3a;
    --header-bg: #2e2e2e;
    --card-hover: #3a3a3a;
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"])) .day-view {
      --view-bg: #242424;
      --view-border: #3a3a3a;
      --header-bg: #2e2e2e;
      --card-hover: #3a3a3a;
    }
  }

  .day-header {
    padding: var(--spacing-lg, 1.5rem);
    background: var(--header-bg);
    border-bottom: 1px solid var(--view-border);
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs, 0.25rem);
    color: var(--color-primary-main, #1976d2);
    text-decoration: none;
    font-size: var(--font-size-sm, 0.875rem);
    margin-bottom: var(--spacing-md, 1rem);
    transition: color var(--transition-fast, 150ms);
  }

  .back-link:hover {
    color: var(--color-primary-dark, #0d47a1);
  }

  .date-title {
    margin: 0;
    font-size: var(--font-size-2xl, 1.5rem);
    font-weight: var(--font-weight-semibold, 600);
    color: var(--color-text-primary, #333);
  }

  .weather-summary {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 0.5rem);
    margin-top: var(--spacing-sm, 0.5rem);
  }

  .weather-icon {
    font-size: 24px;
  }

  .weather-temps {
    display: flex;
    gap: var(--spacing-xs, 0.25rem);
    font-size: var(--font-size-lg, 1.125rem);
  }

  .high {
    font-weight: var(--font-weight-semibold, 600);
  }

  .low {
    color: var(--color-text-secondary, #666);
  }

  .day-content {
    padding: var(--spacing-lg, 1.5rem);
  }

  .empty-state {
    text-align: center;
    padding: var(--spacing-3xl, 4rem) var(--spacing-lg, 1.5rem);
    color: var(--color-text-secondary, #666);
  }

  .empty-icon {
    font-size: 48px;
    display: block;
    margin-bottom: var(--spacing-md, 1rem);
    opacity: 0.5;
  }

  .empty-text {
    margin: 0;
    font-size: var(--font-size-lg, 1.125rem);
  }

  .event-group {
    margin-bottom: var(--spacing-xl, 2rem);
  }

  .event-group:last-child {
    margin-bottom: 0;
  }

  .group-title {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 0.5rem);
    margin: 0 0 var(--spacing-md, 1rem) 0;
    font-size: var(--font-size-lg, 1.125rem);
    font-weight: var(--font-weight-semibold, 600);
    color: var(--color-text-primary, #333);
  }

  .group-icon {
    font-size: 20px;
  }

  .group-count {
    font-weight: var(--font-weight-normal, 400);
    color: var(--color-text-secondary, #666);
  }

  .event-list {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm, 0.5rem);
  }

  .event-card {
    display: flex;
    align-items: center;
    gap: var(--spacing-md, 1rem);
    padding: var(--spacing-md, 1rem);
    background: var(--view-bg);
    border: 1px solid var(--view-border);
    border-radius: var(--radius-md, 8px);
    text-decoration: none;
    color: var(--color-text-primary, #333);
    transition: all var(--transition-fast, 150ms);
  }

  .event-card--link:hover {
    background: var(--card-hover);
    border-color: var(--color-neutral-gray300, #d1d5db);
  }

  .event-card--link:hover .event-arrow {
    transform: translateX(4px);
  }

  .event-time {
    flex-shrink: 0;
    width: 80px;
    font-size: var(--font-size-sm, 0.875rem);
    font-weight: var(--font-weight-medium, 500);
    color: var(--color-text-secondary, #666);
  }

  .event-details {
    flex: 1;
    min-width: 0;
  }

  .event-name {
    display: block;
    font-weight: var(--font-weight-medium, 500);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .event-venue {
    display: block;
    font-size: var(--font-size-sm, 0.875rem);
    color: var(--color-text-secondary, #666);
    margin-top: 2px;
  }

  .event-arrow {
    flex-shrink: 0;
    color: var(--color-text-secondary, #666);
    transition: transform var(--transition-fast, 150ms);
  }

  @media (max-width: 640px) {
    .day-header {
      padding: var(--spacing-md, 1rem);
    }

    .date-title {
      font-size: var(--font-size-xl, 1.25rem);
    }

    .day-content {
      padding: var(--spacing-md, 1rem);
    }

    .event-card {
      flex-wrap: wrap;
    }

    .event-time {
      width: 100%;
    }

    .event-details {
      width: 100%;
    }
  }
</style>
