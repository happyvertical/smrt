# Draft UI validation

The content header owns draft controls on home, model, history and review pages; welcome and settings have none. Chat is hidden during onboarding. The publish preview groups Added, Removed, Changed and Archived items in counted cards before its ordered changes and full method code. The saved owner view selects the
layout description; loaders and mutations carry that description's explicit
target. Changing copies remounts forms and returns home. Approvals always name
live. Reports use the same saved copy at `/reports` and `/reports/[name]`; both keep the content-header draft controls. Shell copy uses the existing plain-text
pattern (the package has no message catalog).

| Behavior | Trigger and positive case | Failure case | Context / executor | Runtime / edge | Level / command |
|---|---|---|---|---|---|
| Content controls | Owner starts draft; count, switch, actions, chat badge | Unpublishable draft disables switching/review; discard remains | Owner browser, shell routes | Svelte 5 / draft events | DOM / package test |
| Explicit copy | Switch persists view; description drives reads and writes | Failed switch keeps rendered copy; other-copy record events ignored | Owner, server event.fetch and browser fetch | Node 26 + jsdom / REST and MCP targets | Node + DOM / package test |
| Draft records | Draft delete 200 navigates away | Live delete 202 waits for approval | Owner, existing server gate | SQLite through server (unchanged) | DOM / package test |
| Navigation | Draft-only model has new badge | Live lists only live models | Owner layout | jsdom / describe | DOM / package test |
| Review | Full preview, all code and archive counts | Chain change before request or approval offers review again | Owner gesture, pinned Approval | jsdom / preview + publish + decide | DOM / package test |
| History | Publish versions grouped, undo-to uses first parent | Purged/current boundaries disable undo; 202 links to approvals | Owner, existing undo transaction | Node 26 + jsdom / history | Node + DOM / package test |
| Lifecycle | Started/published/discarded/unpublishable refresh dependencies | Unknown events ignored; reconnect refreshes all | Owner SSE subscription | jsdom / EventSource | DOM + Node / package test |
| Live data survives | Define, fork, edit, write live, publish, undo, discard | Draft test rows excluded on publish | Owner HTTP session, real engine | Node 26 + SQLite / production server | Manual / README Run it |

Database/auth contracts and transactions are unchanged; their negative cases
remain covered by the existing server suites. This is a new UI, so a bug-fix
base comparison is not applicable. No containers or external services are needed.

Manual execution (Node 26.12.1, production adapter-node build, port 4821):
`smrt app setup` with a fresh real path under `/private/tmp`, then `node build`.
Created the owner through the setup form. Authenticated curl calls defined Chore,
seeded a live row, converted points and removed obsolete in the draft, added Note
and a code method, and added separate live/draft records after the fork. The
review UI showed full code and archive counts. Changing the chain after review
refused Publish and offered Review again. Publishing through its Approval kept
the new live row (points converted to 8), excluded the draft-only row, and tagged
all five versions. History's Undo this publish raised an Approval; approving
restored the text field and archived obsolete value and retained the live row.
Started another draft and confirmed Discard. At 390×844, the content controls
wrapped without horizontal overflow and retained the warning; the new marker
used the warning token. Stopped the server by PID and removed session cookies
and temporary runtime data. No browser page errors were observed.

## Desktop QA regressions

All rows below use the signed-in owner, Node 26 and in-process SQLite where
persistence is involved; no transaction or schema behavior changes. DOM cases
run with `vitest run -c vitest.dom.config.ts`, server cases with `vitest run`.
The package `test` command runs both. Each regression is checked against its
pre-fix implementation as well as the fixed code.

| Behavior | Reachable trigger / positive | Negative / failure | Executor / edge | Level |
|---|---|---|---|---|
| Assistant readiness | Connect Claude Code or ChatGPT, save key; open composer updates | Sign out disables composer; failed requests preserve known state | Browser connection controls and status route; no credentials in events | DOM |
| Onboarding chat | Welcome or unfinished onboarding hides panel | Finished/skipped onboarding restores saved chat choice; plugin stays hidden | Layout server data and browser layout | DOM |
| Draft bar routes | Home, model list/record, history and review show controls | Welcome and all settings pages hide controls | Browser pathname | DOM |
| Per-turn mode | Start draft after existing conversation, change viewed copy, resume CLI | No draft after discard/publish replaces stale draft context | Stub model and Claude Code/Codex subprocesses; same tool scopes | Node |
| Tool summaries | Builder summary and describe/list phrase | No raw JSON, SQL or snapshot paths; unknown tools get generic phrase | API and CLI events, stored thread replay, HTTP responses | Node + DOM |
| Attribution | Owner id resolves to profile name; recorded assistant and engine remain | Unknown identity uses neutral label; spacing survives DOM rendering | Session profile, approval cards and history | DOM |
| Phone navigation | 375px starts on content, drawer can open on demand | Desktop expanded preference never opens phone drawer; title can ellipsize | Shared shell responsive state | DOM + browser |
| Publish review | Added/Removed/Changed/Archived groups, counts, ordered changes, full code | Empty groups show zero; conversions and archives remain visible | Existing preview payload; UI primitives and tokens | DOM |

