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

Onboarding GET delegates readiness to `mountConnectAiRoutes.GET`, backed by
inference's `createAgentCliService` and locked-command preflight, like the
cookbook host. Tricia adds its onboarding preference and safe version/account
presentation; those fields never decide readiness. Its browser `ToolInfo` reuses
the shared ConnectAiState tool shape rather than maintaining a reduced copy.
Only successful preflight says Ready in this app (with the version when known).
A signed-in CLI that cannot start remains unselectable with its fixed reason.
The real fixture-backed route test verifies ready → broken locked command,
GET/configuration/status refusal, no path disclosure and no billing fallback.
Both mounted Tricia variants cover the refused state; the existing composer
selection/sign-out/saved-key flow is retained. Positive DOM snapshots model the
server's explicit preflight success instead of implying ready from sign-in.

Reuse for this correction: MCP project reviews of app-shell, smrt-svelte and
template, the intent index, and name/purpose searches found the existing shared
status handler, inference CLI service, DTO and translated status messages. No new
component, helper, model, type definition or route file was added.

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


C4 OpenAI follow-up: shared Connect AI now lists Codex after recommended ChatGPT
in welcome and settings, preserving the same preflight-backed Tricia handler,
model preference and composer refresh. DOM expectations retain real ready status
and assert the shared order instead of the superseded settings-only disclosure.
Codex containment is owned by inference (`agents/engines.md`), never a shell shim.

`pnpm test` first runs `svelte-kit sync`: the DOM suite needs the generated
`.svelte-kit/tsconfig.json` even when Turbo restores only built output. A cold
checkout without that config otherwise fails in dependency optimization before
any component test runs (Rolldown's runtime cannot resolve `node:module`).
The test script prepares the config for both the Node and DOM suites; it does
not depend on a preceding uncached build.

S1 shared Connect AI compatibility: the shell client/owner onboarding route forwards `cancel` to shared `chatgpt-cancel`. Unsupported auth SDK cancellation remains an error, not a fake successful sign-out. Existing owner/origin checks and shared readiness status are retained.
