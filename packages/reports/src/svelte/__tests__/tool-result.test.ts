import { describe, expect, it } from 'vitest';
import { proposal } from '../preview-data.js';
import {
  runtimeReportProposalFromMessage,
  runtimeReportToolResultComponent,
} from '../tool-result.js';

describe('runtime report tool result wiring', () => {
  it('selects the report component only for a valid define proposal', () => {
    const message = {
      toolCallData: { name: 'reports.runtime.define', result: proposal },
    };
    expect(runtimeReportProposalFromMessage(message)).toBe(proposal);
    expect(runtimeReportToolResultComponent(message)).toBeDefined();
    expect(
      runtimeReportToolResultComponent({
        toolCallData: { name: 'other', result: proposal },
      }),
    ).toBeUndefined();
  });
});
