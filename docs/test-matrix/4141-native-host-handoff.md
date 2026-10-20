# Native host handoff and export action — smrt#4141

Scope: additive public Planner host API and the accumulated hosting, workspace, guidance,
overview and native-assistant changes below. High risk: externally initiated mutations,
cross-frame generation/revision/idempotency, stale asynchronous effects, and browser
storage migration/reset rollback. No server authentication, tenant database, deployment
or package-version changes. Host origin/source/consent authorization remains host-owned.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Data executor / transaction | Runtime / dialect | Contract edge | Level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Real native assistant handle | Complete Planner mount / onready | Handle is native AI session transport, legacy assistant distinct | Controls-only mount has no native handle | Browser host | Native memory; no DB transaction | Browser / happy-dom | Additive optional handle | DOM | Planner tests |
| Initial context is complete and atomic | initialConversation or native seed | >6 turns / >1000 characters retained, one notification, no command execution | Repeated id, invalid roles, late / in-flight seed return false with no writes | Browser host before native sends | One synchronous memory append; no DB | Browser | Plain user/assistant input only | Unit + DOM | Planner tests |
| Export represents the exact current app | Native Export action click | Current manual edits, exact file text/name, revision and detached complete thread | In-flight assistant capture rejected | Browser visitor | Synchronous command/read; no await between document/thread | Browser | Existing ExportData serializer | Unit + DOM | Planner tests |
| Export action preserves native fallback | Host callback | First action invokes callback, download remains present | Callback failure shown inline, no disabled download | Browser visitor | External callback owned by host, detached capture | Browser / happy-dom | Optional action; thrown/rejected error | DOM | Planner tests |
| Cancellation does not apply late model actions | Stop while provider pending | Transcript records user and Stopped, busy resets | Provider resolves valid command after abort, command never runs | Browser visitor | Native memory; command executor not called after cancellation | Browser | Provider AbortSignal may be ignored | Unit | Planner tests |
| Host can disable cookbook proposals | cookbookOffers=false | Generic existing recipes still added | Library cookbook excluded from response schema and offers | Browser host | Native controller command | Browser | Default remains true | Unit | Planner tests |
| Current native transcript includes tool outcomes | Report confirmation | Conversation snapshots retain cloned toolCallData | Caller edits returned object, native state unchanged | Browser visitor / host | Memory update notification | Browser | Full JSON-compatible AssistantMessage objects | Unit / existing reports suite | Planner tests |

Commands from repo root:

- `node /Users/will/.local/bin/pnpm --filter @happyvertical/smrt-planner test`
- `node /Users/will/.local/bin/pnpm --filter @happyvertical/smrt-planner typecheck`
- `node /Users/will/.local/bin/pnpm turbo run build --filter=@happyvertical/smrt-planner...`
- Root lint plus hosted planner browser suites per package AGENTS.

This session invokes pnpm through shell Node 26 because the workstation's pnpm
launcher has an absolute Node 24 shebang. It does not change repository tooling.
Prepared changes remain unreleased; production consumers stay on released pins.

## Prepared implementation evidence (2026-10-19)

- Clean origin/main baseline `cdd2c9f59c7a657a301d092b935a548125eeb639`
  dependency/Planner build passed: `/tmp/smrt-planner-host-build-base.log`.
- Full changed Planner suite: 87 files, 1192 tests passed:
  `/tmp/planner-host-final-tests.log`.
- Final Export presentation reconciliation: 8 DOM tests passed:
  `/tmp/planner-host-final-export-tests.log`.
- Final sequential typecheck: zero errors/warnings:
  `/tmp/planner-host-final-typecheck.log`.
- Root lint: all Biome/component/token/cascade/fallback gates passed:
  `/tmp/planner-host-final-lint.log`.
- MCP browser suite: all reported invariants true, no page errors:
  `/tmp/planner-host-mcp-browser.log`.
- Live-preview browser suite: retry same id, preserved draft and locked controls
  true: `/tmp/planner-host-live-browser.log`.
- Actual mounted native shell DOM test opens seeded conversation through the
  public handle and returns false after disposal. Node 26's lack of browser
  storage is supplied by the test's in-memory Storage fixture.

No committed revision, publication or production adoption is claimed: the session
explicitly authorized preparation only. Website E2E uses this separate canonical
upstream build as a transparent local QA alias; production pins stay unchanged.

## Continuous external assistant command port (revised requirement)

The external overlay conversation remains independent of the native assistant.
No seeding, native sends, headless controller, or duplicated app state is used.
The bridge binds the actual `onready.controller` through a dedicated capability
port; exact window origin/source/nonce checks remain host-owned handshake glue.

