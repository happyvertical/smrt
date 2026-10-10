<script lang="ts">
import { Alert, ProgressBar } from '@happyvertical/smrt-ui/feedback';
import {
  Checkbox,
  FilePicker,
  SegmentedControl,
  Select,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Badge, Button, Card } from '@happyvertical/smrt-ui/ui';
import { onDestroy } from 'svelte';
import { M } from '../../i18n/strings.import-export.js';
import { CsvParseError, parseTable } from './csv.js';
import { downloadFile } from './download.js';
import { buildExportFile, type ExportFormat } from './export.js';
import { autoMapColumns, setColumnTarget } from './mapping.js';
import type { ImportExportProps } from './props.js';
import { buildErrorReport, type IssueMessages } from './report.js';
import { runImport } from './runner.js';
import type {
  ImportIssue,
  ImportIssueCode,
  ImportRunResult,
  ParsedTable,
} from './types.js';
import { validateRows } from './validate.js';

const PREVIEW_ROWS = 10;
const ISSUE_ROWS = 50;
const ISSUE_CODES: ImportIssueCode[] = [
  'required',
  'invalid-integer',
  'out-of-range',
  'invalid-decimal',
  'invalid-boolean',
  'invalid-datetime',
  'invalid-json',
  'invalid-enum',
  'invalid-email',
  'invalid-url',
  'invalid-reference',
  'duplicate-value',
  'duplicate-mapping',
  'unmapped-required',
  'extra-cells',
  'import-failed',
];

let {
  fields,
  collectionLabel,
  createRecord,
  loadRows,
  filename = 'export',
  maxFileBytes = 5 * 1024 * 1024,
  maxRows = 10_000,
  concurrency = 3,
  mode = 'both',
  ondownload,
  onimported,
}: ImportExportProps = $props();

const { t } = useI18n();

const canImport = $derived(mode !== 'export' && createRecord !== undefined);
const canExport = $derived(mode !== 'import' && loadRows !== undefined);
let chosenTab = $state<'import' | 'export'>('import');
const tab = $derived(
  canImport && canExport ? chosenTab : canImport ? 'import' : 'export',
);

const issueMessages = $derived<IssueMessages>(
  Object.fromEntries(
    ISSUE_CODES.map((code) => [code, t(`ui.importExport.issue.${code}`)]),
  ),
);
const fieldByName = $derived(new Map(fields.map((f) => [f.name, f])));
const importable = $derived(fields.filter((f) => f.importable));
const exportable = $derived(fields.filter((f) => f.exportable));

function deliver(file: Parameters<typeof downloadFile>[0]) {
  if (ondownload) ondownload(file);
  else downloadFile(file);
}

// ---- import ---------------------------------------------------------------
let fileName = $state('');
let files = $state<File[]>([]);
let table = $state<ParsedTable | null>(null);
let mapping = $state<(string | null)[]>([]);
let fileError = $state<string | null>(null);
let reading = $state(false);
let running = $state(false);
let progress = $state({ done: 0, total: 0 });
let runResult = $state<ImportRunResult | null>(null);
let runController: AbortController | null = null;

const validation = $derived(
  table
    ? validateRows({
        headers: table.headers,
        rows: table.rows,
        lines: table.lines,
        mapping,
        fields,
        maxIssues: 1000,
      })
    : null,
);
const rowIssueCap = $derived(validation?.issues.slice(0, ISSUE_ROWS) ?? []);
const invalidLines = $derived(
  new Set(validation?.issues.map((i) => i.line) ?? []),
);
const mappedColumns = $derived(
  table
    ? mapping.flatMap((target, index) =>
        target !== null && fieldByName.has(target) ? [index] : [],
      )
    : [],
);
const mappingBlocked = $derived((validation?.mappingIssues.length ?? 0) > 0);
const readyCount = $derived(validation?.records.length ?? 0);
// After a run the rows are saved: lock the form so the same file cannot be
// imported twice. "Import another file" starts over.
const locked = $derived(running || runResult !== null);

