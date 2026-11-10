<script lang="ts">
/**
 * CalendarView — generic month and week grids with a phone agenda.
 *
 * - `month` mode: a month grid (`role="grid"`, roving focus, arrow keys).
 *   All-day and multi-day items render as bands across the days they cover;
 *   a day that has more than fits shows "+N more", which opens the day in a
 *   panel under the grid (never a modal) or follows `dayHref`.
 * - `week` mode: one seven-day grid controlled by `date`. In `auto`,
 *   `autoMode="week"` selects a week grid with its seven-day phone agenda.
 * - `agenda` mode: a scrollable strip of the month's days above a day-by-day
 *   list. `auto` (default) uses the agenda below 48rem, the grid above.
 *
 * Every day is computed in `timeZone` (IANA) and every name comes from
 * `Intl` in `locale`, so the browser's own zone and language never leak in.
 * The visible month and selected day can be controlled (`year`/`month`,
 * `selectedDate`) and are reported through `onNavigate` / `onSelectDate`,
 * so a page can keep them in its URL.
 */
import type { Snippet } from 'svelte';
import { tick } from 'svelte';
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import {
  addDays,
  addMonthsToKey,
  type CalendarEntry,
  type CalendarItem,
  type CalendarMode,
  type CalendarMonth,
  type CalendarNavigation,
  defaultTimeZone,
  defaultWeekStart,
  entriesOnDay,
  formatKey,
  layoutMonth,
  layoutWeek,
  monthKeys,
  monthOfKey,
  monthWeeks,
  parseKey,
  resolveTimeZone,
  shiftMonth,
  todayKey,
  toEntries,
  toneFor,
  weekdayOfKey,
  weekKeys,
} from './calendar-model.js';

export interface Props {
  /** Items to show. */
  items?: CalendarItem[];
  /** Visible year (controlled together with `month`). */
  year?: number;
  /** Visible month, 1-12 (controlled together with `year`). */
  month?: number;
  /** A YYYY-MM-DD date in the visible week (controlled). */
  date?: string;
  /** Desktop grid in auto mode; defaults to month. */
  autoMode?: 'month' | 'week';
  /** Selected day as `YYYY-MM-DD` (controlled). */
  selectedDate?: string | null;
  /** IANA time zone every day is computed in. Defaults to the browser's. */
  timeZone?: string;
  /** BCP 47 locale for month/day names and times. Defaults to the i18n locale. */
  locale?: string;
  /** First weekday column, 0 = Sunday. Defaults to the locale's. */
  weekStartsOn?: number;
  /** `auto` switches to the agenda below 48rem. */
  mode?: CalendarMode;
  /** Rows per day in either grid, including band rows. */
  maxPerDay?: number;
  /** Heading level of the visible period title. */
  headingLevel?: 2 | 3 | 4;
  /**
   * "Now", for today highlighting (tests, server rendering). Without it the
   * calendar reads the clock after mount and moves "today" at midnight in
   * `timeZone`; before mount (server rendering) nothing is highlighted as
   * today. Server-rendered pages should pass `timeZone` and `year`/`month`
   * (or `now`) so the server and the browser pick the same month.
   */
  now?: Date;
  /** Reports month navigation, or week navigation with its first date key. */
  onNavigate?: (period: CalendarNavigation) => void;
  /** Called when a day is selected. */
  onSelectDate?: (date: string) => void;
  /** Called when an item is activated (also for items with `href`). */
  onItemSelect?: (item: CalendarItem) => void;
  /** Link for a day; days become links and "+N more" follows it. */
  dayHref?: (date: string) => string | undefined;
  /** Custom row content for an item in the day panel and agenda. */
  itemContent?: Snippet<[CalendarItem, { time: string }]>;
  /** Extra class on the root. */
  class?: string;
}

let {
  items = [],
  year,
  month,
  date,
  autoMode = 'month',
  selectedDate = null,
  timeZone: timeZoneProp,
  locale: localeProp,
  weekStartsOn: weekStartsOnProp,
  mode = 'auto',
  maxPerDay = 3,
  headingLevel = 2,
  now,
  onNavigate,
  onSelectDate,
  onItemSelect,
  dayHref,
  itemContent,
  class: className = '',
}: Props = $props();

const i18n = useI18n();
const t = i18n.t;
const uid = $props.id();

// An invalid zone (a typo, one this runtime lacks) would throw a RangeError
// from every Intl call in the deriveds below; fall back and say so instead.
const timeZone = $derived(
  resolveTimeZone(timeZoneProp, (invalid) =>
    console.warn(
      `[CalendarView] unknown time zone "${invalid}"; using ${defaultTimeZone()}`,
    ),
  ),
);
const locale = $derived(localeProp || i18n.locale || 'en');
const weekStartsOn = $derived(
  weekStartsOnProp === undefined
    ? defaultWeekStart(locale)
    : ((Math.floor(weekStartsOnProp) % 7) + 7) % 7,
);
// The clock is read after mount, never during server rendering (the server's
// clock and zone are not the reader's), and re-read each minute so "today"
// moves at midnight in `timeZone`.
let clock = $state<Date | undefined>(undefined);
$effect(() => {
  if (now) return;
  clock = new Date();
  const timer = setInterval(() => {
    const next = new Date();
    if (!clock || todayKey(timeZone, next) !== todayKey(timeZone, clock)) {
      clock = next;
    }
  }, 60_000);
  return () => clearInterval(timer);
});
const reference = $derived(now ?? clock);
/** Today's key, or '' before the clock is known (nothing is "today"). */
const today = $derived(reference ? todayKey(timeZone, reference) : '');
/** The month shown when nothing controls it: today's, else the render clock's. */
const fallbackKey = $derived(today || todayKey(timeZone));

