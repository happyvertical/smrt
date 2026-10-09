import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  'ui.importExport.label': 'Import and export',
  'ui.importExport.mode': 'Choose import or export',
  'ui.importExport.tab.import': 'Import',
  'ui.importExport.tab.export': 'Export',

  'ui.importExport.import.file': 'Spreadsheet file',
  'ui.importExport.import.fileDescription':
    'Drop a CSV or TSV file here, or browse. Save a spreadsheet as CSV first.',
  'ui.importExport.import.reading': 'Reading {name}…',
  'ui.importExport.import.parsed':
    '{name}: {rows} rows, {columns} columns, {delimiter}-separated.',
  'ui.importExport.import.tooLarge':
    '{name} is {size} MB; the limit is {limit} MB.',
  'ui.importExport.import.tooManyRows':
    'The file has more than {limit} rows. Split it and import in parts.',
  'ui.importExport.import.unterminatedQuote':
    'A quoted cell starting on line {line} is never closed.',
  'ui.importExport.import.empty': 'The file is empty.',
  'ui.importExport.import.readFailed': 'The file could not be read.',
  'ui.importExport.delimiter.comma': 'comma',
  'ui.importExport.delimiter.semicolon': 'semicolon',
  'ui.importExport.delimiter.tab': 'tab',
  'ui.importExport.delimiter.pipe': 'pipe',

  'ui.importExport.map.heading': 'Map columns',
  'ui.importExport.map.help':
    'Match each column in your file to a field. Columns set to “Do not import” are ignored.',
  'ui.importExport.map.column': 'File column',
  'ui.importExport.map.sample': 'First value',
  'ui.importExport.map.target': 'Field',
  'ui.importExport.map.ignore': 'Do not import',
  'ui.importExport.map.select': 'Field for column {column}',
  'ui.importExport.map.required': '{label} (required)',
  'ui.importExport.map.reset': 'Re-detect columns',

  'ui.importExport.check.heading': 'Check before importing',
  'ui.importExport.check.summary':
    '{valid} of {total} rows are ready; {invalid} have problems.',
  'ui.importExport.check.noWrite': 'Nothing is saved until you press Import.',
  'ui.importExport.check.preview': 'Preview of the first {count} rows',
  'ui.importExport.check.problems': 'Problems',
  'ui.importExport.check.line': 'Line',
  'ui.importExport.check.column': 'Column',
  'ui.importExport.check.field': 'Field',
  'ui.importExport.check.value': 'Value',
  'ui.importExport.check.problem': 'Problem',
  'ui.importExport.check.truncated':
    'Only the first problems are listed; the error report has the same cap.',
  'ui.importExport.check.mappingFixed':
    'Fix the column mapping above to continue.',
  'ui.importExport.check.nothing': 'No rows are ready to import.',
  'ui.importExport.check.rowStatus.ok': 'Ready',
  'ui.importExport.check.rowStatus.bad': 'Problem',
  'ui.importExport.check.status': 'Status',

  'ui.importExport.run.import': 'Import {count} rows',
  'ui.importExport.run.cancel': 'Stop import',
  'ui.importExport.run.progress': 'Imported {done} of {total}…',
  'ui.importExport.run.done': 'Imported {created} of {attempted} rows.',
  'ui.importExport.run.failed': '{count} rows were rejected by the server.',
  'ui.importExport.run.aborted':
    'Stopped. {remaining} rows were not attempted.',
  'ui.importExport.run.report': 'Download error report',
  'ui.importExport.run.again': 'Import another file',

  'ui.importExport.export.heading': 'Choose columns',
  'ui.importExport.export.all': 'Select all',
  'ui.importExport.export.none': 'Clear',
  'ui.importExport.export.columns': 'Columns to export',
  'ui.importExport.export.format': 'Format',
  'ui.importExport.export.formatCsv': 'CSV (comma-separated)',
  'ui.importExport.export.formatTsv': 'TSV (tab-separated)',
  'ui.importExport.export.header': 'Include a header row',
  'ui.importExport.export.headerStyle': 'Header text',
  'ui.importExport.export.headerName': 'Field names (re-importable)',
  'ui.importExport.export.headerLabel': 'Readable labels',
  'ui.importExport.export.run': 'Export {count} columns',
  'ui.importExport.export.loading': 'Loading rows…',
  'ui.importExport.export.done':
    'Exported {rows} rows and {columns} columns to {filename}.',
  'ui.importExport.export.failed': 'The export failed: {reason}',
  'ui.importExport.export.limit':
    'The collection has more than {limit} rows; narrow it before exporting.',
  'ui.importExport.export.noColumns': 'Select at least one column.',
  'ui.importExport.export.unavailable': 'Export is not available here.',
  'ui.importExport.import.unavailable': 'Import is not available here.',

  'ui.importExport.issue.required': 'A value is required.',
  'ui.importExport.issue.invalid-integer': 'Expected a whole number.',
  'ui.importExport.issue.out-of-range':
    'The number is outside the supported range.',
  'ui.importExport.issue.invalid-decimal': 'Expected a number.',
  'ui.importExport.issue.invalid-boolean':
    'Expected true/false, yes/no or 1/0.',
  'ui.importExport.issue.invalid-datetime':
    'Expected an ISO 8601 date or date-time (YYYY-MM-DD or YYYY-MM-DDThh:mm:ss).',
  'ui.importExport.issue.invalid-json': 'Expected valid JSON.',
  'ui.importExport.issue.invalid-enum': 'Not one of the allowed values.',
  'ui.importExport.issue.invalid-email': 'Expected an email address.',
  'ui.importExport.issue.invalid-url': 'Expected an http(s) URL.',
  'ui.importExport.issue.invalid-reference': 'Expected an id with no spaces.',
  'ui.importExport.issue.duplicate-value': 'This value repeats an earlier row.',
  'ui.importExport.issue.duplicate-mapping':
    'More than one column maps to this field.',
  'ui.importExport.issue.unmapped-required':
    'This required field has no column mapped.',
  'ui.importExport.issue.extra-cells':
    'The row has more cells than the header.',
  'ui.importExport.issue.import-failed': 'The server rejected this row.',
});