| Behavior / invariant | Trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime | Contract edge | Level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Same live app and subscriptions | External execute / manual UI edit | Actual controller state and subscriptions change | Stale expectedRevision refused, manual edit preserved | Authorized dedicated port | Actual canonical controller.batch, atomic | Browser/happy-dom MessagePort | Snapshot generation + revision | Integration | planner-bridge.dom.test.ts |
| Scope and bounded mutation | External envelope | Explicit allowed command succeeds | Unknown command, denied command, oversized input, malformed input, invalid mixed batch cause no partial mutation | Host-assigned source, no caller override | Canonical engine validates every input; all-or-none | Browser | JSON/version/16 commands/32KiB/id length | Integration | planner-bridge.dom.test.ts |
| Retry and provenance | Repeat request id | Exact full reply replayed once with configured source | Same id/different reply refused; receipt cap never evicts authority | External assistant | Generation-namespaced engine ids and bounded bridge receipts | Browser | Whole hosted reply fingerprint | Integration | planner-bridge.dom.test.ts |
| Stateless hosted reply application | Hosted inference returns | Actual receipts, coaching and relevant fictional samples | Invalid sample rejected before commands, no-op says nothing changed | External assistant's own conversation | Synchronous revision check + canonical batch + validated sample install | Browser | No native thread writes | Integration | planner-bridge.dom.test.ts |
| Reset / late response | Reply queued before visitor reset | Real resetWorkspace calls binding.invalidate synchronously | Old reply rejected after reset, no recipes/samples resurrected | Explicit visitor reset | Monotonic canonical reset revision plus rotated generation | Browser | Queued MessagePort dispatch after reset coordinator | Integration | planner-bridge.dom.test.ts |
| Disposal | Mounted host removed | Pending/client calls rejected, ports closed, subscription released | Disposed client cannot execute | Host lifecycle | Memory/port only; no DB | Browser | Capability lifetime | Integration | planner-bridge.dom.test.ts |

Authentication/tenancy/database dialects are N/A: this is a dedicated browser
capability over an already-mounted demo app, with no server data access. Actual
inference and lead consent remain website-owned. Production adoption still
requires an upstream release and coherent dependency adoption.

## Workflow-led coaching correction

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure | Actor/context | Executor/transaction | Runtime | Contract edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Initial coaching invites the person's goals | Actual successful initial app execution | Helpful real navigation plus one open-ended app question | No catalog-order or low-stock preference; no guidance for refused/no-op execution | Native/hosted external assistant | Existing actual command receipts; no new mutations | Browser/Node | Catalog remains data, not an automatic next-item agenda | Unit | assistant-coaching.test.ts |
| Followup avoids package cycling | Actual later workflow addition | Existing execution receipt remains authoritative | No automatic next-package question or repeated initial tutorial | Native/external assistant | Existing controller; N/A new transaction | Browser/Node | Reordered catalog cannot change deterministic coaching | Unit | assistant-coaching.test.ts |
| Recommendations follow expressed workflow | Shared browser/host prompt | Actual supplied recipe descriptions; necessary setup allowed | Invented capabilities still rejected; no unrelated catalog tour | User's stated need | Existing canonical command schemas/executor | Browser/Node | PromptCatalog and parseHostReply | Unit | assistant-coaching/core/prompt tests |

No auth/tenancy/dialect change: browser coaching/prompt copy only. Existing
sample/manual-record, revision-conflict and exact export behavior remain owned by
the existing executor and tests. Regression evidence is captured by running the
new coaching cases before production edits, then the same cases after.

## Mounted guide and planning entry

- `planner-guide.dom.test.ts`: actual mounted Edit/menu anchors, planning-mode
  chooser suppression without a chooser paint, deliberate cookbook navigation,
  default browse compatibility, reduced-motion/static highlighting, retained
  focus, Escape/dismiss/timeout/reset cleanup, and refused additions.
- `planner-bridge.dom.test.ts`: addition guidance accepts only the saved actual
  successful receipt; invented, replayed, and stale-generation requests fail.
  The strict envelope rejects unknown guide kinds and caller-supplied targets.
- Shell target tests verify scoped real-node registration/cleanup; AppShell
  tests verify registration on the actual layout control and menu links.

Final focused evidence: 13 guide/bridge tests passed; the preceding combined
coaching/native-concurrency/guide selection passed 22 tests. Shell selection:
15 tests passed. Planner typecheck: 0 errors, 0 warnings. The smrt-svelte package
was built twice: the second necessary build preserves dynamic highlight CSS
with Svelte's global attribute selector. Planner's final build follows that
owner build. Existing unrelated Svelte warnings were not changed. No full suite,
root lint, production package pins, provider requests, or deployments were run.

