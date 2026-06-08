<script lang="ts">
/**
 * Calendar Component
 * Month view calendar with event indicators and day navigation
 */

import type { DayEventDetail, DayEventsData } from '../../types-generic';

export interface Props {
  events?: DayEventsData[] | null;
  year?: number;
  month?: number; // 0-indexed (0 = January)
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

<div class="calendar">
  <header class="calendar-header">
    <div class="nav-buttons">
      <button class="nav-btn" onclick={prevMonth} aria-label="Previous month">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12 15L7 10L12 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
      <span class="current-month">{MONTHS[currentMonth]} {currentYear}</span>
      <button class="nav-btn" onclick={nextMonth} aria-label="Next month">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M8 5L13 10L8 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>

    <div class="selectors">
      <select
        class="month-select"
        bind:value={currentMonth}
        aria-label="Select month"
      >
        {#each MONTHS as month, i}
          <option value={i}>{month}</option>
        {/each}
      </select>

      <select
        class="year-select"
        bind:value={currentYear}
        aria-label="Select year"
      >
        {#each yearOptions() as year}
          <option value={year}>{year}</option>
        {/each}
      </select>

      <button class="today-btn" onclick={goToToday}>Today</button>
    </div>
  </header>

  <div class="calendar-grid">
    <div class="day-headers">
      {#each DAYS as day}
        <div class="day-header">{day}</div>
      {/each}
    </div>

    <div class="days">
      {#each calendarDays() as { day, month, year, isCurrentMonth, isToday }}
        {@const dayEvents = getEventsForDate(year, month, day)}
        {@const hasEvents = dayEvents.length > 0}
        {@const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`}
        <a
          href={getDayUrl(year, month, day)}
          class="day-cell"
          class:other-month={!isCurrentMonth}
          class:today={isToday}
          class:has-events={hasEvents}
          onclick={() => onDateSelect?.(dateStr, hasEvents)}
        >
          <span class="day-number">{day}</span>
          {#if hasEvents}
            <div class="event-indicators">
              {#each dayEvents.slice(0, 3) as event}
                <span class="event-icon" title={event.name}>{getEventIcon(event.type)}</span>
              {/each}
              {#if dayEvents.length > 3}
                <span class="event-more">+{dayEvents.length - 3}</span>
              {/if}
            </div>
          {/if}
        </a>
      {/each}
    </div>
  </div>
</div>

<style>
  .calendar {
    --calendar-bg: var(--smrt-color-surface, #ffffff);
    --calendar-border: var(--smrt-color-outline-variant, #e5e7eb);
    --calendar-header-bg: var(--smrt-color-surface-container-low, #f5f5f5);
    --day-hover: var(--smrt-color-surface-container-low, #f5f5f5);
    --today-bg: var(--smrt-color-primary-container, #e3f2fd);
    --today-border: var(--smrt-color-primary, #005ac1);
    --other-month: var(--smrt-color-on-surface-variant, #9ca3af);

    background: var(--calendar-bg);
    border: 1px solid var(--calendar-border);
    border-radius: var(--smrt-radius-large, 12px);
    overflow: hidden;
  }

  /*
   * Dark mode. The base `--smrt-color-*` tokens already swap to dark values
   * under the active dark scheme, so reference them directly (issue #1431 —
   * the old `--smrt-color-*-dark` tokens were never emitted). Hardcoded
   * fallbacks preserve the calendar's dark palette when no theme is applied.
   */
  :global([data-theme="dark"]) .calendar {
    --calendar-bg: var(--smrt-color-surface, #242424);
    --calendar-border: var(--smrt-color-outline-variant, #3a3a3a);
    --calendar-header-bg: var(--smrt-color-surface-container-low, #2e2e2e);
    --day-hover: var(--smrt-color-surface-container-high, #3a3a3a);
    --today-bg: var(--smrt-color-primary-container, #1e3a5f);
    --today-border: var(--smrt-color-primary, #64b5f6);
    --other-month: var(--smrt-color-on-surface-variant, #666666);
  }

  @media (prefers-color-scheme: dark) {
    :global(:root:not([data-theme="light"])) .calendar {
      --calendar-bg: var(--smrt-color-surface, #242424);
      --calendar-border: var(--smrt-color-outline-variant, #3a3a3a);
      --calendar-header-bg: var(--smrt-color-surface-container-low, #2e2e2e);
      --day-hover: var(--smrt-color-surface-container-high, #3a3a3a);
      --today-bg: var(--smrt-color-primary-container, #1e3a5f);
      --today-border: var(--smrt-color-primary, #64b5f6);
      --other-month: var(--smrt-color-on-surface-variant, #666666);
    }
  }

  .calendar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--smrt-spacing-4, 1rem) var(--smrt-spacing-6, 1.5rem);
    background: var(--calendar-header-bg);
    border-bottom: 1px solid var(--calendar-border);
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .nav-buttons {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .nav-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: var(--smrt-radius-medium, 8px);
    color: var(--smrt-color-on-surface-variant, #43474e);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .nav-btn:hover {
    background: var(--day-hover);
    color: var(--smrt-color-on-surface, #1b1b1f);
  }

  .current-month {
    font-size: var(--smrt-typography-title-large-size, 1.125rem);
    font-weight: var(--smrt-typography-title-large-weight, 600);
    color: var(--smrt-color-on-surface, #1b1b1f);
    min-width: 160px;
    text-align: center;
  }

  .selectors {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .month-select,
  .year-select {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-2, 0.5rem);
    border: 1px solid var(--calendar-border);
    border-radius: var(--smrt-radius-small, 4px);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    background: var(--calendar-bg);
    cursor: pointer;
  }

  .today-btn {
    padding: var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-4, 1rem);
    border: 1px solid var(--calendar-border);
    border-radius: var(--smrt-radius-small, 4px);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    background: var(--calendar-bg);
    color: var(--smrt-color-primary, #005ac1);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .today-btn:hover {
    background: var(--smrt-color-primary-container, #d6e3ff);
  }

  .calendar-grid {
    padding: var(--smrt-spacing-2, 0.5rem);
  }

  .day-headers {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
    margin-bottom: var(--smrt-spacing-1, 0.25rem);
  }

  .day-header {
    padding: var(--smrt-spacing-2, 0.5rem);
    text-align: center;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .days {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
  }

  .day-cell {
    aspect-ratio: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--smrt-spacing-1, 0.25rem);
    border-radius: var(--smrt-radius-small, 4px);
    text-decoration: none;
    color: var(--smrt-color-on-surface, #1b1b1f);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
    min-height: 60px;
  }

  .day-cell:hover {
    background: var(--day-hover);
  }

  .day-cell.other-month {
    color: var(--other-month);
  }

  .day-cell.other-month:hover {
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .day-cell.today {
    background: var(--today-bg);
    border: 2px solid var(--today-border);
  }

  .day-cell.has-events {
    font-weight: var(--smrt-typography-body-medium-weight, 500);
  }

  .day-number {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    line-height: 1;
  }

  .event-indicators {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    justify-content: center;
    margin-top: auto;
    font-size: 12px;
  }

  .event-icon {
    line-height: 1;
  }

  .event-more {
    font-size: 10px;
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  @media (max-width: 640px) {
    .calendar-header {
      flex-direction: column;
      align-items: stretch;
    }

    .nav-buttons {
      justify-content: center;
    }

    .selectors {
      justify-content: center;
    }

    .day-header {
      font-size: var(--smrt-typography-body-small-size, 0.75rem);
      padding: var(--smrt-spacing-1, 0.25rem);
    }

    .day-cell {
      min-height: 48px;
    }

    .day-number {
      font-size: var(--smrt-typography-body-small-size, 0.75rem);
    }

    .event-indicators {
      font-size: 10px;
    }
  }
</style>
