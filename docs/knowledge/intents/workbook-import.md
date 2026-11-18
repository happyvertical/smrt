---
type: Capability
title: "Workbook import and proof"
description: "Reach for smrt-spreadsheets import planning and read-back proof, with app-shell drafts and smrt-workflows for durable owner review."
tags:
  - smrt
  - intent
status: draft
generated:
  by: codex/smrt-5034
  at: 2026-11-16T18:36:30Z
stale_after: 2027-02-14T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.62.0
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1/packages/spreadsheets/src/import/index.ts
    path: packages/spreadsheets/src/import/index.ts
    source_revision: e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1
    title: "Public import exports and ImportPlan schema"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1/packages/spreadsheets/src/import/run.ts
    path: packages/spreadsheets/src/import/run.ts
    source_revision: e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1
    title: "runImport admission, load planning and read-back proof"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1/packages/spreadsheets/src/import/target.ts
    path: packages/spreadsheets/src/import/target.ts
    source_revision: e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1
    title: "ImportTarget atomic batches, provenance and exact totals"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1/packages/spreadsheets/src/testing.ts
    path: packages/spreadsheets/src/testing.ts
    source_revision: e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1
    title: "createSqliteReferenceTarget contract fixture target"
  - id: s5
    resource: https://github.com/happyvertical/smrt/blob/e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1/packages/app-shell/src/lib/server/import-workflow.ts
    path: packages/app-shell/src/lib/server/import-workflow.ts
    source_revision: e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1
    title: "Owner-scoped draft import, repeat safety and publish boundary"
  - id: s6
    resource: https://github.com/happyvertical/smrt/blob/e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1/packages/app-shell/src/engine/import-target.ts
    path: packages/app-shell/src/engine/import-target.ts
    source_revision: e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1
    title: "createEngineImportTarget draft-host adapter"
  - id: s7
    resource: https://github.com/happyvertical/smrt/blob/e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1/packages/workflows/src/jobs.ts
    path: packages/workflows/src/jobs.ts
    source_revision: e6f72c7cc37e20d7e93c67fd6d627781b9d5b4a1
    title: "createWorkflowRunJobs durable owner-scoped job bridge"
---

# Workbook import and proof

# Entry point

Read an `.xlsx` workbook with the `@happyvertical/spreadsheets` SDK, then use
`@happyvertical/smrt-spreadsheets/import`: `IMPORT_PLAN_SCHEMA` describes the
model's proposed `ImportPlan`; `validatePlan()` validates its semantics;
`checkPlan(plan, workbook)` checks the mapping against the workbook. Load with
`runImport({ plan, workbook, target, limits })`; it includes `checkLoaded()`
read-back proof. The product supplies an `ImportTarget` with structure, atomic
batch loading, counts, sums and source-row-ordered stored values. Test an adapter
against `createSqliteReferenceTarget()` from
`@happyvertical/smrt-spreadsheets/testing`.[^s1][^s2][^s3][^s4]

In app-shell, use the existing owner-only `/import` flow and
`POST /api/shell/import`. Its `app-shell.import` workflow plans from bounded
workbook facts and loads through `createEngineImportTarget(draftHost)` from
`@happyvertical/smrt-app-shell/engine`. Successful proof leaves a draft for the
existing publish approval. For another host, register a definition with
`createWorkflowRunJobs()` from `@happyvertical/smrt-workflows` before starting a
claim-fenced jobs runner; keep large input behind `inputRef` and `readInput`.[^s5][^s6][^s7]

# Why not hand-roll it

`runImport()` validates and admits the workbook, checks the plan, plans all
batches and reserves verification work before its first target mutation. It
refuses table-key clashes, creates structure in dependency order, loads batches
and proves the stored result against workbook facts. Read-back checks include
row counts, column sums, references and calculated values against the workbook's
cached results. Copying rows into a database alone provides none of that
proof.[^s1][^s2]

`ImportTarget` requires all-or-nothing batches and source-row provenance; money
uses minor units and unsafe integer/money totals remain `bigint`. The SQLite
reference target gives adapters a reusable contract instead of a second import
implementation.[^s3][^s4] App-shell records the import-owned draft before loading,
discards only that draft on repeat or proof failure, and keeps live publication
behind the existing owner approval. The workflow job bridge retains the run's
owner, tenant, checkpoint and claim fence across recovery, so retrying a worker
does not justify loading its half-built tables again.[^s5][^s6][^s7]

# Component pages

- [smrt-spreadsheets](/components/smrt-spreadsheets.md)
- [smrt-app-shell](/components/smrt-app-shell.md)
- [smrt-workflows](/components/smrt-workflows.md)

# Detection signals

- `regex:INSERT.*spreadsheet`
- `regex:workbook.*rows`

[^s1]: `packages/spreadsheets/src/import/index.ts` at `e6f72c7cc3`: Public import exports and ImportPlan schema.
[^s2]: `packages/spreadsheets/src/import/run.ts` at `e6f72c7cc3`: runImport admission, load planning and read-back proof.
[^s3]: `packages/spreadsheets/src/import/target.ts` at `e6f72c7cc3`: ImportTarget atomic batches, provenance and exact totals.
[^s4]: `packages/spreadsheets/src/testing.ts` at `e6f72c7cc3`: createSqliteReferenceTarget contract fixture target.
[^s5]: `packages/app-shell/src/lib/server/import-workflow.ts` at `e6f72c7cc3`: Owner-scoped draft import, repeat safety and publish boundary.
[^s6]: `packages/app-shell/src/engine/import-target.ts` at `e6f72c7cc3`: createEngineImportTarget draft-host adapter.
[^s7]: `packages/workflows/src/jobs.ts` at `e6f72c7cc3`: createWorkflowRunJobs durable owner-scoped job bridge.
