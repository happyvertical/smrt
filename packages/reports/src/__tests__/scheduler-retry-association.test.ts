import { describe, it } from 'vitest';
import {
  proveReportScheduleRetry,
  reportAgentTableCases,
} from '../../test-support/report-schedule-retry.js';

for (const type of ['sqlite', 'duckdb'] as const) {
  describe(`real report schedule retry association (${type})`, () => {
    it.each(
      reportAgentTableCases,
    )('retries a ReportScheduleRunner-produced job with agent schedule table %s', (agentTable) =>
      proveReportScheduleRetry(type, agentTable));
  });
}
