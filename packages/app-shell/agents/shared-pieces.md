# Shared pieces (Tricia F1)

Tricia keeps its assistant panel, routes, thread models/store and draft/builder
policy. Engine adapters already use smrt-inference (`engines.md`).

Tool chips use smrt-chat's browser-safe `./tool-summary` entry. The shell module
is only a policy adapter: `recordLabels: 'generic'` preserves "Checked records"
and `plainTextSummary` preserves safe free-text labels in saved threads. Shared
credential, SQL, path and payload guards still apply. Default chat labels do
not change.

## Test design

| Behavior/invariant | Trigger | Positive | Failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shared tool labels | Both engines and saved-thread replay | Existing words and shared function | JSON, SQL, paths, credentials excluded | Existing owner/thread context | No mutation | Node/browser | Chat browser-safe entry | Unit + existing DOM | app-shell test; chat test |
| Approval compatibility | Owner requests/decides a risky live action | Original identity, preview, history and one effect | Non-owner, duplicate, invalid action, restart/partial failure | Live verified owner; draft policy stays shell-owned | Shell SQLite + shared authority CAS | Node/SQLite | Runtime authority and chat hold/card | Integration + DOM | app-shell test |
| Connection compatibility | Welcome/settings connect action | Existing engine readiness and model preference | Non-owner, origin, unavailable engine, upstream failure | Verified current owner | Existing assistant preference writes | Node/browser | Shared ConnectAi + route mount | Integration + DOM | app-shell test |

## Reuse check

MCP `review_smrt_project` reviewed app-shell, chat, app-runtime and smrt-svelte;
`build_context` architecture query covered tool labels, durable holds/cards and
engine connection/onboarding. Read the developer-intent index. Name and purpose
`rg` searches over smrt-ui, smrt-svelte, chat, core, app-runtime, approvals and
inference found the shared tool-summary, OwnerApprovalAuthority, approval bridge,
AssistantApprovalCard, ConnectAi and mountConnectAiRoutes. The server exposes
architecture/model context, but no standalone component/intent/recipe search.
No parallel parser or tool-label implementation is introduced.

## Compatibility gaps closed

- Tool words: generic `_list`/`_search`/`_get` results stay "Checked records";
  arbitrary safe saved summary text remains readable. Both are chat options.
- Durable holds: Tricia has no expiry. Runtime's explicit `nonExpiring` option
  requires a store advertising `supportsNonExpiring`; the canonical store still
  refuses it. The legacy single-tenant storage adapter retains all rows and ids,
  translates accepted/executing/completed states and uses database CAS rather
  than a process-local in-flight set. No schema change or data migration.
- Waits: chat's `observeAssistantApproval` waits for a host-completed result;
  it cannot decide, consume or execute. Runtime `wait({ settled: true })`
  observes pending/approved/executing until terminal. Abort/timeout retain rows.
- Approval UI: the shared card's optional host-authorized presentation retains
  the heading, Waiting/Approved wording, timestamps, errors, disabled controls
  and callbacks. Its `detail` snippet carries shell-owned builder/code/draft
  previews and the publish retry link; that policy stays in Tricia.
- Connection UI: `presentation="compact"` retains Claude Code + ChatGPT on
  Welcome, Codex under Advanced in Settings, version/account text, existing
  legal/advanced links, success messages and auto-selection after a login the
  page started. Optional `modelState`/`chooseModel` use the existing shell
  model-preference routes. One shared request/poll/abort lifecycle handles both
  presentations; the browser-safe `./connect-ai/client` exports the pure words.
- Connection routes: `allowUnconfiguredApiSelection` preserves choosing API
  without a key; `includeSignOutConfirmation` preserves the old response.
  Both default off. The shell maps its established JSON endpoints to the
  shared actions, retains owner/origin checks, model validation, Fresh/Skip
  and sign-out preference policy. No assistant route/thread replacement.

## New-file reuse evidence

`src/lib/server/approval-store.ts` is the only new production helper file.
MCP review/context and `rg` approval/owner/hold/storage/legacy/tenant searches
found runtime's existing `OwnerApprovalStore` extension seam but no adapter
for Tricia's `approvals` schema. It implements that seam over the existing
`ApprovalCollection`; decision, consumption, result bounds and waiting reuse the
shared authority. The legacy model remains solely for installed storage and its
saved generated API contract. `approval-store.test.ts` and
`components/shared-pieces.dom.test.ts` introduce only test-local fixtures and
exercise the real shared exports. No new component/model/route/tool file.

Hindsight recall was attempted for `package:app-shell`; the configured tool
reported offline. Canonical adapter documentation is retained here instead.

Template definitions can exceed the shared plain-envelope nesting and 128 KB
limits. The adapter passes the validated action and preview as inert JSON (the existing
column contracts), and opts into a 4 MB envelope budget for the shell's bounded
HTTP/template input plus preview. Shared default limits remain unchanged.
The only root config edit removes the stale raw-pixel allowance for the old
card's removed screen-reader CSS; the shared card uses button accessible names.


The nested draft-preview regression fails before the JSON-envelope adapter and
passes after it: field defaults may themselves contain nested JSON and must
remain visible exactly as reviewed. The shared authority does not interpret
that host policy data or relax its plain-data depth guard.


The old publish-review flow also depends on exact decision-button text. The
shared Button historically inserts a spacer before its label. MCP review on
smrt-ui and name/purpose searches for Button label/whitespace/text contracts
found no opt-out. Its additive `labelWhitespace="trim"` option preserves the
old shell text; the default `preserve` output is tested unchanged for buttons
and links. The shared approval card alone opts into trimming. This is the
small additional owning-package edit in `smrt-ui` (Button plus its existing
golden tests); no new component/helper/model file is added.
