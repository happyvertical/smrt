# Workbook import (#5034)

`/import` uploads raw `.xlsx` bytes to owner-only `POST /api/shell/import`.
`GET` polls; `POST /api/shell/import/stop|resume|retry|cancel|discard` controls the
current owner's import. All routes use `ownerOf` (same-origin for writes).
`GET /api/shell/import/preview?table=<plan key>&limit=` reads only its review draft,
ordered by workbook row (NULLs last, id tie-break), with record-page labels resolved by id.
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
  hold, restored by `adoptDraft`: no reads/edits or Apply while loading
  or proving. Recovery discards only its recorded copy, then repeats the step.
  Proof failure discards it; successful proof seals hidden provenance, ends
  the workflow, then releases the hold. No live write path is added.
- Changes waiting (#5207): `createEngineImportTarget`'s `onCommand` hook wraps
  its one `host.execute`; the workflow passes `recordImportCommand` (changes.ts),
  which runs the command on the held copy and records it on ITS TABLE's card
  (define, fields, 500-row loads, provenance hides; a report is its own card),
  all sharing group `import:<id>`; /changes shows them under one collapsible
  header. It refuses unless the import holds the copy and can only record
  (`invariants.test.ts`: callers are changes.ts and import-workflow.ts, no apply
  or live path). A rebuild (Remove, Put back, Quick edit of the table name or
  choices) replays all active cards but moves the provenance `hideField`s after
  the last load, because tables look each other up by a field the hide makes
  invisible; there is no tail fast path (a Remove replays every load, so /changes
  says "Rebuilding your changes"). A rebuilt copy has a new draft id: the import
  row follows it (`setWorkingCopyReplaced`) and reconcile waits for `settled()`.
  A held batch whose copy is gone (failed, repeated, cancelled, discarded import)
  is retired and its cards drop their commands; an import is never "put back".
  Apply is the page's Apply button on `POST /api/shell/changes/apply` (layout
  `changes.digest`; 409 means review again). Another batch waiting refuses a new
  import in plain words ("You have N changes waiting...") instead of joining it.
  Template records: `template-records.ts` turns `importTemplate` with records
  into ONE card (template + `loadRecords` in link order + hides of a temporary
  `templateId` key field), so Apply brings the records.
- An import reuses an open draft only when `discardIfUnused` proves it empty:
  the host's `discardIfEmpty` checks the chain and closes on the change queue
  edits use, so a racing edit keeps the draft or is refused, never lost (#5122).
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
proof still checks every numeric column. Review points owners to the changes waiting
view (`/changes`).

The engine report tool advertises a count/sum/filter example validated by
`parseRuntimeReportSpec`, and specifies exact model/field names for ad-hoc queries.
The realistic target contract executes that advertised spec against imported data.
Report output aliases use lowercase_snake_case (or are omitted for defaults),
while source fields keep engine camelCase. Typed alias refusals explain the rule
without forwarding compiler paths or messages; the real Codex verification covers
an owner-approved publish followed by an ad-hoc count/sum/filter query.

Imported money retains `FieldDef.money { currency, scale }` in the versioned
engine definition. Record display/forms and report cells/CSV use these units;
report figures and chart readouts use the same host formatter. Missing metadata
on older definitions keeps the existing USD/scale-2 default. No stored amount
or proof total is converted to another currency or scale.

Stop/resume status is saved only after the workflow transition succeeds.
A done run with successful proof reconciles to review even from a stale paused
row and releases its draft hold after restart. A late Cancel preserves that
completed draft; only Discard explicitly removes a completed import.

Retry persists its identity before dispatch, but marks running only after admission.
An ordinary admission failure cancels the abandoned attempt and rolls back to the
failed source run with retained bytes and plain retry/discard wording. Each load
command also checks the import's durable run identity. Crash tests seed a pending
intent before/after admission rather than treating a rejected promise as a crash.
Recovery isolates every row (including missing runs/drafts), marks failures locally,
and logs only constant wording. Import initialization cannot fail shell startup;
the runtime migration/readiness guard remains fail-closed and routes retry lazily.
