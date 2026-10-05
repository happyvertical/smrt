/**
 * Calendar components.
 *
 * `CalendarView` is the generic, time-zone-aware month/week grids + phone agenda.
 * `Calendar` and `DayView` are deprecated: they compute days in the browser
 * zone, print English-only names, hard-code game/meeting/event item types
 * and `/events/y/m/d` links. Migrate to `CalendarView` (see the package
 * README, "Calendar").
 */

/** @deprecated Use `CalendarView`; see the smrt-ui README "Calendar" migration note. */
export { default as Calendar } from './Calendar.svelte';
export { default as CalendarView } from './CalendarView.svelte';
export type {
  CalendarBandSegment,
  CalendarDayCell,
  CalendarEntry,
  CalendarItem,
  CalendarMode,
  CalendarMonth,
  CalendarNavigation,
  CalendarTone,
  CalendarWeek,
} from './calendar-model.js';
export {
  addDays,
  addMonthsToKey,
  dateKeyInZone,
  defaultTimeZone,
  defaultWeekStart,
  entriesOnDay,
  formatKey,
  isDateKey,
  layoutMonth,
  layoutWeek,
  monthKeys,
  monthOfKey,
  monthWeeks,
  parseKey,
  shiftMonth,
  todayKey,
  toEntries,
  toneFor,
  weekdayOfKey,
  weekKeys,
} from './calendar-model.js';
/** @deprecated Use `CalendarView` (agenda mode or its day panel); see the smrt-ui README. */
export { default as DayView } from './DayView.svelte';