function delimiterName(delimiter: string): string {
  switch (delimiter) {
    case ';':
      return t(M['ui.importExport.delimiter.semicolon']);
    case '\t':
      return t(M['ui.importExport.delimiter.tab']);
    case '|':
      return t(M['ui.importExport.delimiter.pipe']);
    default:
      return t(M['ui.importExport.delimiter.comma']);
  }
}

// Monotonic token for in-flight file reads. A plain `let` on purpose: it is
// compared by value and must never trigger rendering. Bumped by every new
// selection, reset, and teardown, so an older read can never land its table
// and mapping next to a newer file name.
let readToken = 0;
onDestroy(() => {
  readToken += 1;
});

function resetImport() {
  readToken += 1;
  reading = false;
  table = null;
  mapping = [];
  fileName = '';
  files = [];
  fileError = null;
  runResult = null;
  progress = { done: 0, total: 0 };
}

async function onFiles(picked: File[]) {
  const token = ++readToken;
  reading = false;
  runResult = null;
  table = null;
  fileError = null;
  const file = picked[0];
  if (!file) return;
  fileName = file.name;
  if (file.size > maxFileBytes) {
    fileError = t(M['ui.importExport.import.tooLarge'], {
      name: file.name,
      size: (file.size / (1024 * 1024)).toFixed(1),
      limit: (maxFileBytes / (1024 * 1024)).toFixed(1),
    });
    return;
  }
  reading = true;
  try {
    const text = await file.text();
    if (token !== readToken) return;
    // maxRows data rows plus the header record.
    const parsed = parseTable(text, { maxRecords: maxRows + 1 });
    table = parsed;
    mapping = autoMapColumns(parsed.headers, fields);
  } catch (error) {
    if (token !== readToken) return;
    if (error instanceof CsvParseError) {
      fileError =
        error.code === 'too-many-rows'
          ? t(M['ui.importExport.import.tooManyRows'], { limit: maxRows })
          : error.code === 'unterminated-quote'
            ? t(M['ui.importExport.import.unterminatedQuote'], {
                line: error.line,
              })
            : t(M['ui.importExport.import.empty']);
    } else {
      fileError = t(M['ui.importExport.import.readFailed']);
    }
  } finally {
    if (token === readToken) reading = false;
  }
}

function setTarget(index: number, target: string) {
  mapping = setColumnTarget(mapping, index, target === '' ? null : target);
}

function redetect() {
  if (table) mapping = autoMapColumns(table.headers, fields);
}

async function startImport() {
  if (!createRecord || !validation || mappingBlocked) return;
  const records = validation.records;
  runController = new AbortController();
  running = true;
  runResult = null;
  progress = { done: 0, total: records.length };
  try {
    const result = await runImport({
      records,
      createRecord,
      concurrency,
      signal: runController.signal,
      onProgress: (done, total) => {
        progress = { done, total };
      },
    });
    runResult = result;
    onimported?.(result);
  } finally {
    running = false;
    runController = null;
  }
}

function stopImport() {
  runController?.abort();
}

function downloadReport() {
  const issues: ImportIssue[] = [
    ...(validation?.mappingIssues ?? []),
    ...(validation?.issues ?? []),
    ...(runResult?.failed ?? []),
  ];
  deliver(buildErrorReport(issues, issueMessages, 'import-errors'));
}

function issueText(issue: ImportIssue): string {
  const base = issueMessages[issue.code] ?? issue.code;
  return issue.detail ? `${base} (${issue.detail})` : base;
}

function fieldLabel(name: string | undefined): string {
  return (name && fieldByName.get(name)?.label) || name || '';
}

// ---- export ---------------------------------------------------------------
let selected = $state<string[] | null>(null);
let format = $state<ExportFormat>('csv');
let includeHeader = $state(true);
let headerStyle = $state<'name' | 'label'>('name');
let exporting = $state(false);
let exportMessage = $state<{ kind: 'success' | 'error'; text: string } | null>(
  null,
);

// Until the user touches the list, every exportable column is selected, and a
// fields prop change keeps following that default.
const selectedColumns = $derived(selected ?? exportable.map((f) => f.name));

