<script lang="ts">
/**
 * DayView Component
 * Full event list for a specific day with optional weather
 */

import type { DayEventDetail, DayForecast } from '../../types-generic';

export interface Props {
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
              {:else if onEventClick}
                <button
                  type="button"
                  class="event-card event-card--button"
                  onclick={() => onEventClick(event.type, event.name)}
                >
                  <div class="event-time">{event.startTime}</div>
                  <div class="event-details">
                    <span class="event-name">{event.name}</span>
                    {#if event.venue}
                      <span class="event-venue">{event.venue}</span>
                    {/if}
                  </div>
                </button>
              {:else}
                <div class="event-card">
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
    --view-bg: var(--smrt-color-surface, #ffffff);
    --view-border: var(--smrt-color-outline-variant, #e5e7eb);
    --header-bg: var(--smrt-color-surface-container-low, #f5f5f5);
    --card-hover: var(--smrt-color-surface-container-low, #f5f5f5);

    background: var(--view-bg);
  }

  /* Dark mode */
  :global([data-theme="dark"]) .day-view {
    --view-bg: var(--smrt-color-surface-dark, #242424);
    --view-border: var(--smrt-color-outline-variant-dark, #3a3a3a);
    --header-bg: var(--smrt-color-surface-container-low-dark, #2e2e2e);
    --card-hover: var(--smrt-color-surface-container-high-dark, #3a3a3a);
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
    padding: var(--smrt-spacing-6, 1.5rem);
    background: var(--header-bg);
    border-bottom: 1px solid var(--view-border);
  }

  .back-link {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    color: var(--smrt-color-primary, #005ac1);
    text-decoration: none;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    margin-bottom: var(--smrt-spacing-4, 1rem);
    transition: color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .back-link:hover {
    color: var(--smrt-color-on-primary-container, #1b1b1f);
  }

  .date-title {
    margin: 0;
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-headline-small-weight, 600);
    color: var(--smrt-color-on-surface, #333);
  }

  .weather-summary {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-top: var(--smrt-spacing-2, 0.5rem);
  }

  .weather-icon {
    font-size: 24px;
  }

  .weather-temps {
    display: flex;
    gap: var(--smrt-spacing-1, 0.25rem);
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
  }

  .high {
    font-weight: var(--smrt-typography-title-medium-weight, 600);
  }

  .low {
    color: var(--smrt-color-on-surface-variant, #666);
  }

  .day-content {
    padding: var(--smrt-spacing-6, 1.5rem);
  }

  .empty-state {
    text-align: center;
    padding: var(--smrt-spacing-12, 3rem) var(--smrt-spacing-6, 1.5rem);
    color: var(--smrt-color-on-surface-variant, #666);
  }

  .empty-icon {
    font-size: 48px;
    display: block;
    margin-bottom: var(--smrt-spacing-4, 1rem);
    opacity: 0.5;
  }

  .empty-text {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
  }

  .event-group {
    margin-bottom: var(--smrt-spacing-8, 2rem);
  }

  .event-group:last-child {
    margin-bottom: 0;
  }

  .group-title {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin: 0 0 var(--smrt-spacing-4, 1rem) 0;
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    font-weight: var(--smrt-typography-title-medium-weight, 600);
    color: var(--smrt-color-on-surface, #333);
  }

  .group-icon {
    font-size: 20px;
  }

  .group-count {
    font-weight: var(--smrt-typography-body-medium-weight, 400);
    color: var(--smrt-color-on-surface-variant, #666);
  }

  .event-list {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .event-card {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4, 1rem);
    padding: var(--smrt-spacing-4, 1rem);
    background: var(--view-bg);
    border: 1px solid var(--view-border);
    border-radius: var(--smrt-radius-medium, 8px);
    text-decoration: none;
    color: var(--smrt-color-on-surface, #333);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .event-card--button {
    width: 100%;
    border: 0;
    text-align: left;
    font: inherit;
    cursor: pointer;
  }

  .event-card--link:hover {
    background: var(--card-hover);
    border-color: var(--smrt-color-outline, #79747e);
  }

  .event-card--link:hover .event-arrow {
    transform: translateX(4px);
    transition: transform var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .event-time {
    flex-shrink: 0;
    width: 80px;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    color: var(--smrt-color-on-surface-variant, #666);
  }

  .event-details {
    flex: 1;
    min-width: 0;
  }

  .event-name {
    display: block;
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .event-venue {
    display: block;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant, #666);
    margin-top: 2px;
  }

  .event-arrow {
    flex-shrink: 0;
    color: var(--smrt-color-on-surface-variant, #666);
    transition: transform var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  @media (max-width: 640px) {
    .day-header {
      padding: var(--smrt-spacing-4, 1rem);
    }

    .date-title {
      font-size: var(--smrt-typography-title-medium-size, 1.25rem);
    }

    .day-content {
      padding: var(--smrt-spacing-4, 1rem);
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
