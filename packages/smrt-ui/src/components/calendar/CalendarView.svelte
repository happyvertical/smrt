<script lang="ts">
/**
 * CalendarView — a generic month calendar with a phone agenda.
 *
 * - `month` mode: a month grid (`role="grid"`, roving focus, arrow keys).
 *   All-day and multi-day items render as bands across the days they cover;
 *   a day that has more than fits shows "+N more", which opens the day in a
 *   panel under the grid (never a modal) or follows `dayHref`.
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
  defaultTimeZone,
  defaultWeekStart,
  entriesOnDay,
  formatKey,
  layoutMonth,
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
} from './calendar-model.js';

export interface Props {
  /** Items to show. */
  items?: CalendarItem[];
  /** Visible year (controlled together with `month`). */
  year?: number;
  /** Visible month, 1-12 (controlled together with `year`). */
  month?: number;
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
  /** Rows per day in the month grid, including band rows. */
  maxPerDay?: number;
  /** Heading level of the month title. */
  headingLevel?: 2 | 3 | 4;
  /**
   * "Now", for today highlighting (tests, server rendering). Without it the
   * calendar reads the clock after mount and moves "today" at midnight in
   * `timeZone`; before mount (server rendering) nothing is highlighted as
   * today. Server-rendered pages should pass `timeZone` and `year`/`month`
   * (or `now`) so the server and the browser pick the same month.
   */
  now?: Date;
  /** Called when the visible month changes (prev/next/today/keyboard). */
  onNavigate?: (month: CalendarMonth) => void;
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
let selected = $derived<string | null>(selectedDate ?? null);
let focusKey = $derived(
  selected && sameMonth(selected, current)
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
const view = $derived(mode === 'auto' ? (isPhone ? 'agenda' : 'month') : mode);

let root: HTMLElement | undefined = $state();

const entries = $derived(
  toEntries(items, timeZone, (item) =>
    console.warn(
      `[CalendarView] item "${item.id}" has an invalid start or end and was skipped`,
    ),
  ),
);
const weeks = $derived(
  layoutMonth(current, entries, { weekStartsOn, maxPerDay }),
);
const daysOfMonth = $derived(monthKeys(current));
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
  new Intl.DateTimeFormat(locale, {
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
  return item.color ? `--cv-item: ${item.color};` : '';
}

// ---- Navigation and selection ----

function navigate(next: CalendarMonth): void {
  current = next;
  onNavigate?.(next);
}

function goToday(): void {
  const key = today || todayKey(timeZone);
  const target = monthOfKey(key);
  if (target.year !== current.year || target.month !== current.month) {
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
  if (!sameMonth(key, current)) navigate(monthOfKey(key));
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
      next = addMonthsToKey(key, -1);
      break;
    case 'PageDown':
      next = addMonthsToKey(key, 1);
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
      ?.querySelector<HTMLElement>(`.cv-strip [data-cv-day="${key}"]`)
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
      class="cv-row"
      data-tone={toneFor(item)}
      style={itemStyle(item)}
      href={item.href}
      onclick={() => activateItem(item)}
    >
      {#if itemContent}
        {@render itemContent(item, { time })}
      {:else}
        <span class="cv-row-time">{time}</span>
        <span class="cv-row-main">
          <span class="cv-row-title">{item.title}</span>
          {#if item.label || note}
            <span class="cv-row-meta">
              {#if item.label}<span class="cv-row-label">{item.label}</span>{/if}
              {#if note}<span>{note}</span>{/if}
            </span>
          {/if}
        </span>
      {/if}
    </a>
  {:else}
    <button
      type="button"
      class="cv-row"
      data-tone={toneFor(item)}
      style={itemStyle(item)}
      onclick={() => activateItem(item)}
    >
      {#if itemContent}
        {@render itemContent(item, { time })}
      {:else}
        <span class="cv-row-time">{time}</span>
        <span class="cv-row-main">
          <span class="cv-row-title">{item.title}</span>
          {#if item.label || note}
            <span class="cv-row-meta">
              {#if item.label}<span class="cv-row-label">{item.label}</span>{/if}
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
  class="cv {className}"
  class:cv--agenda={view === 'agenda'}
  data-view={view}
>
  <header class="cv-header">
    <svelte:element
      this={`h${headingLevel}`}
      class="cv-title"
      id="cv-title-{uid}"
      aria-live="polite"
    >
      {monthTitle}
    </svelte:element>
    <div class="cv-nav">
      <button
        type="button"
        class="cv-icon-btn"
        aria-label={t(M['ui.calendar.previous_month'])}
        onclick={() => navigate(shiftMonth(current, -1))}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M12 15L7 10L12 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button type="button" class="cv-today-btn" onclick={goToday}>
        {t(M['ui.calendar.today'])}
      </button>
      <button
        type="button"
        class="cv-icon-btn"
        aria-label={t(M['ui.calendar.next_month'])}
        onclick={() => navigate(shiftMonth(current, 1))}
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M8 5L13 10L8 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </header>

  {#if view === 'month'}
    <div
      class="cv-grid"
      role="grid"
      aria-labelledby="cv-title-{uid}"
      tabindex="-1"
      onkeydown={onGridKeydown}
    >
      <div class="cv-weekdays" role="row">
        {#each weekdays as weekday (weekday.long)}
          <div class="cv-weekday" role="columnheader">
            <span aria-hidden="true">{weekday.short}</span>
            <span class="cv-sr">{weekday.long}</span>
          </div>
        {/each}
      </div>
      {#each weeks as week (week.days[0].key)}
        <div
          class="cv-week"
          role="row"
          style="grid-template-rows: var(--cv-daynum-h) {week.lanes > 0
            ? `repeat(${week.lanes}, var(--cv-band-row))`
            : ''} auto;"
        >
          {#each week.days as day, column (day.key)}
            {@const href = dayHref?.(day.key)}
            <div
              class="cv-day"
              class:cv-day--out={!day.inMonth}
              class:cv-day--today={day.key === today}
              class:cv-day--selected={day.key === selected}
              role="gridcell"
              aria-selected={day.key === selected}
              style="grid-column: {column + 1};"
            >
              {#if href}
                <a
                  class="cv-daynum"
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
                  class="cv-daynum"
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
                class="cv-day-body"
                style="padding-top: calc({week.lanes} * var(--cv-band-row));"
                aria-hidden="true"
              >
                {#each day.visible as entry (entry.item.id)}
                  {#if entry.item.href}
                    <a
                      class="cv-chip"
                      data-tone={toneFor(entry.item)}
                      style={itemStyle(entry.item)}
                      href={entry.item.href}
                      tabindex="-1"
                      title={entry.item.title}
                      onclick={() => activateItem(entry.item)}
                    >
                      <span class="cv-chip-time">{timeFormat.format(entry.startMs)}</span>
                      <span class="cv-chip-title">{entry.item.title}</span>
                    </a>
                  {:else}
                    <button
                      type="button"
                      class="cv-chip"
                      data-tone={toneFor(entry.item)}
                      style={itemStyle(entry.item)}
                      tabindex="-1"
                      title={entry.item.title}
                      onclick={() => activateItem(entry.item)}
                    >
                      <span class="cv-chip-time">{timeFormat.format(entry.startMs)}</span>
                      <span class="cv-chip-title">{entry.item.title}</span>
                    </button>
                  {/if}
                {/each}
                {#if day.hiddenCount > 0}
                  {#if href}
                    <a class="cv-more" {href} tabindex="-1">
                      <span class="cv-more-long">{t(M['ui.calendar.more'], { count: day.hiddenCount })}</span>
                      <span class="cv-more-short">{t(M['ui.calendar.more_short'], { count: day.hiddenCount })}</span>
                    </a>
                  {:else}
                    <button
                      type="button"
                      class="cv-more"
                      tabindex="-1"
                      onclick={() => {
                        selectDay(day.key);
                        void focusDay(day.key);
                      }}
                    >
                      <span class="cv-more-long">{t(M['ui.calendar.more'], { count: day.hiddenCount })}</span>
                      <span class="cv-more-short">{t(M['ui.calendar.more_short'], { count: day.hiddenCount })}</span>
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
                class="cv-band"
                class:cv-band--before={band.continuesBefore}
                class:cv-band--after={band.continuesAfter}
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
                class="cv-band"
                class:cv-band--before={band.continuesBefore}
                class:cv-band--after={band.continuesAfter}
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

    {#if selected && !dayHref && sameMonth(selected, current)}
      <section class="cv-day-panel" aria-labelledby="cv-day-{uid}">
        <div class="cv-day-panel-head">
          <h3 class="cv-day-title" id="cv-day-{uid}">{longDate(selected)}</h3>
          <button
            type="button"
            class="cv-icon-btn"
            aria-label={t(M['ui.calendar.close_day'], { date: longDate(selected) })}
            onclick={closeDay}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M5 5L15 15M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
        </div>
        {#if selectedEntries.length === 0}
          <p class="cv-empty">{t(M['ui.calendar.nothing_day'])}</p>
        {:else}
          <ul class="cv-rows">
            {#each selectedEntries as entry (entry.item.id)}
              <li>{@render itemRow(entry, selected)}</li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {:else}
    <div
      class="cv-strip"
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
          class="cv-strip-day"
          class:cv-strip-day--today={key === today}
          data-cv-day={key}
          tabindex={key === focusKey ? 0 : -1}
          aria-label={dayLabel(key, count)}
          aria-pressed={key === selected}
          aria-current={key === today ? 'date' : undefined}
          onclick={() => selectDay(key)}
        >
          <span class="cv-strip-weekday" aria-hidden="true">{weekday.narrow}</span>
          <span class="cv-strip-num" aria-hidden="true">{parseKey(key).day}</span>
          <span class="cv-strip-dot" class:cv-strip-dot--on={count > 0} aria-hidden="true"></span>
        </button>
      {/each}
    </div>

    {#if agendaDays.length === 0}
      <p class="cv-empty">{t(M['ui.calendar.nothing_month'])}</p>
    {:else}
      <ol class="cv-agenda">
        {#each agendaDays as day (day.key)}
          <li
            class="cv-agenda-day"
            class:cv-agenda-day--today={day.key === today}
            data-cv-agenda-day={day.key}
            aria-labelledby="cv-agenda-{uid}-{day.key}"
          >
            <h3 class="cv-agenda-date" id="cv-agenda-{uid}-{day.key}">
              {#if dayHref?.(day.key)}
                <a href={dayHref(day.key)}>{longDate(day.key)}</a>
              {:else}
                {longDate(day.key)}
              {/if}
            </h3>
            {#if day.entries.length === 0}
              <p class="cv-empty">{t(M['ui.calendar.nothing_day'])}</p>
            {:else}
              <ul class="cv-rows">
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
  .cv {
    --cv-border: var(--smrt-color-outline-variant, #c4c6d0);
    --cv-surface: var(--smrt-color-surface, #ffffff);
    --cv-muted: var(--smrt-color-on-surface-variant, #44474e);
    --cv-text: var(--smrt-color-on-surface, #1b1b1f);
    --cv-daynum-h: 2.75rem;
    --cv-band-row: 1.625rem;
    --cv-target: 2.75rem;
    color: var(--cv-text);
    background: var(--cv-surface);
    border: 1px solid var(--cv-border);
    border-radius: var(--smrt-radius-large, 12px);
    overflow: hidden;
    min-width: 0;
    container-type: inline-size;
  }

  [data-tone='primary'] { --cv-tone: var(--smrt-color-primary, #005ac1); --cv-fill: var(--smrt-color-primary-container, #d8e2ff); --cv-ink: var(--smrt-color-on-primary-container, #001a41); }
  [data-tone='secondary'] { --cv-tone: var(--smrt-color-secondary, #575e71); --cv-fill: var(--smrt-color-secondary-container, #dbe2f9); --cv-ink: var(--smrt-color-on-secondary-container, #141b2c); }
  [data-tone='tertiary'] { --cv-tone: var(--smrt-color-tertiary, #715573); --cv-fill: var(--smrt-color-tertiary-container, #fbd7fc); --cv-ink: var(--smrt-color-on-tertiary-container, #29132d); }
  [data-tone='success'] { --cv-tone: var(--smrt-color-success, #1b6d2f); --cv-fill: var(--smrt-color-success-container, #a4f5a9); --cv-ink: var(--smrt-color-on-success-container, #002108); }
  [data-tone='warning'] { --cv-tone: var(--smrt-color-warning, #7a5900); --cv-fill: var(--smrt-color-warning-container, #ffdea3); --cv-ink: var(--smrt-color-on-warning-container, #261900); }
  [data-tone='error'] { --cv-tone: var(--smrt-color-error, #ba1a1a); --cv-fill: var(--smrt-color-error-container, #ffdad6); --cv-ink: var(--smrt-color-on-error-container, #410002); }
  [data-tone='neutral'] { --cv-tone: var(--smrt-color-outline, #74777f); --cv-fill: var(--smrt-color-surface-container-high, #e8e7ec); --cv-ink: var(--smrt-color-on-surface, #1b1b1f); }

  /* An explicit item color wins over the tone. */
  [style*='--cv-item'] { --cv-tone: var(--cv-item); --cv-fill: color-mix(in srgb, var(--cv-item) 22%, var(--cv-surface)); --cv-ink: var(--cv-text); }

  .cv-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    background: var(--smrt-color-surface-container-low, #f5f3f7);
    border-bottom: 1px solid var(--cv-border);
  }

  .cv-title {
    margin: 0;
    overflow-wrap: anywhere;
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-title-large-weight, 600);
    line-height: 1.2;
    min-width: 0;
  }

  .cv-nav {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 0.5rem);
    flex-shrink: 0;
  }

  .cv-icon-btn,
  .cv-today-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--cv-target);
    min-height: var(--cv-target);
    border: 1px solid transparent;
    border-radius: var(--smrt-radius-medium, 8px);
    background: transparent;
    color: var(--cv-muted);
    font: inherit;
    cursor: pointer;
  }

  .cv-today-btn {
    padding: 0 var(--smrt-spacing-3, 0.75rem);
    border-color: var(--cv-border);
    color: var(--smrt-color-primary, #005ac1);
    font-weight: 500;
  }

  .cv-icon-btn:hover,
  .cv-today-btn:hover {
    background: var(--smrt-color-surface-container-high, #e8e7ec);
    color: var(--cv-text);
  }

  .cv-sr {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  button:focus-visible,
  a:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
  }

  /* ---- Month grid ---- */

  .cv-grid {
    outline: none;
  }

  .cv-weekdays,
  .cv-week {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }

  .cv-weekday {
    padding: var(--smrt-spacing-2, 0.5rem) 0;
    text-align: center;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: 500;
    color: var(--cv-muted);
    border-bottom: 1px solid var(--cv-border);
  }

  .cv-week {
    position: relative;
    border-bottom: 1px solid var(--cv-border);
  }

  .cv-week:last-child {
    border-bottom: 0;
  }

  .cv-day {
    grid-row: 1 / -1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 6.5rem;
    border-right: 1px solid var(--cv-border);
  }

  .cv-day:nth-child(7) {
    border-right: 0;
  }

  .cv-day--out .cv-daynum {
    color: var(--cv-muted);
    opacity: 0.7;
  }

  .cv-day--selected {
    background: var(--smrt-color-surface-container, #efedf1);
    box-shadow: inset 0 0 0 2px var(--smrt-color-primary, #005ac1);
  }

  .cv-daynum {
    display: flex;
    align-items: flex-start;
    justify-content: flex-end;
    height: var(--cv-daynum-h);
    min-height: var(--cv-target);
    padding: var(--smrt-spacing-2, 0.5rem);
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    text-decoration: none;
    cursor: pointer;
    width: 100%;
  }

  .cv-day--today .cv-daynum {
    font-weight: 700;
    color: var(--smrt-color-primary, #005ac1);
  }

  .cv-day-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 0 var(--smrt-spacing-1, 0.25rem) var(--smrt-spacing-1, 0.25rem);
    min-width: 0;
  }

  .cv-chip,
  .cv-more {
    display: flex;
    gap: 0.25rem;
    align-items: baseline;
    min-width: 0;
    padding: 1px var(--smrt-spacing-1, 0.25rem);
    border: 0;
    border-radius: var(--smrt-radius-small, 4px);
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    line-height: 1.4;
    text-align: start;
    text-decoration: none;
    cursor: pointer;
    white-space: nowrap;
  }

  .cv-chip::before {
    content: '';
    flex-shrink: 0;
    align-self: center;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--cv-tone);
  }

  .cv-chip:hover,
  .cv-more:hover {
    background: var(--smrt-color-surface-container-high, #e8e7ec);
  }

  .cv-chip,
  .cv-more {
    overflow: hidden;
  }

  .cv-chip-time {
    color: var(--cv-muted);
    flex-shrink: 0;
  }

  .cv-more-short {
    display: none;
  }

  /* Narrow grids (a phone forced into month mode): dots and titles only. */
  @container (max-width: 40rem) {
    .cv-chip-time,
    .cv-more-long {
      display: none;
    }

    .cv-more-short {
      display: inline;
    }

    .cv-title {
      font-size: var(--smrt-typography-title-medium-size, 1rem);
    }
  }

  .cv-chip-title {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cv-more {
    color: var(--smrt-color-primary, #005ac1);
    font-weight: 500;
  }

  .cv-band {
    z-index: 1;
    align-self: center;
    margin: 0 var(--smrt-spacing-1, 0.25rem);
    height: calc(var(--cv-band-row) - 4px);
    padding: 0 var(--smrt-spacing-2, 0.5rem);
    border: 0;
    border-radius: var(--smrt-radius-small, 4px);
    background: var(--cv-fill);
    color: var(--cv-ink);
    box-shadow: inset 3px 0 0 var(--cv-tone);
    font: inherit;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: 500;
    line-height: calc(var(--cv-band-row) - 4px);
    text-align: start;
    text-decoration: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
    min-width: 0;
  }

  .cv-band--before {
    margin-inline-start: 0;
    border-start-start-radius: 0;
    border-end-start-radius: 0;
    box-shadow: none;
  }

  .cv-band--after {
    margin-inline-end: 0;
    border-start-end-radius: 0;
    border-end-end-radius: 0;
  }

  /* ---- Day panel and agenda rows ---- */

  .cv-day-panel {
    border-top: 1px solid var(--cv-border);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-3, 0.75rem);
  }

  .cv-day-panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .cv-day-title,
  .cv-agenda-date {
    margin: 0;
    font-size: var(--smrt-typography-title-small-size, 0.9375rem);
    font-weight: 600;
  }

  .cv-agenda-date a {
    color: inherit;
  }

  .cv-rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .cv-row {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-3, 0.75rem);
    width: 100%;
    min-height: var(--cv-target);
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    border: 1px solid var(--cv-border);
    border-inline-start: 4px solid var(--cv-tone);
    border-radius: var(--smrt-radius-medium, 8px);
    background: var(--cv-surface);
    color: inherit;
    font: inherit;
    text-align: start;
    text-decoration: none;
    cursor: pointer;
  }

  .cv-row:hover {
    background: var(--smrt-color-surface-container-low, #f5f3f7);
  }

  .cv-row-time {
    flex: 0 0 4.5rem;
    color: var(--cv-muted);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }

  .cv-row-main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .cv-row-title {
    font-weight: 500;
    overflow-wrap: anywhere;
  }

  .cv-row-meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2, 0.5rem);
    color: var(--cv-muted);
    font-size: var(--smrt-typography-body-small-size, 0.8125rem);
  }

  /* Tone is a fill with its own ink, never a text color (brand rule). */
  .cv-row-label {
    padding: 0 0.375rem;
    border-radius: var(--smrt-radius-small, 4px);
    background: var(--cv-fill);
    color: var(--cv-ink);
    font-weight: 500;
  }

  .cv-empty {
    margin: var(--smrt-spacing-2, 0.5rem) 0;
    color: var(--cv-muted);
  }

  /* ---- Agenda ---- */

  .cv-strip {
    display: flex;
    gap: var(--smrt-spacing-2, 0.5rem);
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scroll-snap-type: x proximity;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem);
    border-bottom: 1px solid var(--cv-border);
    scrollbar-width: none;
  }

  .cv-strip-day {
    flex: 0 0 var(--cv-target);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    min-height: 3.5rem;
    padding: var(--smrt-spacing-1, 0.25rem) 0;
    border: 1px solid transparent;
    border-radius: var(--smrt-radius-medium, 8px);
    background: transparent;
    color: inherit;
    font: inherit;
    cursor: pointer;
    scroll-snap-align: center;
  }

  .cv-strip-day[aria-pressed='true'] {
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #ffffff);
  }

  .cv-strip-day--today:not([aria-pressed='true']) {
    border-color: var(--smrt-color-primary, #005ac1);
  }

  .cv-strip-weekday {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    opacity: 0.8;
  }

  .cv-strip-num {
    font-weight: 600;
  }

  .cv-strip-dot {
    width: 0.375rem;
    height: 0.375rem;
    border-radius: 50%;
  }

  .cv-strip-dot--on {
    background: currentColor;
  }

  .cv-agenda {
    list-style: none;
    margin: 0;
    padding: var(--smrt-spacing-2, 0.5rem) var(--smrt-spacing-3, 0.75rem) var(--smrt-spacing-3, 0.75rem);
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
  }

  .cv-agenda-day {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 0.5rem);
    scroll-margin-top: var(--smrt-spacing-4, 1rem);
  }

  .cv-agenda-day--today .cv-agenda-date {
    color: var(--smrt-color-primary, #005ac1);
  }

  .cv--agenda .cv-empty {
    padding: 0 var(--smrt-spacing-3, 0.75rem);
  }

  .cv-agenda .cv-empty {
    padding: 0;
  }

  @media (prefers-reduced-motion: reduce) {
    .cv-strip {
      scroll-behavior: auto;
    }
  }
</style>