## Bounded spoken application receipt

| Behavior | Trigger | Positive | Negative | Actor/executor/runtime | Contract/test |
| --- | --- | --- | --- | --- | --- |
| Full receipt retained; literal speech bounded | Actual hosted command batch succeeds | Initial <=40 words, fictional records, real menu/record step, Edit purpose, open question | No arbitrary host prose in spokenContent; no truncation of full content | External assistant, same canonical atomic controller, browser/Node | assistant-coaching + real MessagePort bridge tests |
| Truthful additions and fallback | Actual later visible menu additions | Actual added item count and bounded section label | Long names use honest count/location, not clipped names or catalog guesses | Same executor; no new writes | assistant-coaching test |
| Optional field compatibility/idempotency | Port reply/retry/conflict/no-op | Exact retry keeps original full and spoken receipts | Failure/no changed command omits field; legacy callers still consume content | Existing generation/revision/cache authority | planner-bridge.dom test |

Regression: new budget/guidance test failed before implementation because the
canonical spoken receipt helper was absent (`/tmp/planner-spoken-before.log`).
The 400-token provider guard is unchanged; no inference/model summary is added.

## Spotlight presentation of existing guidance

| Invariant | Trigger / positive | Failure / negative | Actor / executor / runtime | Boundary / test |
| --- | --- | --- | --- | --- |
| Existing highlight API remains compatible | Two arguments retain outline marker and duration | Cleanup is idempotent; no leaked marker/timer | Browser mounted control, DOM-only/no data writes | smrt-ui control spotlight test |
| Actual semantic target gets a cutout | Existing guide selects Edit or actual successful addition | Missing/detached/offscreen target never dims unrelated page | Same guide/controller and scoped refs, browser | primitive geometry + mounted Planner tests |
| Geometry follows viewport | Scroll/resize/layout movement update clipped hole | Zero/offscreen bounds dismiss safely | Actual DOMRect, active RAF only | primitive test |
| Interaction remains usable | Passive veil and keyboard dismiss button | No focus steal, interception, navigation, or motion; reset/disposal clear | Existing guide owns lifetime/epoch/Escape; DOM-only | primitive + mounted tests |

No new RPC/controller/tour, no inference, DB, auth or tenancy boundary. Reuse the
contact veil's even-odd polygon paint mechanism through existing highlightControl
presentation, not its private business intro state. Regression tests run before
implementation, then narrow owning-package tests/typecheck and topological builds.

## Count-free section overview defaults

| Invariant | Trigger/positive | Negative/preservation | Executor/runtime | Test |
| --- | --- | --- | --- | --- |
| Actual mounted/static defaults have no record counts | Section blueprint shortcuts4 + latest4/summariesfalse; default loader omits total and count enrichment | Record detail pages and explicit custom metrics/record summaries remain available | Same Cookbook/Planner builder + browser DataSource, no persistence writes | shared builder + cookbook-overviews + mounted planner-section |
| Explicit legacy count edits survive | Read-time original count definition for stored changed.count (span/options/version) | Unrelated/order-only overrides never resurrect count; removed wins | Existing sparse override validation/apply, no migration/writes | shared section-defaults + Planner parse/controller tests |
| Full customization survives | Added metrics and custom records with summariestrue | Malformed options still rejected by existing schema | Existing validators/loaders | cookbook-overviews |

Mounted fail-before captured automatic shortcut counts against the actual old
CookbookApp path (`/tmp/planner-nocount-before.log`). Shared builder correction is
necessary: Planner-only blueprint edits would not affect its mounted CookbookApp.

## Existing themed cards as section defaults

| Invariant | Trigger/positive | Negative/preservation | Executor/runtime | Test |
| --- | --- | --- | --- | --- |
| Canonical section defaults select existing cards | Cookbook page/overview and static Planner overview omit presentation | Explicit plain remains available | Presentation prop only, browser/SSR; no data writes | CookbookApp + mounted Planner section tests |
| Existing theme owns visual styles | Card presentation uses current OverviewGrid/ShortcutsWidget token CSS unchanged | No new border/color overrides; count-free data and saved theme untouched | Existing theme/provider and count-free blueprint | existing card tests + actual themed UI QA |

Regression changes expected default presentation before production edits; only
three default prop values and descriptive docs change, no CSS or theme policy.


## Coordinated release validation (2026-10-20)