function toggleColumn(name: string, on: boolean) {
  const current = new Set(selectedColumns);
  if (on) current.add(name);
  else current.delete(name);
  selected = exportable.map((f) => f.name).filter((n) => current.has(n));
}

async function startExport() {
  if (!loadRows || selectedColumns.length === 0) return;
  exporting = true;
  exportMessage = null;
  try {
    const rows = await loadRows({});
    const file = buildExportFile({
      rows,
      fields,
      columns: selectedColumns,
      format,
      includeHeader,
      headerStyle,
      filename,
    });
    deliver(file);
    exportMessage = {
      kind: 'success',
      text: t(M['ui.importExport.export.done'], {
        rows: file.rowCount,
        columns: file.columnCount,
        filename: file.filename,
      }),
    };
  } catch (error) {
    const limit = (error as { maxRows?: number } | null)?.maxRows;
    exportMessage = {
      kind: 'error',
      text:
        typeof limit === 'number'
          ? t(M['ui.importExport.export.limit'], { limit })
          : t(M['ui.importExport.export.failed'], {
              reason: error instanceof Error ? error.message : String(error),
            }),
    };
  } finally {
    exporting = false;
  }
}
</script>

<section class="smrt-import-export" aria-label={collectionLabel ? `${t(M['ui.importExport.label'])}: ${collectionLabel}` : t(M['ui.importExport.label'])}>
  {#if canImport && canExport}
    <SegmentedControl
      label={t(M['ui.importExport.mode'])}
      options={[
        { value: 'import', label: t(M['ui.importExport.tab.import']) },
        { value: 'export', label: t(M['ui.importExport.tab.export']) },
      ]}
      value={chosenTab}
      onvaluechange={(value) => {
        chosenTab = value === 'export' ? 'export' : 'import';
      }}
    />
  {/if}

  {#if tab === 'import' && canImport}
    <div class="smrt-import-export__panel">
      <FilePicker
        bind:files
        label={t(M['ui.importExport.import.file'])}
        description={t(M['ui.importExport.import.fileDescription'])}
        accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
        dropzone
        disabled={running}
        onchangefiles={onFiles}
      />

      {#if reading}
        <p role="status">{t(M['ui.importExport.import.reading'], { name: fileName })}</p>
      {/if}
      {#if fileError}
        <Alert variant="error">{fileError}</Alert>
      {/if}

      {#if table && validation}
        <p role="status">
          {t(M['ui.importExport.import.parsed'], {
            name: fileName,
            rows: table.rows.length,
            columns: table.headers.length,
            delimiter: delimiterName(table.delimiter),
          })}
        </p>

        <Card>
          {#snippet header()}
            <h3>{t(M['ui.importExport.map.heading'])}</h3>
          {/snippet}
          <p>{t(M['ui.importExport.map.help'])}</p>
          <div class="smrt-import-export__scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t(M['ui.importExport.map.column'])}</th>
                  <th scope="col">{t(M['ui.importExport.map.sample'])}</th>
                  <th scope="col">{t(M['ui.importExport.map.target'])}</th>
                </tr>
              </thead>
              <tbody>
                {#each table.headers as header, index (index)}
                  <tr>
                    <th scope="row">{header || `#${index + 1}`}</th>
                    <td>{table.rows[0]?.[index] ?? ''}</td>
                    <td>
                      <Select
                        value={mapping[index] ?? ''}
                        disabled={locked}
                        aria-label={t(M['ui.importExport.map.select'], { column: header || `#${index + 1}` })}
                        onchange={(event) => setTarget(index, event.currentTarget.value)}
                      >
                        <option value="">{t(M['ui.importExport.map.ignore'])}</option>
                        {#each importable as field (field.name)}
                          <option value={field.name}>
                            {field.required
                              ? t(M['ui.importExport.map.required'], { label: field.label })
                              : field.label}
                          </option>
                        {/each}
                      </Select>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <Button variant="ghost" size="sm" onclick={redetect} disabled={locked}>
            {t(M['ui.importExport.map.reset'])}
          </Button>
        </Card>

        <Card>
          {#snippet header()}
            <h3>{t(M['ui.importExport.check.heading'])}</h3>
          {/snippet}
          <p role="status">
            {t(M['ui.importExport.check.summary'], {
              valid: readyCount,
              total: validation.totalRows,
              invalid: validation.invalidRows,
            })}
            {t(M['ui.importExport.check.noWrite'])}
          </p>
          {#each validation.mappingIssues as issue, i (i)}
            <Alert variant="warning">
              {fieldLabel(issue.field)}: {issueText(issue)}
            </Alert>
          {/each}
          {#if mappingBlocked}
            <p>{t(M['ui.importExport.check.mappingFixed'])}</p>
          {/if}

          {#if mappedColumns.length > 0}
            <h4>{t(M['ui.importExport.check.preview'], { count: Math.min(PREVIEW_ROWS, table.rows.length) })}</h4>
            <div class="smrt-import-export__scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t(M['ui.importExport.check.line'])}</th>
                    {#each mappedColumns as col (col)}
                      <th scope="col">{fieldLabel(mapping[col] ?? undefined)}</th>
                    {/each}
                    <th scope="col">{t(M['ui.importExport.check.status'])}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each table.rows.slice(0, PREVIEW_ROWS) as row, r (r)}
                    {@const line = table.lines[r]}
                    <tr>
                      <th scope="row">{line}</th>
                      {#each mappedColumns as col (col)}
                        <td>{row[col] ?? ''}</td>
                      {/each}
                      <td>
                        {#if invalidLines.has(line)}
                          <Badge variant="error">{t(M['ui.importExport.check.rowStatus.bad'])}</Badge>
                        {:else}
                          <Badge variant="success">{t(M['ui.importExport.check.rowStatus.ok'])}</Badge>
                        {/if}
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}

          {#if rowIssueCap.length > 0}
            <h4>{t(M['ui.importExport.check.problems'])}</h4>
            <div class="smrt-import-export__scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">{t(M['ui.importExport.check.line'])}</th>
                    <th scope="col">{t(M['ui.importExport.check.column'])}</th>
                    <th scope="col">{t(M['ui.importExport.check.value'])}</th>
                    <th scope="col">{t(M['ui.importExport.check.problem'])}</th>
                  </tr>
                </thead>
                <tbody>
                  {#each rowIssueCap as issue, i (i)}
                    <tr>
                      <th scope="row">{issue.line}</th>
                      <td>{issue.column ?? fieldLabel(issue.field)}</td>
                      <td>{issue.value ?? ''}</td>
                      <td>{issueText(issue)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            {#if validation.issuesTruncated || validation.issues.length > ISSUE_ROWS}
              <p>{t(M['ui.importExport.check.truncated'])}</p>
            {/if}
          {/if}

          <div class="smrt-import-export__actions">
            <Button
              onclick={startImport}
              disabled={locked || mappingBlocked || readyCount === 0}
              loading={running}
            >
              {t(M['ui.importExport.run.import'], { count: readyCount })}
            </Button>
            {#if running}
              <Button variant="secondary" onclick={stopImport}>
                {t(M['ui.importExport.run.cancel'])}
              </Button>
            {/if}
            {#if validation.issues.length > 0 || validation.mappingIssues.length > 0}
              <Button variant="secondary" onclick={downloadReport}>
                {t(M['ui.importExport.run.report'])}
              </Button>
            {/if}
          </div>
          {#if !mappingBlocked && readyCount === 0}
            <p>{t(M['ui.importExport.check.nothing'])}</p>
          {/if}

          {#if running}
            <ProgressBar
              value={progress.done}
              max={Math.max(1, progress.total)}
              label={t(M['ui.importExport.run.progress'], progress)}
              showLabel
            />
          {/if}
        </Card>

        {#if runResult}
          <Alert variant={runResult.failed.length > 0 || runResult.aborted ? 'warning' : 'success'}>
            <p>
              {t(M['ui.importExport.run.done'], {
                created: runResult.created,
                attempted: runResult.attempted,
              })}
            </p>
            {#if runResult.failed.length > 0}
              <p>{t(M['ui.importExport.run.failed'], { count: runResult.failed.length })}</p>
            {/if}
            {#if runResult.aborted}
              <p>
                {t(M['ui.importExport.run.aborted'], {
                  remaining: runResult.attempted < readyCount ? readyCount - runResult.attempted : 0,
                })}
              </p>
            {/if}
            {#snippet action()}
              <Button variant="ghost" size="sm" onclick={resetImport}>
                {t(M['ui.importExport.run.again'])}
              </Button>
            {/snippet}
          </Alert>
          {#if runResult.failed.length > 0}
            <Button variant="secondary" onclick={downloadReport}>
              {t(M['ui.importExport.run.report'])}
            </Button>
          {/if}
        {/if}
      {/if}
    </div>
  {/if}

  {#if tab === 'export' && canExport}
    <div class="smrt-import-export__panel">
      <Card>
        {#snippet header()}
          <h3>{t(M['ui.importExport.export.heading'])}</h3>
        {/snippet}
        <div class="smrt-import-export__actions">
          <Button variant="ghost" size="sm" onclick={() => (selected = exportable.map((f) => f.name))}>
            {t(M['ui.importExport.export.all'])}
          </Button>
          <Button variant="ghost" size="sm" onclick={() => (selected = [])}>
            {t(M['ui.importExport.export.none'])}
          </Button>
        </div>
        <fieldset class="smrt-import-export__columns">
          <legend>{t(M['ui.importExport.export.columns'])}</legend>
          {#each exportable as field (field.name)}
            <Checkbox
              label={field.label}
              checked={selectedColumns.includes(field.name)}
              disabled={exporting}
              onchange={(event) => toggleColumn(field.name, event.currentTarget.checked)}
            />
          {/each}
        </fieldset>

        <Select
          value={format}
          disabled={exporting}
          aria-label={t(M['ui.importExport.export.format'])}
          onchange={(event) => (format = event.currentTarget.value === 'tsv' ? 'tsv' : 'csv')}
        >
          <option value="csv">{t(M['ui.importExport.export.formatCsv'])}</option>
          <option value="tsv">{t(M['ui.importExport.export.formatTsv'])}</option>
        </Select>
        <Checkbox
          label={t(M['ui.importExport.export.header'])}
          bind:checked={includeHeader}
          disabled={exporting}
        />
        {#if includeHeader}
          <Select
            value={headerStyle}
            disabled={exporting}
            aria-label={t(M['ui.importExport.export.headerStyle'])}
            onchange={(event) => (headerStyle = event.currentTarget.value === 'label' ? 'label' : 'name')}
          >
            <option value="name">{t(M['ui.importExport.export.headerName'])}</option>
            <option value="label">{t(M['ui.importExport.export.headerLabel'])}</option>
          </Select>
        {/if}

        <div class="smrt-import-export__actions">
          <Button
            onclick={startExport}
            disabled={exporting || selectedColumns.length === 0}
            loading={exporting}
          >
            {t(M['ui.importExport.export.run'], { count: selectedColumns.length })}
          </Button>
        </div>
        {#if selectedColumns.length === 0}
          <p>{t(M['ui.importExport.export.noColumns'])}</p>
        {/if}
        {#if exporting}
          <p role="status">{t(M['ui.importExport.export.loading'])}</p>
        {/if}
        {#if exportMessage}
          <Alert variant={exportMessage.kind}>{exportMessage.text}</Alert>
        {/if}
      </Card>
    </div>
  {/if}
</section>

<style>
  .smrt-import-export {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4);
  }
  .smrt-import-export__panel {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4);
  }
  .smrt-import-export__scroll {
    overflow-x: auto;
  }
  .smrt-import-export__scroll table {
    border-collapse: collapse;
    width: 100%;
  }
  .smrt-import-export__scroll th,
  .smrt-import-export__scroll td {
    padding: var(--smrt-spacing-2);
    text-align: start;
    vertical-align: top;
    border-block-end: 1px solid var(--smrt-color-outline-variant, currentColor);
  }
  .smrt-import-export__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
    align-items: center;
  }
  .smrt-import-export__columns {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    gap: var(--smrt-spacing-2);
    border: 0;
    padding: 0;
    margin: 0;
  }
</style>
