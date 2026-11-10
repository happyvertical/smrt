<script lang="ts">
/**
 * Calendar Component
 * Month view calendar with event indicators and day navigation
 *
 * @deprecated Use `CalendarView`. This component computes days in the
 * browser's zone, prints English-only names, hard-codes game/meeting/event
 * emoji and `/events/y/m/d` links, and has no phone agenda. See the
 * smrt-ui README, "Calendar", for the migration.
 */

import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import type { DayEventDetail, DayEventsData } from '../../types-generic';

const { t } = useI18n();

export interface Props {
  /** Events data to display on calendar dates, or null to show no events. */
  events?: DayEventsData[] | null;
  /** Initial year to display when the calendar first loads. */
  year?: number;
  /** Initial month to display (zero-indexed, where 0 is January). */
  month?: number; // 0-indexed (0 = January)
  /** Base URL path for constructing day-specific links. */
  baseUrl?: string;
  /** Callback when navigating to prev/next month */
  onMonthNavigate?: (
    direction: 'prev' | 'next',
    year: number,
    month: number,
  ) => void;
  /** Callback when a date cell is clicked */
  onDateSelect?: (date: string, hasEvents: boolean) => void;
  /** Callback when Today button is clicked */
  onTodayClick?: () => void;
}

const {
  events = null,
  year: initialYear = new Date().getFullYear(),
  month: initialMonth = new Date().getMonth(),
  baseUrl = '/events',
  onMonthNavigate,
  onDateSelect,
  onTodayClick,
}: Props = $props();

function getInitialCalendarState() {
  return {
    year: initialYear,
    month: initialMonth,
  };
}

const initialCalendarState = getInitialCalendarState();
let currentYear = $state(initialCalendarState.year);
let currentMonth = $state(initialCalendarState.month);
let appliedInitialYear: number | undefined = initialCalendarState.year;
let appliedInitialMonth: number | undefined = initialCalendarState.month;

$effect(() => {
  if (
    appliedInitialYear === initialYear &&
    appliedInitialMonth === initialMonth
  ) {
    return;
  }

  appliedInitialYear = initialYear;
  appliedInitialMonth = initialMonth;
  currentYear = initialYear;
  currentMonth = initialMonth;
});

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Get first day of month (0 = Sunday)
function getFirstDayOfMonth(year: number, month: number): number {
  return new Date(year, month, 1).getDay();
}

// Get number of days in month
function getDaysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

// Generate calendar grid
const calendarDays = $derived(() => {
  const firstDay = getFirstDayOfMonth(currentYear, currentMonth);
  const daysInMonth = getDaysInMonth(currentYear, currentMonth);
  const daysInPrevMonth = getDaysInMonth(currentYear, currentMonth - 1);

  const days: Array<{
    day: number;
    month: number;
    year: number;
    isCurrentMonth: boolean;
    isToday: boolean;
  }> = [];

  // Previous month days
  for (let i = firstDay - 1; i >= 0; i--) {
    const day = daysInPrevMonth - i;
    const month = currentMonth === 0 ? 11 : currentMonth - 1;
    const year = currentMonth === 0 ? currentYear - 1 : currentYear;
    days.push({ day, month, year, isCurrentMonth: false, isToday: false });
  }

  // Current month days
  const today = new Date();
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday =
      day === today.getDate() &&
      currentMonth === today.getMonth() &&
      currentYear === today.getFullYear();
    days.push({
      day,
      month: currentMonth,
      year: currentYear,
      isCurrentMonth: true,
      isToday,
    });
  }

  // Next month days (fill to 42 cells for 6 rows)
  const remaining = 42 - days.length;
  for (let day = 1; day <= remaining; day++) {
    const month = currentMonth === 11 ? 0 : currentMonth + 1;
    const year = currentMonth === 11 ? currentYear + 1 : currentYear;
    days.push({ day, month, year, isCurrentMonth: false, isToday: false });
  }

  return days;
});

// Get events for a specific date
function getEventsForDate(
  year: number,
  month: number,
  day: number,
): DayEventDetail[] {
  if (!events) return [];

  const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const dayData = events.find((d) => d.date === dateStr);
  return dayData?.events || [];
}

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

// Navigation
function prevMonth() {
  if (currentMonth === 0) {
    currentMonth = 11;
    currentYear--;
  } else {
    currentMonth--;
  }
  onMonthNavigate?.('prev', currentYear, currentMonth);
}

function nextMonth() {
  if (currentMonth === 11) {
    currentMonth = 0;
    currentYear++;
  } else {
    currentMonth++;
  }
  onMonthNavigate?.('next', currentYear, currentMonth);
}

function goToToday() {
  const today = new Date();
  currentYear = today.getFullYear();
  currentMonth = today.getMonth();
  onTodayClick?.();
}

// Generate day URL
function getDayUrl(year: number, month: number, day: number): string {
  return `${baseUrl}/${year}/${month + 1}/${day}`;
}