// Overridable deriveds: follow the controlling props, and take local
// navigation until those props change again.
let current = $derived<CalendarMonth>(
  year !== undefined && month !== undefined
    ? { year, month }
    : selectedDate
      ? monthOfKey(selectedDate)
      : monthOfKey(fallbackKey),
);
const isWeek = $derived(
  mode === 'week' || (mode === 'auto' && autoMode === 'week'),
);
let currentDate = $derived(
  date ??
    selectedDate ??
    (year !== undefined && month !== undefined
      ? formatKey(year, month, 1)
      : fallbackKey),
);
const visibleWeekKeys = $derived(weekKeys(currentDate, weekStartsOn));
let selected = $derived<string | null>(selectedDate ?? null);
let focusKey = $derived(
  isWeek
    ? selected && visibleWeekKeys.includes(selected)
      ? selected
      : visibleWeekKeys.includes(today)
        ? today
        : visibleWeekKeys[0]
    : selected && sameMonth(selected, current)
      ? selected
      : today && sameMonth(today, current)
        ? today
        : formatKey(current.year, current.month, 1),
);

let isPhone = $state(false);
$effect(() => {
  if (mode !== 'auto' || typeof window.matchMedia !== 'function') return;
  const query = window.matchMedia('(max-width: 48rem)');
  isPhone = query.matches;
  const onChange = (event: MediaQueryListEvent) => {
    isPhone = event.matches;
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
});
const view = $derived(mode === 'auto' ? (isPhone ? 'agenda' : autoMode) : mode);

let root: HTMLElement | undefined = $state();

const entries = $derived(
  toEntries(items, timeZone, (item) =>
    console.warn(
      `[CalendarView] item "${item.id}" has an invalid start or end and was skipped`,
    ),
  ),
);
const weeks = $derived(
  isWeek
    ? [layoutWeek(currentDate, entries, { weekStartsOn, maxPerDay })]
    : layoutMonth(current, entries, { weekStartsOn, maxPerDay }),
);
const daysOfMonth = $derived(isWeek ? visibleWeekKeys : monthKeys(current));
const agendaDays = $derived(
  daysOfMonth
    .map((key) => ({ key, entries: entriesOnDay(entries, key) }))
    .filter((day) => day.entries.length > 0 || day.key === selected),
);
const selectedEntries = $derived(
  selected ? entriesOnDay(entries, selected) : [],
);

// ---- Intl formatting (all in `timeZone` / `locale`) ----

const monthTitle = $derived(
  isWeek
    ? new Intl.DateTimeFormat(locale, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC',
      }).formatRange(keyDate(visibleWeekKeys[0]), keyDate(visibleWeekKeys[6]))
    : new Intl.DateTimeFormat(locale, {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      }).format(Date.UTC(current.year, current.month - 1, 15)),
);
const longDateFormat = $derived(
  new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }),
);
const shortDateFormat = $derived(
  new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }),
);
const timeFormat = $derived(
  new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }),
);
const plural = $derived(new Intl.PluralRules(locale));
const weekdays = $derived(
  monthWeeks(current, weekStartsOn)[0].map((key) => {
    const date = keyDate(key);
    return {
      short: new Intl.DateTimeFormat(locale, {
        weekday: 'short',
        timeZone: 'UTC',
      }).format(date),
      narrow: new Intl.DateTimeFormat(locale, {
        weekday: 'narrow',
        timeZone: 'UTC',
      }).format(date),
      long: new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        timeZone: 'UTC',
      }).format(date),
    };
  }),
);

function keyDate(key: string): Date {
  const { year: y, month: m, day } = parseKey(key);
  return new Date(Date.UTC(y, m - 1, day, 12));
}

function sameMonth(key: string, value: CalendarMonth): boolean {
  const parts = parseKey(key);
  return parts.year === value.year && parts.month === value.month;
}

function longDate(key: string): string {
  return longDateFormat.format(keyDate(key));
}

function countLabel(count: number): string {
  return plural.select(count) === 'one'
    ? t(M['ui.calendar.items_one'])
    : t(M['ui.calendar.items_other'], { count });
}

function dayLabel(key: string, count: number): string {
  const base = longDate(key);
  return count > 0 ? `${base}, ${countLabel(count)}` : base;
}

function timeLabel(entry: CalendarEntry, dayKey?: string): string {
  if (entry.allDay || (dayKey && entry.startKey !== dayKey)) {
    return t(M['ui.calendar.all_day']);
  }
  return timeFormat.format(entry.startMs);
}

function spanNote(entry: CalendarEntry): string | null {
  if (entry.startKey === entry.endKey) return null;
  return t(M['ui.calendar.until'], {
    date: shortDateFormat.format(keyDate(entry.endKey)),
  });
}

function itemStyle(item: CalendarItem): string {
  return item.color ? `--smrt-calendar-view-item: ${item.color};` : '';
}

// ---- Navigation and selection ----

