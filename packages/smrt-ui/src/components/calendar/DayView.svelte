<script lang="ts">
/**
 * DayView Component
 * Full event list for a specific day with optional weather
 *
 * @deprecated Use `CalendarView` (its day panel, agenda mode, or `dayHref`
 * to a page of your own). This component formats dates as `en-US` in the
 * browser zone and hard-codes game/meeting routes. See the smrt-ui README,
 * "Calendar", for the migration.
 */

import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import type { DayEventDetail, DayForecast } from '../../types-generic';

const { t } = useI18n();

export interface Props {
  /** Date to display events for in this view. */
  date: Date;
  /** Events occurring on the specified date, or null if none exist. */
  events?: DayEventDetail[] | null;
  /** Weather forecast data for the date, or null if unavailable. */
  forecast?: DayForecast | null;
  /** URL for the back link to return to calendar view. */
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

<div class="smrt-day-view__root" data-smrt-component="DayView">
  <header class="smrt-day-view__header" data-smrt-part="header">
    <a href={calendarUrl} class="smrt-day-view__back" data-smrt-part="back">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M10 12L6 8L10 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      {t(M['ui.day_view.back_to_calendar'])}
    </a>
    <h1 class="smrt-day-view__title" data-smrt-part="title">{formattedDate}</h1>

