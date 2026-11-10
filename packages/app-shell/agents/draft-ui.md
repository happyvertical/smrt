# Draft UI validation

The content header owns draft controls. The saved owner view selects the
layout description; loaders and mutations carry that description's explicit
target. Changing copies remounts forms and returns home. Approvals always name
live. No report route is present. Shell copy uses the existing plain-text
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
