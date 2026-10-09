# smrt-svelte/import-export

Module semantics for `src/components/import-export/` (`./import-export`).
Package orientation and cross-module invariants live in
[../AGENTS.md](../AGENTS.md); read that first.

## Shape

`ImportExport.svelte` is a thin shell over a pure layer. The pure files import
no Svelte or DOM API and are unit-tested in Node; keep logic there, not in the
component.

| File | Owns |
|------|------|
| `csv.ts` | RFC 4180 parse/format, delimiter detection, BOM, formula neutralization |
| `validate.ts` | `coerceCell`, `validateMapping`, `validateRows` (the dry run) |
| `mapping.ts` | `autoMapColumns`, `setColumnTarget` |
| `fields.ts` | `fieldsFromCollectionDefinition`: manifest + resolved field policy to `ImportExportField[]` |
| `collection-adapter.ts` | `createCollectionImportExport`: generated CRUD fetchers to `createRecord` / `loadRows` |
| `runner.ts` | `runImport`: bounded-concurrency create, per-row failures, abort |
| `export.ts` / `report.ts` | `buildExportFile`, `buildErrorReport` |
| `download.ts` | the only DOM touch: Blob download (overridable via `ondownload`) |

## Invariants

- **Field policy is a hard boundary.** `hidden` fields are neither importable
  nor exportable; `locked` fields are not importable but keep their resolved
  default; tenant fields (`tenantId`) are never imported (the server sets
  them). `id` is export-only. Do not add a path that writes a non-importable
  field.
- **Nothing is written during validation.** `validateRows` returns no records
  while `mappingIssues` is non-empty (an unmapped required field would be
  written without its value). `records` only ever holds fully valid rows;
  there is no partial-row import.
- **Strict typing.** Integers must be JavaScript-safe integers (money is
  integer minor units, never decimals); datetimes are strict ISO 8601 with a
  missing offset meaning UTC; `3/5/2026` is rejected, not guessed. Booleans
  accept `true/false/yes/no/y/n/1/0/on/off`. Enum matching is
  case-insensitive and writes the canonical option.
- **Defaults fill empties.** An empty or unmapped cell takes the field's
  resolved default; a required field with a default is satisfied.
- **Exports are spreadsheet-safe.** Text cells starting with `= + - @`, tab or
  CR are prefixed with `'`; numeric and boolean columns are exempt so negative
  numbers survive. Import strips that prefix back off text cells. The error
  report is neutralized too, because it echoes user data.
- **Export never truncates silently.** `loadRows` pages with `limit`/`offset`
  and throws `ExportLimitError` past `maxRows` (default 50,000).
- **Row failures are per row.** `runImport` continues past a rejected row and
  reports it by file line; abort stops starting new rows and counts in-flight
  ones.
- **Messages are i18n keys.** Issue text lives under `ui.importExport.issue.*`
  in `src/i18n/strings.import-export.ts` (registered in `i18n/server.ts`);
  `describeIssue` falls back to English defaults for the pure layer.

## Not here

Native `.xlsx` read/write (save as CSV first), server-side dry-run endpoints,
upsert-by-key, and recipe/nav wiring (offering the panel on list screens waits
on the recipe surface contract, #3708).