    {#if forecast}
      <div class="smrt-day-view__weather" data-smrt-part="weather">
        <span class="smrt-day-view__weather-icon" data-smrt-part="icon">{forecast.icon}</span>
        <span class="smrt-day-view__temps" data-smrt-part="meta">
          <span class="smrt-day-view__high" data-smrt-part="high">{forecast.high}°</span>
          <span class="smrt-day-view__low" data-smrt-part="low">{forecast.low}°</span>
        </span>
      </div>
    {/if}
  </header>

  <div class="smrt-day-view__content" data-smrt-part="body">
    {#if !events || events.length === 0}
      <div class="smrt-day-view__empty-state" data-smrt-part="empty">
        <span class="smrt-day-view__empty-icon" data-smrt-part="icon">{'\u{1F4C5}'}</span>
        <p class="smrt-day-view__empty-text" data-smrt-part="description">{t(M['ui.day_view.no_events'])}</p>
      </div>
    {:else if groupedEvents()}
      {#each Object.entries(groupedEvents()!) as [type, typeEvents]}
        <section class="smrt-day-view__group" data-smrt-part="group">
          <h2 class="smrt-day-view__group-title" data-smrt-part="title">
            <span class="smrt-day-view__group-icon" data-smrt-part="icon">{getEventIcon(type as DayEventDetail['type'])}</span>
            {getTypeLabel(type)}
            <span class="smrt-day-view__group-count" data-smrt-part="count">({typeEvents.length})</span>
          </h2>

          <div class="smrt-day-view__events" data-smrt-part="list">
            {#each typeEvents as event}
              {@const url = getEventUrl(event)}
              {#if url}
                <a href={url} class="smrt-day-view__event smrt-day-view__event--link" data-smrt-part="event" onclick={() => onEventClick?.(event.type, event.name)}>
                  <div class="smrt-day-view__time" data-smrt-part="time">{event.startTime}</div>
                  <div class="smrt-day-view__details" data-smrt-part="body">
                    <span class="smrt-day-view__name" data-smrt-part="title">{event.name}</span>
                    {#if event.venue}
                      <span class="smrt-day-view__venue" data-smrt-part="venue">{event.venue}</span>
                    {/if}
                  </div>
                  <span class="smrt-day-view__arrow" data-smrt-part="indicator">→</span>
                </a>
              {:else}
                <button
                  type="button"
                  class="smrt-day-view__event smrt-day-view__event--button"
                  data-smrt-part="event"
                  onclick={() => onEventClick?.(event.type, event.name)}
                >
                  <div class="smrt-day-view__time" data-smrt-part="time">{event.startTime}</div>
                  <div class="smrt-day-view__details" data-smrt-part="body">
                    <span class="smrt-day-view__name" data-smrt-part="title">{event.name}</span>
                    {#if event.venue}
                      <span class="smrt-day-view__venue" data-smrt-part="venue">{event.venue}</span>
                    {/if}
                  </div>
                </button>
              {/if}
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-day-view__header {
    padding: var(--smrt-spacing-6, 1.5rem);
  }
  .smrt-day-view__back {
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-1, 0.25rem);
    margin-bottom: var(--smrt-spacing-4, 1rem);
  }
  .smrt-day-view__title {
    margin: 0;
  }
  .smrt-day-view__weather {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin-top: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-day-view__temps {
    display: flex;
    gap: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-day-view__content {
    padding: var(--smrt-spacing-6, 1.5rem);
  }
  .smrt-day-view__empty-state {
    padding: var(--smrt-spacing-12, 3rem) var(--smrt-spacing-6, 1.5rem);
  }
  .smrt-day-view__empty-icon {
    display: block;
    margin-bottom: var(--smrt-spacing-4, 1rem);
  }
  .smrt-day-view__empty-text {
    margin: 0;
  }
  .smrt-day-view__group {
    margin-bottom: var(--smrt-spacing-8, 2rem);
  }
  .smrt-day-view__group:last-child {
    margin-bottom: 0;
  }
  .smrt-day-view__group-title {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    margin: 0 0 var(--smrt-spacing-4, 1rem) 0;
  }
  .smrt-day-view__events {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-day-view__event {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-4, 1rem);
    padding: var(--smrt-spacing-4, 1rem);
  }
  .smrt-day-view__time {
    flex-shrink: 0;
    width: 80px;
  }
  .smrt-day-view__details {
    flex: 1;
    min-width: 0;
  }
  .smrt-day-view__name {
    display: block;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-day-view__venue {
    display: block;
    margin-top: var(--smrt-spacing-1);
  }
  .smrt-day-view__arrow {
    flex-shrink: 0;
  }
  @media (max-width: 640px) {
    .smrt-day-view__header {
      padding: var(--smrt-spacing-4, 1rem);
    }
    .smrt-day-view__content {
      padding: var(--smrt-spacing-4, 1rem);
    }
    .smrt-day-view__event {
      flex-wrap: wrap;
    }
    .smrt-day-view__time {
      width: 100%;
    }
    .smrt-day-view__details {
      width: 100%;
    }
  }
}

@layer smrt.theme {
  .smrt-day-view__root {
    --smrt-day-view-bg: var(--smrt-color-surface);
    --smrt-day-view-border: var(--smrt-color-outline-variant);
    --smrt-day-view-header-bg: var(--smrt-color-surface-container-low);
    --smrt-day-view-card-hover: var(--smrt-color-surface-container-low);
    background: var(--smrt-day-view-bg);
  }
  /*
  * Dark mode. Reference the base `--smrt-color-*` tokens, which already swap
  * to dark values under the active dark scheme (issue #1431 — the old
  * `--smrt-color-*-dark` tokens were never emitted).
  */
  :global([data-theme="dark"]) .smrt-day-view__root {
    --smrt-day-view-bg: var(--smrt-color-surface);
    --smrt-day-view-border: var(--smrt-color-outline-variant);
    --smrt-day-view-header-bg: var(--smrt-color-surface-container-low);
    --smrt-day-view-card-hover: var(--smrt-color-surface-container-high);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"])) .smrt-day-view__root {
      --smrt-day-view-bg: var(--smrt-color-surface);
      --smrt-day-view-border: var(--smrt-color-outline-variant);
      --smrt-day-view-header-bg: var(--smrt-color-surface-container-low);
      --smrt-day-view-card-hover: var(--smrt-color-surface-container-high);
    }
  }
  .smrt-day-view__header {
    background: var(--smrt-day-view-header-bg);
    border-bottom: 1px solid var(--smrt-day-view-border);
  }
  .smrt-day-view__back {
    color: var(--smrt-color-primary);
    text-decoration: none;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    transition: color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-day-view__back:hover {
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-day-view__title {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-headline-small-weight, 600);
    color: var(--smrt-color-on-surface);
  }
  .smrt-day-view__weather-icon {
    font-size: var(--smrt-typography-headline-small-size);
  }
  .smrt-day-view__temps {
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
  }
  .smrt-day-view__high {
    font-weight: var(--smrt-typography-title-medium-weight, 600);
  }
  .smrt-day-view__low {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-day-view__empty-state {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-day-view__empty-icon {
    font-size: var(--smrt-typography-display-medium-size);
    opacity: 0.5;
  }
  .smrt-day-view__empty-text {
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
  }
  .smrt-day-view__group-title {
    font-size: var(--smrt-typography-title-medium-size, 1.125rem);
    font-weight: var(--smrt-typography-title-medium-weight, 600);
    color: var(--smrt-color-on-surface);
  }
  .smrt-day-view__group-icon {
    font-size: var(--smrt-typography-title-large-size);
  }
  .smrt-day-view__group-count {
    font-weight: var(--smrt-typography-body-medium-weight, 400);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-day-view__event {
    background: var(--smrt-day-view-bg);
    border: 1px solid var(--smrt-day-view-border);
    border-radius: var(--smrt-radius-medium);
    text-decoration: none;
    color: var(--smrt-color-on-surface);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-day-view__event--link:hover {
    background: var(--smrt-day-view-card-hover);
    border-color: var(--smrt-hairline-strong-color);
  }
  .smrt-day-view__event--link:hover .smrt-day-view__arrow {
    transform: translateX(4px);
    transition: transform var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-day-view__time {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-day-view__name {
    font-weight: var(--smrt-typography-body-medium-weight, 500);
  }
  .smrt-day-view__venue {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-day-view__arrow {
    color: var(--smrt-color-on-surface-variant);
    transition: transform var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  @media (max-width: 640px) {
    .smrt-day-view__title {
      font-size: var(--smrt-typography-title-medium-size, 1.25rem);
    }
  }
}

</style>
