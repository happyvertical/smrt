# Workbook import (#5034)

`/import` uploads raw `.xlsx` bytes to owner-only `POST /api/shell/import`.
`GET` polls; `POST /api/shell/import/stop|resume|cancel|discard` controls the
current owner's import. All routes use `ownerOf` (same-origin for writes).
The streamed byte ceiling is `IMPORT_MAX_BYTES` (25 MiB). The adapter-node
startup wrapper sets its default `BODY_SIZE_LIMIT` before importing the server,
including `node build` in the desktop sidecar. A lower operator setting remains
an explicit ceiling. The separate provisional cell ceiling defaults to the
spreadsheet package's 250,000; `/settings/import` saves an integer in
1,000..2,000,000 through smrt-preferences. JSON route limits do not apply to bytes.

- `src/lib/server/import-workflow.ts` defines `app-shell.import` and the
  registered `best` prompt `app-shell.import.plan`. The step is Plan and load;
  the JSON schema belongs to spreadsheets, and `validatePlan` remains the
  semantic authority. `checkPlan` errors repeat at most three times with bounded
  finding codes/locations, then fail `check_failed`. No approval hold.
- Input is `import:<id>`; `readInput` reads the owner/tenant-scoped `AppImport`
  and private file. Model input is SDK `profileWorkbook`, names, tables,
  validations, up to five sample rows, three profile samples and 100 formula
  examples per sheet. Facts over 120,000 characters are refused, never silently
  shortened into a partial plan. No whole workbook is sent to a model.
- `AppImport` is a new shell model with no generated API/MCP/CLI surface. Its
  JSON detail holds the plan (including currency/scale), findings and proof;
  bytes are private `imports/<id>.xlsx` (directory 0700, files 0600). Cleanup
  runs on failure, cancellation, discard and publish, and reconciles missed
  draft events after restart. A paused run retains input for resume.
- The draft id is saved before `startDraft` forks. The workflow owns a durable
  hold, restored by `adoptDraft`: no draft reads/edits or publish while loading
  or proving. Recovery discards only its recorded draft, then repeats the step.
  Proof failure discards it; successful proof seals hidden provenance, ends
  the workflow, then releases the hold. Publish uses the existing digest-pinned
  draft Approval. No live write path is added.
- `src/engine/import-target.ts` implements `ImportTarget`. Stable hashed names
  avoid truncation/camel-case collisions; the retained plan reverses the mapping.
  It preflights expressions and reports, creates structure in `loadOrder`, and
  uses atomic insert `loadRecords` commands (default 500 rows). Composite lookup
  keys use a JSON tuple in a temporary engine field. Source row and lookup
  metadata are hidden after loading/proof, before releasing the draft hold.
  `readStoredRows` is a bounded engine-only read-back, including hidden values
  and exact unsafe integers; it is never exposed in REST/MCP/UI. Engine journal
  caps remain per-version, unchanged; publish replays each load before hiding
  metadata. A 10,000-row contract test rehearses the whole chain.
- `import-runtime.ts` registers `createWorkflowRunJobs` before starting the local
  `createEmbeddedJobRunner` with claim fencing. Each engine effect calls workflow `assertActive()` to
  check its current job claim and run status. Shell startup enables background
  jobs, uses the supported local schema migration/system bootstrap, and resumes
  interrupted/stale dispatches. Shutdown stops jobs, disposes handlers, then
  closes hosts. No runtime-managed shell database or handwritten DDL.
- The initial budget is 400,000 tokens, four steps, two schema repair retries,
  30 active minutes. Resume adds bounded token/time allowance, capped at
  1.2 million tokens/90 minutes; cancel is final. Usage off and disconnected
  API inference refuse before consuming the upload. Provider error text is
  never displayed or logged by the import service.

Tests: `src/engine/import-target.test.ts` runs the generated business workbook
against both the SQLite reference and engine targets, batch rollback, formula
refusal, hidden provenance, and 10,000-row load/publish rehearsal.
`src/lib/server/import-workflow.test.ts` covers scripted tracked calls, repeat,
proof failure, held publishing, stop/resume, restart, cancellation, admission,
owner/tenant/origin route checks and settings. `routes/import/import.dom.test.ts`
covers picker/refusals, progress/controls, label-only proof review and settings.
All run under package `test` on Node 26/in-process SQLite or Svelte 5/jsdom.
New capability: no bug-fix base comparison; browser visual QA belongs to integration.
