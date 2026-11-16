# Workbook import (#5034)

`/import` uploads raw `.xlsx` bytes to owner-only `POST /api/shell/import`.
`GET` polls; `POST /api/shell/import/stop|resume|retry|cancel|discard` controls the
current owner's import. All routes use `ownerOf` (same-origin for writes).
The streamed byte ceiling is `IMPORT_MAX_BYTES` (25 MiB). The adapter-node
startup wrapper sets its default `BODY_SIZE_LIMIT` before importing the server,
including `node build` in the desktop sidecar. A lower operator setting remains
an explicit ceiling. The separate provisional cell ceiling defaults to the
spreadsheet package's 250,000; `/settings/import` saves an integer in
1,000..2,000,000 through smrt-preferences. JSON route limits do not apply to bytes.

- `src/lib/server/import-workflow.ts` defines `app-shell.import` and the
  registered `best` prompt `app-shell.import.plan`. The step is Plan and load;
  `import-assistant.ts` binds the owner's `assistant` preference (`api`,
  `chatgpt`, `claude-code`, `codex`) at `best`, using chat's public
  `runWorkflowStepTurn`. Each attempt opens a tool-free child turn, linked by
  a handoff; calls/usage roll into the workflow budget and retain its fence.
  CLI calls record reported tokens, otherwise uncosted reserved usage. ChatGPT
  uses its sign-in client and is uncosted. No API-key fallback for these engines.
  CLI planning uses `/mcp?scope=import-plan`: empty catalog, all calls rejected
  before dispatch, protected invocation and a distinct expiring token holder
  per attempt. A late worker cannot revoke the next worker's token or run tools.
  Holders use one attempt UUID (48 characters including the prefix), within
  app-runtime's 80-character limit. Job engine tests mint real local credentials.
  The runtime state-root origin file supplies the current desktop address;
  the upload origin is retained privately in the existing import JSON as the
  development fallback across job recovery.
  The JSON schema belongs to spreadsheets, and `validatePlan` remains the
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
  runs on workbook/app failure, cancellation, discard and publish, and reconciles
  missed draft events after restart. Engine failures retain input for explicit
  retry (a new run; attempt key saved before admission). A paused run retains
  input for resume. Polling exposes typed failure reasons and bounded timestamped
  stage history; internal origins and admission keys never enter that projection.
- The draft id is saved before `startDraft` forks. The workflow owns a durable
  hold, restored by `adoptDraft`: no draft reads/edits or publish while loading
  or proving. Recovery discards only its recorded draft, then repeats the step.
  Proof failure discards it; successful proof seals hidden provenance, ends
  the workflow, then releases the hold. Publish uses the existing digest-pinned
  draft Approval. No live write path is added.
- `src/engine/import-target.ts` implements `ImportTarget`. Names are PascalCase table keys and camelCase field keys, capped at 40
  characters. Plan order breaks ties with suffixes 2, 3, … (inside that cap),
  including engine reserved names, recipe models, existing models and shared
  singular/plural storage routes. App/Approval become App2/Approval2 so their
  generated tools never enter shell prefixes. Digit-leading names get Table/field;
  single-letter camel segments get “value” to satisfy the engine grammar.
  `plan.engineNames` durably records all table/field/report mappings before the
  first command; the canonical spreadsheet plan and proof remain unchanged.
  `workbookRow`/`workbookLookup` are reserved for hidden provenance; source fields
  with those names receive a numeric suffix. No hashes enter the app’s names.
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
  1.2 million tokens/90 minutes; cancel is final. Usage off and a disconnected
  assistant engine refuse before consuming the upload. Provider error text is
  never displayed or logged by the import service.

Tests: `src/engine/import-target.test.ts` runs tiny and realistic (42 orders,
eight customers, title block, text order numbers/year) generated business workbooks
against both the SQLite reference and engine targets, batch rollback, formula
refusal, hidden provenance, and 10,000-row load/publish rehearsal.
`src/lib/server/import-workflow.test.ts` covers scripted tracked calls, repeat,
proof failure, held publishing, stop/resume, restart, cancellation, admission,
owner/tenant/origin route checks and settings. `routes/import/import.dom.test.ts`
covers picker/refusals, progress/controls, label-only proof review and settings.
Welcome's DOM test covers completing onboarding directly into `/import`.
All run under package `test` on Node 26/in-process SQLite or Svelte 5/jsdom.
New capability: no bug-fix base comparison; browser visual QA belongs to integration.

Planning guidance and recursive expression schema come from smrt-spreadsheets.
Repair prompts include bounded validator messages, paths, fragments and rules;
check events keep only code/path/message. A refused plan is distinct from an
unavailable engine and retries the retained upload without a settings detour.
Unrepresentable formulas map as plain cached-value columns; review lists them
under “Formulas not translated”. A proposed translation still must pass proof.

Shell host event wiring formats every changed summary through the same label-based
formatter as History, with both the before and after definitions (including removed
fields). Calculations show label-based expressions in import review and History.
The totals view omits integer checksums except quantity/count/units/qty; the exact
proof still checks every numeric column. Review points owners to the Live/Draft
switch to inspect the imported data before publishing.

The engine report tool advertises a count/sum/filter example validated by
`parseRuntimeReportSpec`, and specifies exact model/field names for ad-hoc queries.
The realistic target contract executes that advertised spec against imported data.
Report output aliases use lowercase_snake_case (or are omitted for defaults),
while source fields keep engine camelCase. Typed alias refusals explain the rule
without forwarding compiler paths or messages; the real Codex verification covers
an owner-approved publish followed by an ad-hoc count/sum/filter query.
