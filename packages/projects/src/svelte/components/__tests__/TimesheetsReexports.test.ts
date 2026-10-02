// @vitest-environment jsdom
/**
 * #3288: the time-entry components moved to smrt-timesheets and stay
 * importable from `@happyvertical/smrt-projects/svelte` under the same names.
 */
import * as timesheets from '@happyvertical/smrt-timesheets/svelte';
import { describe, expect, it } from 'vitest';
import * as projects from '../../index.js';

describe('smrt-projects/svelte time-entry re-exports', () => {
  it('re-exports the moved components and helpers unchanged', () => {
    expect(projects.TimeEntryList).toBe(timesheets.TimeEntryList);
    expect(projects.TimeEntryCard).toBe(timesheets.TimeEntryCard);
    expect(projects.TimeSummary).toBe(timesheets.TimeSummary);
    expect(projects.DurationDisplay).toBe(timesheets.DurationDisplay);
    expect(projects.formatCurrency).toBe(timesheets.formatCurrency);
    expect(projects.formatHoursHHMM).toBe(timesheets.formatHoursHHMM);
  });
});