The shipping branch starts from released SMRT 0.57.11 (`879010e4d03f60e82cf59e47fbf6ed32dcb20fa4`),
retaining all intervening upstream changes. The earlier preparation results above are
historical evidence, not substitutes for the full current-tree shipping checks.

The seven #4141 matrices collectively cover the public native handle/export,
conversational host, sample context, guidance/starters, export presentation,
project-reset UI, and persistence contracts. The bridge, concise spoken receipt,
shared overview defaults/cards and primitive spotlight rows are included above.
All are browser-only contracts: SQL dialect, tenant ownership and database
transaction testing are N/A because these paths access no server data. Mutation
atomicity instead belongs to the canonical cookbook batch and browser Storage
rollback, with explicit stale/duplicate/partial-failure cases in those rows.

Shipping commands run with Node >=26 and pnpm 11.25.0 in an isolated worktree,
with a short writable TMPDIR. Every command retains full output outside the repository.
Nested pnpm invocations must use the same Node version; a workstation launcher with
a fixed older shebang does not establish the required runtime. Required checks:

- `pnpm install`, `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`,
  `pnpm format-check`, `pnpm knowledge:check --strict --format markdown`,
  `pnpm audit:policy`.
- Full touched-package suites are included in root `pnpm test`: Planner, chat,
  smrt-svelte (unit and published-entry conformance), and smrt-ui.
- `pnpm --filter @happyvertical/smrt-planner test:mcp-browser` and
  `pnpm --filter @happyvertical/smrt-planner test:live-preview-browser`.
- `pnpm --filter @happyvertical/smrt-chat test:e2e`,
  `pnpm --filter @happyvertical/smrt-svelte test:e2e`, and
  `pnpm --filter @happyvertical/smrt-ui test:e2e`.
- `pnpm --filter @happyvertical/smrt-chat test:postgres` against a dedicated
  disposable database; never a shared local instance.
- CI's publish dry run and canonical release tarball gate exercise package exports,
  browser hosts and real cookbook application before family publication.

The new public contracts cannot execute unchanged against the base because that
revision does not expose their modules, props or handles. For these additive APIs,
negative contract cases and absent-option compatibility are the regression evidence;
source-level fail-before results for existing bug fixes remain linked in the
individual matrices and preparation QA handoffs. Prompt-budget validation retains
its original threshold, and rejects the original longer workflow instruction; the
compact equivalent retains catalog grounding and excludes invented features and
automatic package tours, while allowing deliberate control guidance.


## Review follow-up: reset and operation ownership

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor/context | Executor/transaction | Runtime | Contract edge | Level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A stale model cannot borrow B’s abort controller | Start A, reset, start B, resolve A despite abort, resolve B | B retains busy/controller and completes normally | A applies no recipes/samples, appends no old reply and cannot clear B | Same browser visitor, independent generations | Captured per-operation controller and epoch; synchronous mutations only, SQL N/A | Browser transport / Vitest | Provider may ignore AbortSignal | Unit | native-host-concurrency.test.ts; existing Stop/cancel tests retained |
| Report continuations cannot resurrect reset state | Hold reports.define for a model report or question answer, reset, start B, release old definition | B stays busy and completes; current reports still work | No Reports recipe, obsolete answer/ref, pending question or old notification in fresh conversation | Current native visitor | Captured operation guard before post-await effects; SQL N/A | Browser / Vitest | Async report preview/hash boundary | Unit | assistant-reports.test.ts |
| Static page resets the actual visible transport | Seed native history, mount real Page and BrowserAssistant under AppShell, Settings → Reset → confirm, then fresh send | Visible history clears immediately and fresh session persists only current thread | Old in-memory text cannot return or be persisted by the next notification | Static-app browser visitor | Actual aiState.session.transport passed to existing PlannerControls reset; no duplicate controller | Svelte DOM / happy-dom | Static page composition, sessionStorage | DOM | browser-assistant-reset.dom.test.ts + static-reset.fixture.svelte |

Fail-before evidence: the three deferred transport/report regressions failed against
reviewed behavior with stale recipe/Reports mutations. The first static harness
attempt lacked AppShell context/import and was not bug evidence; after using the
actual AppShell composition, removing only the new nativeAssistant prop reproduced
the retained visible obsolete conversation. The same rendered regression passes
with the one-prop wiring. Focused after-fix coverage includes existing Stop behavior
and current-turn report/question outcomes; full Planner suite and relevant package
checks are rerun before the follow-up review. The first full-root pass remains base
coverage; no unrelated source or enforcement changes are part of this correction.