function navigate(next: CalendarMonth): void {
  current = next;
  onNavigate?.(next);
}

function navigateWeek(key: string): void {
  currentDate = key;
  current = monthOfKey(key);
  const first = weekKeys(key, weekStartsOn)[0];
  onNavigate?.({ ...monthOfKey(first), date: first });
}

function stepPeriod(delta: number): void {
  if (isWeek) navigateWeek(addDays(currentDate, delta * 7));
  else navigate(shiftMonth(current, delta));
}

function goToday(): void {
  const key = today || todayKey(timeZone);
  const target = monthOfKey(key);
  if (isWeek) {
    navigateWeek(key);
  } else if (target.year !== current.year || target.month !== current.month) {
    navigate(target);
  }
  focusKey = key;
  if (view === 'agenda') selectDay(key);
}

function selectDay(key: string): void {
  selected = key;
  focusKey = key;
  onSelectDate?.(key);
  if (view === 'agenda') void revealAgendaDay(key);
}

function closeDay(): void {
  const key = selected;
  selected = null;
  if (key) void focusDay(key);
}

async function focusDay(key: string): Promise<void> {
  await tick();
  root
    ?.querySelector<HTMLElement>(`[data-cv-day="${key}"]`)
    ?.focus({ preventScroll: false });
}

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

async function revealAgendaDay(key: string): Promise<void> {
  await tick();
  const behavior = reducedMotion() ? 'auto' : 'smooth';
  root
    ?.querySelector<HTMLElement>(`[data-cv-agenda-day="${key}"]`)
    ?.scrollIntoView?.({ behavior, block: 'start' });
}

function moveFocus(key: string): void {
  if (isWeek) {
    if (!visibleWeekKeys.includes(key)) navigateWeek(key);
  } else if (!sameMonth(key, current)) navigate(monthOfKey(key));
  focusKey = key;
  void focusDay(key);
}

function onGridKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const key = target?.dataset.cvDay;
  if (!key) return;
  const column = (weekdayOfKey(key) - weekStartsOn + 7) % 7;
  let next: string | null = null;
  switch (event.key) {
    case 'ArrowLeft':
      next = addDays(key, -1);
      break;
    case 'ArrowRight':
      next = addDays(key, 1);
      break;
    case 'ArrowUp':
      next = addDays(key, -7);
      break;
    case 'ArrowDown':
      next = addDays(key, 7);
      break;
    case 'Home':
      next = addDays(key, -column);
      break;
    case 'End':
      next = addDays(key, 6 - column);
      break;
    case 'PageUp':
      next = isWeek ? addDays(key, -7) : addMonthsToKey(key, -1);
      break;
    case 'PageDown':
      next = isWeek ? addDays(key, 7) : addMonthsToKey(key, 1);
      break;
    default:
      return;
  }
  event.preventDefault();
  moveFocus(next);
}

function onStripKeydown(event: KeyboardEvent): void {
  const key = (event.target as HTMLElement | null)?.dataset.cvDay;
  if (!key) return;
  const last = daysOfMonth[daysOfMonth.length - 1];
  let next: string | null = null;
  if (event.key === 'ArrowLeft') next = addDays(key, -1);
  else if (event.key === 'ArrowRight') next = addDays(key, 1);
  else if (event.key === 'Home') next = daysOfMonth[0];
  else if (event.key === 'End') next = last;
  if (!next) return;
  event.preventDefault();
  moveFocus(next);
}

function activateItem(item: CalendarItem): void {
  onItemSelect?.(item);
}

$effect(() => {
  // Keep the selected (or focused) day visible in the agenda strip.
  if (view !== 'agenda' || !root) return;
  const key = focusKey;
  void tick().then(() => {
    root
      ?.querySelector<HTMLElement>(
        `.smrt-calendar-view__strip [data-cv-day="${key}"]`,
      )
      ?.scrollIntoView?.({ block: 'nearest', inline: 'center' });
  });
});
</script>

