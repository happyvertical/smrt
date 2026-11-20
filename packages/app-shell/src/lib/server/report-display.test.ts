import {
  parseRuntimeReportSpec,
  RuntimeReportError,
} from '@happyvertical/smrt-reports';
import { expect, it } from 'vitest';
import { reportFailure, reportFailureForOwner } from './report-display.ts';

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

it('returns the parser path and reason for an invalid sort, with a plain-language fix', () => {
  let failure: unknown;
  try {
    parseRuntimeReportSpec({
      title: 'Sales',
      source: 'Sale',
      dimensions: [{ field: 'day', bucket: 'month', as: 'month' }],
      measures: [{ fn: 'count', as: 'sales' }],
      sort: [{ field: 'month', dir: 'asc' }],
    });
  } catch (error) {
    failure = error;
  }
  const message = reportFailure(failure).message;
  expect(message).toContain('spec.sort[0].field');
  expect(message).toContain('is not a known key');
  expect(message).toContain('"by"');
  expect(
    reportFailure(
      new RuntimeReportError(
        'invalid_spec',
        'SELECT x FROM /private/app.db',
        'bad SELECT',
      ),
    ).message,
  ).toMatch(/^The report definition is invalid at spec: bad SELECT\./);
});

it('gives the owner a fixed plain sentence for each invalid part of a report (#5172)', () => {
  const owner = (path: string) =>
    reportFailureForOwner(
      reportFailure(new RuntimeReportError('invalid_spec', path, 'must be x'))
        .message,
    );
  expect(owner('spec.filters[0].op')).toBe(
    'A filter in that report used a comparison the app cannot do, so nothing was run.',
  );
  expect(owner('spec.filters[1].value')).toBe(
    'A filter in that report was not valid, so nothing was run.',
  );
  expect(owner('spec.sort[0].by')).toBe(
    'The sorting in that report was not valid, so nothing was run.',
  );
  expect(owner('spec.title')).toBe(
    'That report was not set up correctly, so nothing was run.',
  );
  for (const path of ['spec.filters[0].op', 'spec.sort[0].by'])
    expect(owner(path)).not.toMatch(/[[\]{}]|spec\./);
  // Messages that are already plain pass through unchanged.
  expect(reportFailureForOwner('This report took too long.')).toBe(
    'This report took too long.',
  );
});