// Year options (current year +/- 2 years)
const yearOptions = $derived(() => {
  const years = [];
  for (let y = currentYear - 2; y <= currentYear + 2; y++) {
    years.push(y);
  }
  return years;
});
</script>

<div class="smrt-calendar__root" data-smrt-component="Calendar">
  <header class="smrt-calendar__header" data-smrt-part="header">
    <div class="smrt-calendar__nav" data-smrt-part="nav">
      <button class="smrt-calendar__nav-button" data-smrt-part="previous" onclick={prevMonth} aria-label={t(M['ui.calendar.previous_month'])}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12 15L7 10L12 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <span class="smrt-calendar__title" data-smrt-part="title">{MONTHS[currentMonth]} {currentYear}</span>
      <button class="smrt-calendar__nav-button" data-smrt-part="next" onclick={nextMonth} aria-label={t(M['ui.calendar.next_month'])}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M8 5L13 10L8 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>

    <div class="smrt-calendar__selectors" data-smrt-part="selectors">
      <select
        class="smrt-calendar__month"
        data-smrt-part="month"
        bind:value={currentMonth}
        aria-label={t(M['ui.calendar.select_month'])}
      >
        {#each MONTHS as month, i}
          <option value={i}>{month}</option>
        {/each}
      </select>

      <select
        class="smrt-calendar__year"
        data-smrt-part="year"
        bind:value={currentYear}
        aria-label={t(M['ui.calendar.select_year'])}
      >
        {#each yearOptions() as year}
          <option value={year}>{year}</option>
        {/each}
      </select>

      <button class="smrt-calendar__today-button" data-smrt-part="today" onclick={goToToday}>Today</button>
    </div>
  </header>

  <div class="smrt-calendar__grid" data-smrt-part="grid">
    <div class="smrt-calendar__weekdays" data-smrt-part="weekdays">
      {#each DAYS as day}
        <div class="smrt-calendar__weekday" data-smrt-part="weekday">{day}</div>
      {/each}
    </div>

    <div class="smrt-calendar__days" data-smrt-part="days">
      {#each calendarDays() as { day, month, year, isCurrentMonth, isToday }}
        {@const dayEvents = getEventsForDate(year, month, day)}
        {@const hasEvents = dayEvents.length > 0}
        {@const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`}
        <a
          href={getDayUrl(year, month, day)}
          class="smrt-calendar__day"
          class:smrt-calendar__day--other-month={!isCurrentMonth}
          class:smrt-calendar__day--today={isToday}
          class:smrt-calendar__day--has-events={hasEvents}
          data-smrt-part="day"
          onclick={() => onDateSelect?.(dateStr, hasEvents)}
        >
          <span class="smrt-calendar__day-number" data-smrt-part="label">{day}</span>
          {#if hasEvents}
            <div class="smrt-calendar__events" data-smrt-part="events">
              {#each dayEvents.slice(0, 3) as event}
                <span class="smrt-calendar__event" data-smrt-part="event" title={event.name}>{getEventIcon(event.type)}</span>
              {/each}
              {#if dayEvents.length > 3}
                <span class="smrt-calendar__more" data-smrt-part="more">+{dayEvents.length - 3}</span>
              {/if}
            </div>
          {/if}
        </a>
      {/each}
    </div>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-calendar__root {
    overflow: hidden;
  }
  .smrt-calendar__header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-6, 1.5rem);
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-calendar__nav {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-calendar__nav-button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
  }
  .smrt-calendar__title {
    min-width: 160px;
  }
  .smrt-calendar__selectors {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-calendar__month,
  .smrt-calendar__year {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
    cursor: pointer;
  }
  .smrt-calendar__today-button {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-4, 1rem);
  }
  .smrt-calendar__grid {
    padding: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-calendar__weekdays {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: var(--smrt-spacing-1);
    margin-bottom: var(--smrt-spacing-1, 0.25rem);
  }
  .smrt-calendar__weekday {
    padding: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-calendar__days {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: var(--smrt-spacing-1);
  }
  .smrt-calendar__day {
    aspect-ratio: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--smrt-spacing-1, 0.25rem);
    min-height: 60px;
  }
  .smrt-calendar__events {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-1);
    justify-content: center;
    margin-top: auto;
  }
  @media (max-width: 640px) {
    .smrt-calendar__header {
      flex-direction: column;
      align-items: stretch;
    }
    .smrt-calendar__nav {
      justify-content: center;
    }
    .smrt-calendar__selectors {
      justify-content: center;
    }
    .smrt-calendar__weekday {
      padding: var(--smrt-spacing-1, 0.25rem);
    }
    .smrt-calendar__day {
      min-height: 48px;
    }
  }
}

@layer smrt.theme {
  .smrt-calendar__root {
    --smrt-calendar-bg: var(--smrt-color-surface);
    --smrt-calendar-border: var(--smrt-color-outline-variant);
    --smrt-calendar-header-bg: var(--smrt-color-surface-container-low);
    --smrt-calendar-day-hover: var(--smrt-color-surface-container-low);
    --smrt-calendar-today-bg: var(--smrt-color-primary-container);
    --smrt-calendar-today-border: var(--smrt-color-primary);
    --smrt-calendar-other-month: var(--smrt-color-on-surface-variant);
    background: var(--smrt-calendar-bg);
    border: 1px solid var(--smrt-calendar-border);
    border-radius: var(--smrt-radius-large);
  }
  /*
  * Dark mode. The base `--smrt-color-*` tokens already swap to dark values
  * under the active dark scheme, so reference them directly (issue #1431 —
  * the old `--smrt-color-*-dark` tokens were never emitted). Hardcoded
  * fallbacks preserve the calendar's dark palette when no theme is applied.
  */
  :global([data-theme="dark"]) .smrt-calendar__root {
    --smrt-calendar-bg: var(--smrt-color-surface);
    --smrt-calendar-border: var(--smrt-color-outline-variant);
    --smrt-calendar-header-bg: var(--smrt-color-surface-container-low);
    --smrt-calendar-day-hover: var(--smrt-color-surface-container-high);
    --smrt-calendar-today-bg: var(--smrt-color-primary-container);
    --smrt-calendar-today-border: var(--smrt-color-primary);
    --smrt-calendar-other-month: var(--smrt-color-on-surface-variant);
  }
  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"])) .smrt-calendar__root {
      --smrt-calendar-bg: var(--smrt-color-surface);
      --smrt-calendar-border: var(--smrt-color-outline-variant);
      --smrt-calendar-header-bg: var(--smrt-color-surface-container-low);
      --smrt-calendar-day-hover: var(--smrt-color-surface-container-high);
      --smrt-calendar-today-bg: var(--smrt-color-primary-container);
      --smrt-calendar-today-border: var(--smrt-color-primary);
      --smrt-calendar-other-month: var(--smrt-color-on-surface-variant);
    }
  }
  .smrt-calendar__header {
    background: var(--smrt-calendar-header-bg);
    border-bottom: 1px solid var(--smrt-calendar-border);
  }
  .smrt-calendar__nav-button {
    border-radius: var(--smrt-radius-medium);
    color: var(--smrt-color-on-surface-variant);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-calendar__nav-button:hover {
    background: var(--smrt-calendar-day-hover);
    color: var(--smrt-color-on-surface);
  }
  .smrt-calendar__title {
    font-size: var(--smrt-typography-title-large-size, 1.125rem);
    font-weight: var(--smrt-typography-title-large-weight, 600);
    color: var(--smrt-color-on-surface);
    text-align: center;
  }
  .smrt-calendar__month,
  .smrt-calendar__year {
    border: 1px solid var(--smrt-calendar-border);
    border-radius: var(--smrt-radius-small);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    background: var(--smrt-calendar-bg);
  }
  .smrt-calendar__today-button {
    border: 1px solid var(--smrt-calendar-border);
    border-radius: var(--smrt-radius-small);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    background: var(--smrt-calendar-bg);
    color: var(--smrt-color-primary);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-calendar__today-button:hover {
    background: var(--smrt-color-primary-container);
  }
  .smrt-calendar__weekday {
    text-align: center;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-calendar__day {
    border-radius: var(--smrt-radius-small);
    text-decoration: none;
    color: var(--smrt-color-on-surface);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-calendar__day:hover {
    background: var(--smrt-calendar-day-hover);
  }
  .smrt-calendar__day.smrt-calendar__day--other-month {
    color: var(--smrt-calendar-other-month);
  }
  .smrt-calendar__day.smrt-calendar__day--other-month:hover {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-calendar__day.smrt-calendar__day--today {
    background: var(--smrt-calendar-today-bg);
    border: 2px solid var(--smrt-calendar-today-border);
  }
  .smrt-calendar__day.smrt-calendar__day--has-events {
    font-weight: var(--smrt-typography-body-medium-weight, 500);
  }
  .smrt-calendar__day-number {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    line-height: 1;
  }
  .smrt-calendar__events {
    font-size: var(--smrt-typography-label-medium-size);
  }
  .smrt-calendar__event {
    line-height: 1;
  }
  .smrt-calendar__more {
    font-size: var(--smrt-typography-label-small-size);
    color: var(--smrt-color-on-surface-variant);
  }
  @media (max-width: 640px) {
    .smrt-calendar__weekday {
      font-size: var(--smrt-typography-body-small-size, 0.75rem);
    }
    .smrt-calendar__day-number {
      font-size: var(--smrt-typography-body-small-size, 0.75rem);
    }
    .smrt-calendar__events {
      font-size: var(--smrt-typography-label-small-size);
    }
  }
}

</style>