{#snippet itemRow(entry: CalendarEntry, dayKey: string)}
  {@const item = entry.item}
  {@const time = timeLabel(entry, dayKey)}
  {@const note = spanNote(entry)}
  {#if item.href}
    <a
      class="smrt-calendar-view__row" data-smrt-part="row"
      data-tone={toneFor(item)}
      style={itemStyle(item)}
      href={item.href}
      onclick={() => activateItem(item)}
    >
      {#if itemContent}
        {@render itemContent(item, { time })}
      {:else}
        <span class="smrt-calendar-view__row-time" data-smrt-part="row-time">{time}</span>
        <span class="smrt-calendar-view__row-main" data-smrt-part="row-main">
          <span class="smrt-calendar-view__row-title" data-smrt-part="row-title">{item.title}</span>
          {#if item.label || note}
            <span class="smrt-calendar-view__row-meta" data-smrt-part="row-meta">
              {#if item.label}<span class="smrt-calendar-view__row-label" data-smrt-part="row-label">{item.label}</span>{/if}
              {#if note}<span>{note}</span>{/if}
            </span>
          {/if}
        </span>
      {/if}
    </a>
  {:else}
    <button
      type="button"
      class="smrt-calendar-view__row" data-smrt-part="row"
      data-tone={toneFor(item)}
      style={itemStyle(item)}
      onclick={() => activateItem(item)}
    >
      {#if itemContent}
        {@render itemContent(item, { time })}
      {:else}
        <span class="smrt-calendar-view__row-time" data-smrt-part="row-time">{time}</span>
        <span class="smrt-calendar-view__row-main" data-smrt-part="row-main">
          <span class="smrt-calendar-view__row-title" data-smrt-part="row-title">{item.title}</span>
          {#if item.label || note}
            <span class="smrt-calendar-view__row-meta" data-smrt-part="row-meta">
              {#if item.label}<span class="smrt-calendar-view__row-label" data-smrt-part="row-label">{item.label}</span>{/if}
              {#if note}<span>{note}</span>{/if}
            </span>
          {/if}
        </span>
      {/if}
    </button>
  {/if}
{/snippet}

<div
  bind:this={root}
  class="smrt-calendar-view__root {className}"
  class:smrt-calendar-view__agenda-view={view === 'agenda'}
  data-view={view} data-smrt-component="CalendarView"
>
  <header class="smrt-calendar-view__header" data-smrt-part="header">
    <svelte:element
      this={`h${headingLevel}`}
      class="smrt-calendar-view__title" data-smrt-part="title"
      id="cv-title-{uid}"
      aria-live="polite"
    >
      {monthTitle}
    </svelte:element>
    <div class="smrt-calendar-view__nav" data-smrt-part="nav">
      <button
        type="button"
        class="smrt-calendar-view__icon-btn" data-smrt-part="previous"
        aria-label={t(M[isWeek ? 'ui.calendar.previous_week' : 'ui.calendar.previous_month'])}
        onclick={() => stepPeriod(-1)}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M12 15L7 10L12 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button type="button" class="smrt-calendar-view__today-btn" data-smrt-part="today" onclick={goToday}>
        {t(M['ui.calendar.today'])}
      </button>
      <button
        type="button"
        class="smrt-calendar-view__icon-btn" data-smrt-part="next"
        aria-label={t(M[isWeek ? 'ui.calendar.next_week' : 'ui.calendar.next_month'])}
        onclick={() => stepPeriod(1)}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M8 5L13 10L8 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </header>

  {#if view === 'month' || view === 'week'}
    <div
      class="smrt-calendar-view__grid" data-smrt-part="grid"
      role="grid"
      aria-labelledby="cv-title-{uid}"
      tabindex="-1"
      onkeydown={onGridKeydown}
    >
      <div class="smrt-calendar-view__weekdays" data-smrt-part="weekdays" role="row">
        {#each weekdays as weekday (weekday.long)}
          <div class="smrt-calendar-view__weekday" data-smrt-part="weekday" role="columnheader">
            <span aria-hidden="true">{weekday.short}</span>
            <span class="smrt-calendar-view__sr" data-smrt-part="label">{weekday.long}</span>
          </div>
        {/each}
      </div>
      {#each weeks as week (week.days[0].key)}
        <div
          class="smrt-calendar-view__week" data-smrt-part="week"
          role="row"
          style="grid-template-rows: var(--smrt-calendar-view-daynum-h) {week.lanes > 0
            ? `repeat(${week.lanes}, var(--smrt-calendar-view-band-row))`
            : ''} auto;"
        >
          {#each week.days as day, column (day.key)}
            {@const href = dayHref?.(day.key)}
            <div
              class="smrt-calendar-view__day" data-smrt-part="day"
              class:smrt-calendar-view__day--out={!isWeek && !day.inMonth}
              class:smrt-calendar-view__day--today={day.key === today}
              class:smrt-calendar-view__day--selected={day.key === selected}
              role="gridcell"
              aria-selected={day.key === selected}
              style="grid-column: {column + 1};"
            >
              {#if href}
                <a
                  class="smrt-calendar-view__daynum" data-smrt-part="daynum"
                  {href}
                  data-cv-day={day.key}
                  tabindex={day.key === focusKey ? 0 : -1}
                  aria-label={dayLabel(day.key, day.all.length)}
                  aria-current={day.key === today ? 'date' : undefined}
                  onclick={() => {
                    focusKey = day.key;
                    onSelectDate?.(day.key);
                  }}
                >
                  {day.day}
                </a>
              {:else}
                <button
                  type="button"
                  class="smrt-calendar-view__daynum" data-smrt-part="daynum"
                  data-cv-day={day.key}
                  tabindex={day.key === focusKey ? 0 : -1}
                  aria-label={dayLabel(day.key, day.all.length)}
                  aria-current={day.key === today ? 'date' : undefined}
                  aria-pressed={day.key === selected}
                  onclick={() => selectDay(day.key)}
                >
                  {day.day}
                </button>
              {/if}
              <div
                class="smrt-calendar-view__day-body" data-smrt-part="day-body"
                style="padding-top: calc({week.lanes} * var(--smrt-calendar-view-band-row));"
                aria-hidden="true"
              >
                {#each day.visible as entry (entry.item.id)}
                  {#if entry.item.href}
                    <a
                      class="smrt-calendar-view__chip" data-smrt-part="chip"
                      data-tone={toneFor(entry.item)}
                      style={itemStyle(entry.item)}
                      href={entry.item.href}
                      tabindex="-1"
                      title={entry.item.title}
                      onclick={() => activateItem(entry.item)}
                    >
                      <span class="smrt-calendar-view__chip-time" data-smrt-part="chip-time">{timeFormat.format(entry.startMs)}</span>
                      <span class="smrt-calendar-view__chip-title" data-smrt-part="chip-title">{entry.item.title}</span>
                    </a>
                  {:else}
                    <button
                      type="button"
                      class="smrt-calendar-view__chip" data-smrt-part="chip"
                      data-tone={toneFor(entry.item)}
                      style={itemStyle(entry.item)}
                      tabindex="-1"
                      title={entry.item.title}
                      onclick={() => activateItem(entry.item)}
                    >
                      <span class="smrt-calendar-view__chip-time" data-smrt-part="chip-time">{timeFormat.format(entry.startMs)}</span>
                      <span class="smrt-calendar-view__chip-title" data-smrt-part="chip-title">{entry.item.title}</span>
                    </button>
                  {/if}
                {/each}
                {#if day.hiddenCount > 0}
                  {#if href}
                    <a class="smrt-calendar-view__more" data-smrt-part="more" {href} tabindex="-1">
                      <span class="smrt-calendar-view__more-long" data-smrt-part="more-long">{t(M['ui.calendar.more'], { count: day.hiddenCount })}</span>
                      <span class="smrt-calendar-view__more-short" data-smrt-part="more-short">{t(M['ui.calendar.more_short'], { count: day.hiddenCount })}</span>
                    </a>
                  {:else}
                    <button
                      type="button"
                      class="smrt-calendar-view__more" data-smrt-part="more"
                      tabindex="-1"
                      onclick={() => {
                        selectDay(day.key);
                        void focusDay(day.key);
                      }}
                    >
                      <span class="smrt-calendar-view__more-long" data-smrt-part="more-long">{t(M['ui.calendar.more'], { count: day.hiddenCount })}</span>
                      <span class="smrt-calendar-view__more-short" data-smrt-part="more-short">{t(M['ui.calendar.more_short'], { count: day.hiddenCount })}</span>
                    </button>
                  {/if}
                {/if}
              </div>
            </div>
          {/each}
          {#each week.bands as band (band.entry.item.id)}
            {@const item = band.entry.item}
            {#if item.href}
              <a
                class="smrt-calendar-view__band" data-smrt-part="band"
                class:smrt-calendar-view__band--before={band.continuesBefore}
                class:smrt-calendar-view__band--after={band.continuesAfter}
                data-tone={toneFor(item)}
                style="{itemStyle(item)} grid-column: {band.column + 1} / span {band.span}; grid-row: {band.lane + 2};"
                href={item.href}
                tabindex="-1"
                aria-hidden="true"
                title={item.title}
                onclick={() => activateItem(item)}
              >
                {item.title}
              </a>
            {:else}
              <button
                type="button"
                class="smrt-calendar-view__band" data-smrt-part="band"
                class:smrt-calendar-view__band--before={band.continuesBefore}
                class:smrt-calendar-view__band--after={band.continuesAfter}
                data-tone={toneFor(item)}
                style="{itemStyle(item)} grid-column: {band.column + 1} / span {band.span}; grid-row: {band.lane + 2};"
                tabindex="-1"
                aria-hidden="true"
                title={item.title}
                onclick={() => activateItem(item)}
              >
                {item.title}
              </button>
            {/if}
          {/each}
        </div>
      {/each}
    </div>

    {#if selected && !dayHref && (isWeek ? visibleWeekKeys.includes(selected) : sameMonth(selected, current))}
      <section class="smrt-calendar-view__day-panel" data-smrt-part="day-panel" aria-labelledby="cv-day-{uid}">
        <div class="smrt-calendar-view__day-panel-head" data-smrt-part="day-panel-head">
          <h3 class="smrt-calendar-view__day-title" data-smrt-part="day-title" id="cv-day-{uid}">{longDate(selected)}</h3>
          <button
            type="button"
            class="smrt-calendar-view__icon-btn" data-smrt-part="close"
            aria-label={t(M['ui.calendar.close_day'], { date: longDate(selected) })}
            onclick={closeDay}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 5L15 15M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        {#if selectedEntries.length === 0}
          <p class="smrt-calendar-view__empty" data-smrt-part="empty">{t(M['ui.calendar.nothing_day'])}</p>
        {:else}
          <ul class="smrt-calendar-view__rows" data-smrt-part="rows">
            {#each selectedEntries as entry (entry.item.id)}
              <li>{@render itemRow(entry, selected)}</li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {:else}
    <div
      class="smrt-calendar-view__strip" data-smrt-part="strip"
      role="toolbar"
      tabindex="-1"
      aria-label={t(M['ui.calendar.days_in'], { month: monthTitle })}
      onkeydown={onStripKeydown}
    >
      {#each daysOfMonth as key (key)}
        {@const count = entriesOnDay(entries, key).length}
        {@const weekday = weekdays[(weekdayOfKey(key) - weekStartsOn + 7) % 7]}
        <button
          type="button"
          class="smrt-calendar-view__strip-day" data-smrt-part="strip-day"
          class:smrt-calendar-view__strip-day--today={key === today}
          data-cv-day={key}
          tabindex={key === focusKey ? 0 : -1}
          aria-label={dayLabel(key, count)}
          aria-pressed={key === selected}
          aria-current={key === today ? 'date' : undefined}
          onclick={() => selectDay(key)}
        >
          <span class="smrt-calendar-view__strip-weekday" data-smrt-part="strip-weekday" aria-hidden="true">{weekday.narrow}</span>
          <span class="smrt-calendar-view__strip-num" data-smrt-part="strip-num" aria-hidden="true">{parseKey(key).day}</span>
          <span class="smrt-calendar-view__strip-dot" data-smrt-part="strip-dot" class:smrt-calendar-view__strip-dot--on={count > 0} aria-hidden="true"></span>
        </button>
      {/each}
    </div>

    {#if agendaDays.length === 0}
      <p class="smrt-calendar-view__empty" data-smrt-part="empty">{t(M[isWeek ? 'ui.calendar.nothing_week' : 'ui.calendar.nothing_month'])}</p>
    {:else}
      <ol class="smrt-calendar-view__agenda" data-smrt-part="agenda">
        {#each agendaDays as day (day.key)}
          <li
            class="smrt-calendar-view__agenda-day" data-smrt-part="agenda-day"
            class:smrt-calendar-view__agenda-day--today={day.key === today}
            data-cv-agenda-day={day.key}
            aria-labelledby="cv-agenda-{uid}-{day.key}"
          >
            <h3 class="smrt-calendar-view__agenda-date" data-smrt-part="agenda-date" id="cv-agenda-{uid}-{day.key}">
              {#if dayHref?.(day.key)}
                <a href={dayHref(day.key)}>{longDate(day.key)}</a>
              {:else}
                {longDate(day.key)}
              {/if}
            </h3>
            {#if day.entries.length === 0}
              <p class="smrt-calendar-view__empty" data-smrt-part="empty">{t(M['ui.calendar.nothing_day'])}</p>
            {:else}
              <ul class="smrt-calendar-view__rows" data-smrt-part="rows">
                {#each day.entries as entry (entry.item.id)}
                  <li>{@render itemRow(entry, day.key)}</li>
                {/each}
              </ul>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-calendar-view__root {
    --smrt-calendar-view-daynum-h: 2.75rem;
    --smrt-calendar-view-band-row: 1.625rem;
    --smrt-calendar-view-target: 2.75rem;
    overflow: hidden;
    min-width: 0;
    container-type: inline-size;
  }
  .smrt-calendar-view__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-calendar-view__title {
    margin: 0;
    overflow-wrap: anywhere;
    min-width: 0;
  }
  .smrt-calendar-view__nav {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    flex-shrink: 0;
  }
  .smrt-calendar-view__icon-btn,
  .smrt-calendar-view__today-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--smrt-calendar-view-target);
    min-height: var(--smrt-calendar-view-target);
    cursor: pointer;
  }
  .smrt-calendar-view__today-btn {
    padding: 0 var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-calendar-view__sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }
  .smrt-calendar-view__weekdays,
  .smrt-calendar-view__week {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }
  .smrt-calendar-view__weekday {
    padding: var(--smrt-spacing-2, 0.5rem) 0;
  }
  .smrt-calendar-view__week {
    position: relative;
  }
  .smrt-calendar-view__day {
    grid-row: 1 / -1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 6.5rem;
  }
  .smrt-calendar-view__daynum {
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    height: var(--smrt-calendar-view-daynum-h);
    min-height: var(--smrt-calendar-view-target);
    padding: var(--smrt-spacing-2, 0.5rem);
    cursor: pointer;
    width: 100%;
  }
  .smrt-calendar-view__day-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-1, 0.25rem);
    min-width: 0;
  }
  .smrt-calendar-view__chip,
  .smrt-calendar-view__more {
    display: flex;
    gap: 0.25rem;
    align-items: baseline;
    min-width: 0;
    padding: 1px var(--smrt-spacing-1, 0.25rem);
    cursor: pointer;
    white-space: nowrap;
  }
  .smrt-calendar-view__chip::before {
    /* The tone dot exists only because of this generated content. */
    content: '';
    flex-shrink: 0;
    align-self: center;
    width: 0.5rem;
    height: 0.5rem;
  }
  .smrt-calendar-view__chip,
  .smrt-calendar-view__more {
    overflow: hidden;
  }
  .smrt-calendar-view__chip-time {
    flex-shrink: 0;
  }
  .smrt-calendar-view__more-short {
    display: none;
  }
  /* Narrow grids (a phone forced into month mode): dots and titles only. */
  @container (max-width: 40rem) {
    .smrt-calendar-view__chip-time,
    .smrt-calendar-view__more-long {
      display: none;
    }
    .smrt-calendar-view__more-short {
      display: inline;
    }
  }
  .smrt-calendar-view__chip-title {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .smrt-calendar-view__band {
    z-index: 1;
    align-self: center;
    margin: 0 var(--smrt-spacing-1, 0.25rem);
    height: calc(var(--smrt-calendar-view-band-row) - 4px);
    padding: 0 var(--smrt-spacing-2, 0.5rem);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    min-width: 0;
  }
  .smrt-calendar-view__band--before {
    margin-inline-start: 0;
  }
  .smrt-calendar-view__band--after {
    margin-inline-end: 0;
  }
  /* ---- Day panel and agenda rows ---- */
  .smrt-calendar-view__day-panel {
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-calendar-view__day-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-calendar-view__day-title,
  .smrt-calendar-view__agenda-date {
    margin: 0;
  }
  .smrt-calendar-view__rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-calendar-view__row {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    width: 100%;
    min-height: var(--smrt-calendar-view-target);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    cursor: pointer;
  }
  .smrt-calendar-view__row-time {
    flex: 0 0 4.5rem;
  }
  .smrt-calendar-view__row-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .smrt-calendar-view__row-title {
    overflow-wrap: anywhere;
  }
  .smrt-calendar-view__row-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  /* Tone is a fill with its own ink, never a text color (brand rule). */
  .smrt-calendar-view__row-label {
    padding: 0 0.375rem;
  }
  .smrt-calendar-view__empty {
    margin: var(--smrt-spacing-2, 0.5rem) 0;
  }
  /* ---- Agenda ---- */
  .smrt-calendar-view__strip {
    display: flex;
    gap: var(--smrt-spacing-2, 0.5rem);
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scroll-snap-type: x proximity;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-calendar-view__strip-day {
    flex: 0 0 var(--smrt-calendar-view-target);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-height: 3.5rem;
    padding: var(--smrt-spacing-1, 0.25rem) 0;
    cursor: pointer;
    scroll-snap-align: center;
  }
  .smrt-calendar-view__strip-dot {
    width: 0.375rem;
    height: 0.375rem;
  }
  .smrt-calendar-view__agenda {
    list-style: none;
    margin: 0;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-3, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }
  .smrt-calendar-view__agenda-day {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
    scroll-margin-top: var(--smrt-spacing-4, 1rem);
  }
  .smrt-calendar-view__agenda-view .smrt-calendar-view__empty {
    padding: 0 var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-calendar-view__agenda .smrt-calendar-view__empty {
    padding: 0;
  }
}

@layer smrt.theme {
  .smrt-calendar-view__root {
    --smrt-calendar-view-border: var(--smrt-color-outline-variant);
    --smrt-calendar-view-surface: var(--smrt-color-surface);
    --smrt-calendar-view-muted: var(--smrt-color-on-surface-variant);
    --smrt-calendar-view-text: var(--smrt-color-on-surface);
    color: var(--smrt-calendar-view-text);
    background: var(--smrt-calendar-view-surface);
    border: 1px solid var(--smrt-calendar-view-border);
    border-radius: var(--smrt-radius-large);
  }
  [data-tone='primary'] {
    --smrt-calendar-view-tone: var(--smrt-color-primary);
    --smrt-calendar-view-fill: var(--smrt-color-primary-container);
    --smrt-calendar-view-ink: var(--smrt-color-on-primary-container);
  }
  [data-tone='secondary'] {
    --smrt-calendar-view-tone: var(--smrt-color-secondary);
    --smrt-calendar-view-fill: var(--smrt-color-secondary-container);
    --smrt-calendar-view-ink: var(--smrt-color-on-secondary-container);
  }
  [data-tone='tertiary'] {
    --smrt-calendar-view-tone: var(--smrt-color-tertiary);
    --smrt-calendar-view-fill: var(--smrt-color-tertiary-container);
    --smrt-calendar-view-ink: var(--smrt-color-on-tertiary-container);
  }
  [data-tone='success'] {
    --smrt-calendar-view-tone: var(--smrt-color-success);
    --smrt-calendar-view-fill: var(--smrt-color-success-container);
    --smrt-calendar-view-ink: var(--smrt-color-on-success-container);
  }
  [data-tone='warning'] {
    --smrt-calendar-view-tone: var(--smrt-color-warning);
    --smrt-calendar-view-fill: var(--smrt-color-warning-container);
    --smrt-calendar-view-ink: var(--smrt-color-on-warning-container);
  }
  [data-tone='error'] {
    --smrt-calendar-view-tone: var(--smrt-color-error);
    --smrt-calendar-view-fill: var(--smrt-color-error-container);
    --smrt-calendar-view-ink: var(--smrt-color-on-error-container);
  }
  [data-tone='neutral'] {
    --smrt-calendar-view-tone: var(--smrt-color-outline);
    --smrt-calendar-view-fill: var(--smrt-color-surface-container-high);
    --smrt-calendar-view-ink: var(--smrt-color-on-surface);
  }
  /* An explicit item color wins over the tone. */
  [style*='--smrt-calendar-view-item'] {
    --smrt-calendar-view-tone: var(--smrt-calendar-view-item);
    --smrt-calendar-view-fill: color-mix(in srgb, var(--smrt-calendar-view-item) 22%, var(--smrt-calendar-view-surface));
    --smrt-calendar-view-ink: var(--smrt-calendar-view-text);
  }
  .smrt-calendar-view__header {
    background: var(--smrt-color-surface-container-low);
    border-bottom: 1px solid var(--smrt-calendar-view-border);
  }
  .smrt-calendar-view__title {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-title-large-weight, 600);
    line-height: 1.2;
  }
  .smrt-calendar-view__icon-btn,
  .smrt-calendar-view__today-btn {
    border: 1px solid transparent;
    border-radius: var(--smrt-radius-medium);
    background: transparent;
    color: var(--smrt-calendar-view-muted);
    font: inherit;
  }
  .smrt-calendar-view__today-btn {
    border-color: var(--smrt-calendar-view-border);
    color: var(--smrt-color-primary);
    font-weight: 500;
  }
  .smrt-calendar-view__icon-btn:hover,
  .smrt-calendar-view__today-btn:hover {
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-calendar-view-text);
  }
  .smrt-calendar-view__sr {
    border: 0;
  }
  button:focus-visible,
  a:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  /* ---- Month grid ---- */
  .smrt-calendar-view__grid {
    outline: none;
  }
  .smrt-calendar-view__weekday {
    text-align: center;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: 500;
    color: var(--smrt-calendar-view-muted);
    border-bottom: 1px solid var(--smrt-calendar-view-border);
  }
  .smrt-calendar-view__week {
    border-bottom: 1px solid var(--smrt-calendar-view-border);
  }
  .smrt-calendar-view__week:last-child {
    border-bottom: 0;
  }
  .smrt-calendar-view__day {
    border-right: 1px solid var(--smrt-calendar-view-border);
  }
  .smrt-calendar-view__day:nth-child(7) {
    border-right: 0;
  }
  .smrt-calendar-view__day--out .smrt-calendar-view__daynum {
    color: var(--smrt-calendar-view-muted);
    opacity: 0.7;
  }
  .smrt-calendar-view__day--selected {
    background: var(--smrt-color-surface-container);
    box-shadow: inset 0 0 0 2px var(--smrt-color-primary);
  }
  .smrt-calendar-view__daynum {
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    text-decoration: none;
  }
  .smrt-calendar-view__day--today .smrt-calendar-view__daynum {
    font-weight: 700;
    color: var(--smrt-color-primary);
  }
  .smrt-calendar-view__chip,
  .smrt-calendar-view__more {
    border: 0;
    border-radius: var(--smrt-radius-small);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    line-height: 1.4;
    text-align: start;
    text-decoration: none;
  }
  .smrt-calendar-view__chip::before {
    border-radius: 50%;
    background: var(--smrt-calendar-view-tone);
  }
  .smrt-calendar-view__chip:hover,
  .smrt-calendar-view__more:hover {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-calendar-view__chip-time {
    color: var(--smrt-calendar-view-muted);
  }
  /* Narrow grids (a phone forced into month mode): dots and titles only. */
  @container (max-width: 40rem) {
    .smrt-calendar-view__title {
      font-size: var(--smrt-typography-title-medium-size, 1rem);
    }
  }
  .smrt-calendar-view__more {
    color: var(--smrt-color-primary);
    font-weight: 500;
  }
  .smrt-calendar-view__band {
    border: 0;
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-calendar-view-fill);
    color: var(--smrt-calendar-view-ink);
    box-shadow: inset 3px 0 0 var(--smrt-calendar-view-tone);
    font: inherit;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: 500;
    line-height: calc(var(--smrt-calendar-view-band-row) - 4px);
    text-align: start;
    text-decoration: none;
  }
  .smrt-calendar-view__band--before {
    border-start-start-radius: 0;
    border-end-start-radius: 0;
    box-shadow: none;
  }
  .smrt-calendar-view__band--after {
    border-start-end-radius: 0;
    border-end-end-radius: 0;
  }
  /* ---- Day panel and agenda rows ---- */
  .smrt-calendar-view__day-panel {
    border-top: 1px solid var(--smrt-calendar-view-border);
  }
  .smrt-calendar-view__day-title,
  .smrt-calendar-view__agenda-date {
    font-size: var(--smrt-typography-title-small-size, 0.9375rem);
    font-weight: 600;
  }
  .smrt-calendar-view__agenda-date a {
    color: inherit;
  }
  .smrt-calendar-view__row {
    border: 1px solid var(--smrt-calendar-view-border);
    border-inline-start: 4px solid var(--smrt-calendar-view-tone);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-calendar-view-surface);
    color: inherit;
    font: inherit;
    text-align: start;
    text-decoration: none;
  }
  .smrt-calendar-view__row:hover {
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-calendar-view__row-time {
    color: var(--smrt-calendar-view-muted);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
  .smrt-calendar-view__row-title {
    font-weight: 500;
  }
  .smrt-calendar-view__row-meta {
    color: var(--smrt-calendar-view-muted);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }
  /* Tone is a fill with its own ink, never a text color (brand rule). */
  .smrt-calendar-view__row-label {
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-calendar-view-fill);
    color: var(--smrt-calendar-view-ink);
    font-weight: 500;
  }
  .smrt-calendar-view__empty {
    color: var(--smrt-calendar-view-muted);
  }
  /* ---- Agenda ---- */
  .smrt-calendar-view__strip {
    border-bottom: 1px solid var(--smrt-calendar-view-border);
    scrollbar-width: none;
  }
  .smrt-calendar-view__strip-day {
    border: 1px solid transparent;
    border-radius: var(--smrt-radius-medium);
    background: transparent;
    color: inherit;
    font: inherit;
  }
  .smrt-calendar-view__strip-day[aria-pressed='true'] {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }
  .smrt-calendar-view__strip-day--today:not([aria-pressed='true']) {
    border-color: var(--smrt-color-primary);
  }
  .smrt-calendar-view__strip-weekday {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    opacity: 0.8;
  }
  .smrt-calendar-view__strip-num {
    font-weight: 600;
  }
  .smrt-calendar-view__strip-dot {
    border-radius: 50%;
  }
  .smrt-calendar-view__strip-dot--on {
    background: currentColor;
  }
  .smrt-calendar-view__agenda-day--today .smrt-calendar-view__agenda-date {
    color: var(--smrt-color-primary);
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-calendar-view__strip {
      scroll-behavior: auto;
    }
  }
}

</style>
