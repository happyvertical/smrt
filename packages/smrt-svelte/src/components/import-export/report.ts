import { formatDelimited, neutralizeFormula } from './csv.js';
import type { ExportFile, ImportIssue, ImportIssueCode } from './types.js';

/** English defaults; the component overrides these with translated strings. */
export const DEFAULT_ISSUE_MESSAGES: Record<ImportIssueCode, string> = {
  required: 'A value is required.',
  'invalid-integer': 'Expected a whole number.',
  'out-of-range': 'The number is outside the supported range.',
  'invalid-decimal': 'Expected a number.',
  'invalid-boolean': 'Expected true/false, yes/no or 1/0.',
  'invalid-datetime':
    'Expected an ISO 8601 date or date-time (YYYY-MM-DD or YYYY-MM-DDThh:mm:ss).',
  'invalid-json': 'Expected valid JSON.',
  'invalid-enum': 'Not one of the allowed values.',
  'invalid-email': 'Expected an email address.',
  'invalid-url': 'Expected an http(s) URL.',
  'invalid-reference': 'Expected an id with no spaces.',
  'duplicate-value': 'This value repeats an earlier row.',
  'duplicate-mapping': 'More than one column maps to this field.',
  'unmapped-required': 'This required field has no column mapped.',
  'extra-cells': 'The row has more cells than the header.',
  'import-failed': 'The server rejected this row.',
};

export type IssueMessages = Partial<Record<ImportIssueCode, string>>;

/** Human message for an issue, with `detail` appended when present. */
export function describeIssue(
  issue: ImportIssue,
  messages: IssueMessages = {},
): string {
  const base = messages[issue.code] ?? DEFAULT_ISSUE_MESSAGES[issue.code];
  return issue.detail ? `${base} (${issue.detail})` : base;
}

const REPORT_HEADER = ['line', 'column', 'field', 'value', 'problem'];

/**
 * CSV error report: one row per issue with the file line, the source column,
 * the target field, the offending value, and the problem. Echoed values are
 * formula-neutralized because the report is meant to be opened in a spreadsheet.
 */
export function buildErrorReport(
  issues: readonly ImportIssue[],
  messages: IssueMessages = {},
  filename = 'import-errors',
): ExportFile {
  const table = [
    REPORT_HEADER,
    ...issues.map((issue) => [
      issue.line > 0 ? String(issue.line) : '',
      neutralizeFormula(issue.column ?? ''),
      neutralizeFormula(issue.field ?? ''),
      neutralizeFormula(issue.value ?? ''),
      neutralizeFormula(describeIssue(issue, messages)),
    ]),
  ];
  return {
    filename: `${filename}.csv`,
    mimeType: 'text/csv;charset=utf-8',
    content: `﻿${formatDelimited(table)}`,
    rowCount: issues.length,
    columnCount: REPORT_HEADER.length,
  };
}
