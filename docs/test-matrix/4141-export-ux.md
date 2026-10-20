# Export hierarchy — smrt#4141

Standard risk: presentation and progressive disclosure only. Existing host action capture, errors, download serialization and import/reset handlers are retained.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Clear action hierarchy | Open Export with host action | Build it precedes copy/download; prompt, CLI, summary and reset details start collapsed | No host action retains copy/download fallback | Visitor | Browser state; DB N/A | Browser/happy-dom; SQL N/A | Optional existing host action | DOM + visual QA | export-panel.dom.test.ts; desktop/mobile theme QA |
| Clipboard fallback remains accessible | Copy prompt rejects | Prompt disclosure opens before text receives focus/selection | Clipboard error supplies manual copy instructions | Visitor, denied clipboard | Browser only; transaction N/A | Browser/happy-dom | Existing clipboard promise rejection | DOM | export-panel.dom.test.ts |
| Exact handoff and fallback remain unchanged | Host action then download | Same native export text/name; host is first action | Host rejection leaves download enabled | Visitor/host | Existing synchronous capture | Browser/happy-dom | Existing PlannerExportAction/ExportData | DOM | export-panel.dom.test.ts |
| Optional details stay available | Keyboard expands native disclosure | Prompt, CLI/JSON, cookbook summary and import/reset reachable | Collapsed details avoid first-screen text overload | Visitor, keyboard/mobile/theme | UI only; persistence N/A | Browser | No new external contract | DOM + browser QA | export-panel.dom.test.ts; QA evidence |

Base regression comparison: hierarchy is a requested UI improvement rather than a broken contract. Base source renders the complete summary, ten-row prompt and command before reset; the new DOM assertion records the intentional hierarchy. Existing exact-export and clipboard regressions remain executable. Authentication, tenancy, database dialects, retries and new external input validation are N/A: no such behavior changes.

Focused evidence: `pnpm --filter @happyvertical/smrt-planner exec vitest run --project dom tests/export-panel.dom.test.ts` passed 9/9 (full output `/tmp/4141-export-ux-tests.log`). Planner typecheck identified only the concurrently added `shellTargetAction` missing built workspace export in HeaderIconLink/PlannerHostAction; shared upstream build and browser QA remain coordinator-owned. Full output `/tmp/4141-export-ux-typecheck.log`.