QA rerun (2026-11-10, Node 26.12.1, production `node build`, fresh data
outside the checkout, port 4822, desktop owner-link auto-sign-in): native Chrome
showed welcome without chat or draft controls. Selecting Claude Code and finishing
Fresh opened an enabled composer saying “Using Claude Code” without a reload.
Settings had no draft controls. Seeded Product and OldModel, started a draft from
the UI, then added Supplier, a notes field and a method, removed a field/model,
and converted money to integer through the authenticated routes. Review showed
Added 3 / Removed 2 / Changed 1 / Archived 3, then six ordered changes and full
method code. Its approval said “Asked just now by” the owner's profile name;
after approval, History showed that name and retained “engine” on version 0.
At Chrome's 375×812 responsive viewport, a fresh page load showed content,
the full app name and bottom tabs with the drawer closed. Menu opened and closed
it; returning to desktop restored the expanded sidebar. The console was empty.
Real paid model turns, ChatGPT OAuth and real key saves were not exercised;
connection transitions and resumed-engine inputs were verified with DOM tests,
the stub model and both stub CLIs. Each numbered fix has failing pre-fix
regression evidence and passing fixed-code evidence. No containers were used.


## Reports UI (#4917)

Reuse check: read the intent index and ran smrt-dev-mcp review on app-shell.
Existing `ReportResult`, `reportCsv`, chart formatters, shell cell/money formatters,
`hostFor`, `runCommand`, and SSE dependencies are reused. No Svelte MCP is
available in this session. Formula wording is display-only, never evaluation.

| Behavior / invariant | Reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | External edge | Level / command |
|---|---|---|---|---|---|---|---|---|
| Report navigation | Saved reports in viewed description | Group below models, draft-only new badge | No reports hides group; live has no draft items | Owner / saved copy | Description read; N/A mutation | Svelte 5 / jsdom | smrt-svelte nav children | DOM / app-shell test |
| Report results | Open report, record/definition SSE invalidation | Shared result, chart, record links, empty and truncation | Plain error and back link | Owner / explicit live or draft | Engine read, no result persistence | Node 26 / SQLite; Svelte 5 | reports display callbacks | Node + DOM / app-shell test |
| CSV | Download action | Display labels, money, RFC 4180 and formula-safe text | Anonymous/member/other tenant, missing report/copy, invalid target | Verified owner, explicit copy | Same bounded engine read | Node 26 / SQLite | HTTP attachment | Node / app-shell test |
| Report changes | Rename/remove, define through catalog | runCommand, review/history added/changed/renamed/removed | Live frozen, unknown action/name, cross-origin refused | Verified owner / draft split | Existing builder transaction and approval gate; no new writes | Node 26 / SQLite | Existing command contract | Node + DOM / app-shell test |
| Calculated values | Open new/existing record, save, list fields | Read-only formatted value, formula, sorted column | No value before save; never submitted, even injected form values | Owner / viewed copy | Existing record mutation; generated column remains database-owned | Svelte 5, Node 26 / SQLite | Closed SDK expression grammar | Unit + DOM / app-shell test |
| Assistant reports | Catalog tool result and saved thread replay | Safe summaries, shared result in chat, saved-report link | Failed/malformed payload never rendered; no approval bypass | Owner / one catalog policy | Existing turn/thread store; rows stay transient | Node 26, Svelte 5 | API + CLI event details | Unit + Node + DOM / app-shell test |

UI additions have no prior implementation to compare as a bug-fix base. Existing
engine rollback, replay and approval idempotence suites remain the transaction
evidence. Browser visual QA is delegated to the coordinator, not claimed here.

Report runs preserve `RuntimeReportError` code/path across the read worker.
`invalid_result` is explained as a value too large to show exactly, naming a
sum's source field label and calculated input labels when available. Results,
CSV and failed assistant runs use the same safe wording; compiler/driver text
and stacks are never displayed. Changed-field failures retain their repair
message. Record input limits are unchanged.

Report key renames change the report's link. Draft review, History and tool
summaries say this using the report label; visible renames use labels on both
sides and never display the key.
