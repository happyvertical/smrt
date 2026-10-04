// @vitest-environment jsdom
/**
 * #3288: `TimeEntryApprovalQueue` moved to smrt-timesheets and stays
 * importable from `@happyvertical/smrt-support/svelte`; support's time-entry
 * view still adapts a support entry for it.
 */
import * as timesheets from '@happyvertical/smrt-timesheets/svelte';
import { describe, expect, it } from 'vitest';
import * as support from '../../index.js';

describe('smrt-support/svelte time-entry re-exports', () => {
  it('re-exports the approval queue and its status badge mapping', () => {
    expect(support.TimeEntryApprovalQueue).toBe(
      timesheets.TimeEntryApprovalQueue,
    );
    expect(support.timeEntryStatusBadgeKey).toBe(
      timesheets.timeEntryStatusBadgeKey,
    );
    expect(support.timeEntryStatusBadgeKey('corrected')).toBe('warning');
  });
});
