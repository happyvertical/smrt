import {
  parseRuntimeReportSpec,
  RuntimeReportError,
} from '@happyvertical/smrt-reports';
import { expect, it } from 'vitest';
import { reportFailure } from './report-display.ts';

it('uses the typed report code, never message text, to classify invalid results', () => {
  const changed =
    'This report could not run. Its fields may have changed. Ask the assistant to update it.';
  for (const error of [
    new RuntimeReportError(
      'unknown_field',
      'spec.measures[0]',
      'integer result exceeds the JavaScript safe range',
    ),
    new Error('invalid_result SELECT password FROM /private/app.db'),
  ])
    expect(reportFailure(error).message).toBe(changed);
  expect(
    reportFailure(
      new RuntimeReportError(
        'invalid_result',
        'unknown',
        'SELECT password FROM /private/app.db',
      ),
    ).message,
  ).toBe(
    'A report value is too large to show exactly. Check the values used by this report.',
  );
});

it('explains invalid output aliases without forwarding compiler paths or raw messages', () => {
  let failure: unknown;
  try {
    parseRuntimeReportSpec({
      title: 'Open orders',
      source: 'Orders',
      measures: [{ fn: 'count', as: 'orderCount' }],
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(RuntimeReportError);
  const message = reportFailure(failure).message;
  expect(message).toContain('lowercase words separated by underscores');
  expect(message).toContain('Keep the app’s source field names unchanged');
  expect(message).not.toMatch(/spec\.|orderCount|measures/);
});
