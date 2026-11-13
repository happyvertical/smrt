# Local assistant engines (`./server`)

## Codex containment (owner-authorized 2026-11-12 policy)

Codex 0.162.1 is usable. Enable **only `code_mode_host`** (when protection is on) in addition to the
existing modern MCP protocol feature. The host necessarily registers
`apply_patch`; shell/unified execution and all other optional machine features
stay disabled. Every Codex attempt (including resume/fallback) now gets a NEW
empty 0700 `<engine state>/run/turn-*/work` folder, removed in the existing
finally cleanup after completion, error, abort and timeout. Concurrent turns
never share it. User config/rules are ignored; project document bytes are zero
and bundled skills disabled. Schema/config files remain outside the writable
cwd and contain no credential.

Exact containment overrides: `sandbox_mode="workspace-write"`,
`sandbox_workspace_write.network_access=false`,
`sandbox_workspace_write.writable_roots=[]`,
`sandbox_workspace_write.exclude_slash_tmp=true`,
`sandbox_workspace_write.exclude_tmpdir_env_var=true`,
`approval_policy="never"`, `web_search="disabled"`,
`shell_environment_policy.inherit="none"`. No bypass, add-dir, full access or
terminal approval. Native sandbox policy controls writes/network, not parser
inspection after an effect. It permits reads according to platform policy; an
empty cwd is not a read-visibility jail. Provider and loopback MCP HTTP transports
run in the CLI parent; sandboxed model commands cannot use the network or inherit
the app's MCP token. API keys remain stripped from the CLI parent environment.

The secured spec opts `codexParser` into recognizing only `file_change` and
`command_execution` as confined built-ins. Record `agent_tool_confined` plus
fixed `apply_patch`/`exec_command` names, never their payload/path/output; continue
the app request. Unknown items, foreign MCP and unoffered app tools still stop
with W1's redacted name diagnostics. App mutations still require the existing
scoped MCP dispatcher and durable independent owner approval. Existing work
profiles, one-step classified fallback and child-group kill/timeout are retained.
Codex maximum effort maps to xhigh; explicit model remains `-m`.

Readiness exercises the exact invocation's help plus startup in a disposable
HOME/CODEX_HOME with no auth, token, proxy or reachable model endpoint; abort at
`turn.started`. Compatible 0.162.1 now passes; incompatible versions still return
plain `tool_host_policy` or invocation failure. This is a cheap local startup
preflight, not a billed inference test or proof of account entitlement.

Verified flags: installed `codex exec --help` 0.162.1 and
[OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
A separate native `codex sandbox -P smrt` control used a named profile with
`filesystem={"/"="read",":workspace_roots"="write"}` and
`network.enabled=false`: writing inside succeeded, a sibling write and connection
to a listening loopback HTTP socket were denied. This tests OS enforcement, not
a model response; the production exec uses the equivalent workspace overrides.

| Invariant / reachable trigger | Positive | Negative/control | Actor/context, executor/runtime | Edge / level / validation |
| --- | --- | --- | --- | --- |
| Private Codex attempts, including resume | Distinct empty 0700 roots, own-file writes disappear at cleanup | Failure/abort/timeout and concurrent runs cannot share cwd | Local owner, no DB executor; Node26 subprocess | CLI spec/stub; inference test |
| Confined incidental builtins | Patch/command item logs only fixed names, request finishes | Unknown item/foreign MCP/unoffered app tool still kills; token/arguments absent | Owner-bound app authority; OS sandbox independent of DB | Stream + full stub turn; inference test |
| Ready/startup | Native compatible CLI and stub with code host starts | Unsupported flags/host, missing runtime, signed-out, directory failure | Local process; no model request | Preflight; inference + exact desktop env tests |
| Ranked OpenAI choices/fallback | Strongest verified offered model, one lower on classified pre-output refusal, fixed wording/memo | Unknown IDs never guessed; no retry after text/tool, no engine/key fallback | Owner/account/catalog generation; existing preference store | Fake sign-in/catalog/model + host tests |
| Live app data / Stop | Live read/create via scoped MCP and Stop kills child; fixture held delete decided once | Customer delete remains absent; UI never decides through a model tool | Local owner/tenant, SQLite generated tools | Built product; docs/qa-live-engines.md |

Reuse: configured MCP reviewed inference/Svelte/template/app-shell and architecture
context queried disposable sandboxes, rank/fallback and connection composition.
Name + purpose `rg` in UI/Svelte/chat/core/inference found `buildAgentRun`,
`runProcess`, `codexParser`, `reportAgentFailure`, `strongestWorkModel`,
`runWorkModelWithFallback` and the existing connection catalog. Extend these
owning modules. New `rankOpenAIWorkModels`/`nextWorkModel` live in the existing
work-profiles module; no parallel engine, approval service or credential reader.

## Historical 2026-11-11 incompatibility evidence (superseded by containment above)

Native probes on the installed CLI use its default model, disposable empty
HOME/CODEX_HOME, a loopback fake Responses provider with auth disabled, and one
fixture MCP read tool. No provider credential, account request or real model
turn is used. The fake reply only enumerates the host's tool registry and, in
the MCP-call control, invokes that fixture read. No built-in file/shell tool is
executed. These are protocol facts, not a claim of complete OS sandbox testing.

Common invocation: `exec --json --skip-git-repo-check --ignore-user-config
--ignore-rules`, prompt on stdin, private empty cwd, `--enable mcp_2026_07_28`,
and `-c sandbox_mode="read-only" -c approval_policy="never"
-c web_search="disabled"`. The app server is loopback, `required=true`, with
`bearer_token_env_var` naming the existing environment variable; no token goes
in argv or files. `default_tools_approval_mode="approve"` refers only to MCP
transport: the server still owns permissions and independent owner holds.

Baseline `--disable` features: `shell_tool`, `unified_exec`, `apps`, `plugins`,
`hooks`, `multi_agent`, `multi_agent_v2`, `view_image`, `image_generation`,
`browser_use`, `computer_use`, `in_app_browser`, `memories`, `skill_search`,
`tool_suggest`, `goals`, `code_mode`, `code_mode_host`,
`request_permissions_tool`. Native `features list` in the disposable home also
reports `apply_patch_freeform` as **removed/false**, not an available kill switch.

| Option tried (changes from baseline only) | Native result | Capability/security consequence |
| --- | --- | --- |
| No change: code host disabled | MCP discovery/list succeeds, but its tool is absent from the model registry; native execution returns `code-mode host is disabled` | Current supported app policy: fail closed as `tool_host_policy`; no model turn is started by readiness. |
| Enable only `code_mode_host` | Registry contains `mcp__smrt__probe` **and `apply_patch`**; fixture `tools/call` succeeds with protocol 2026-07-28 | App MCP works, but the model retains a built-in filesystem-editing interface. Read-only sandbox and never-approve remain; this does not satisfy “built-ins absent”. Not enabled by SMRT. |
| Also enable `code_mode_only_strict_3p_tools` | Same MCP + `apply_patch` registry | The strict flag does not remove the built-in tool. Not enabled. |
| Also enable both `code_mode_only` and `code_mode_only_strict_3p_tools` | Same registry | Combining the strict flags still does not yield MCP-only tools. Not enabled. |
| Enable `code_mode_host` and `code_mode` | Same registry | Legacy code-mode flag does not remove `apply_patch`. Not enabled. |
| Enable `code_mode_host` and `shell_tool` (keep `unified_exec` disabled) | Also registers `exec_command` and `write_stdin` | Adds a model-visible shell interface. Read-only/never-approve are narrower than full access but are not an app-only capability boundary. Not enabled. |

The empty cwd is not a filesystem visibility jail. A read-only sandbox permits
inspection according to its platform policy; it does not prove that arbitrary
absolute paths outside the cwd are invisible. No write/network boundary bypass
was attempted, and no platform-wide enforcement guarantee is inferred from
registry enumeration. Provider/MCP transport access is separate from a spawned
command's network policy. See the official [sandbox contract](https://learn.chatgpt.com/docs/sandboxing)
and [CLI flags](https://learn.chatgpt.com/docs/cli/reference).

Owner choices are: retain this refusal and use a compatible engine; request an
upstream built-in-tool allow-list/MCP-only host; or explicitly review a broader
filesystem/shell policy in a separate change. This implementation adopts only
the first choice. Connect AI says “Not supported with this Codex version yet”
and explains the file-tool conflict. No model downgrade, API billing fallback,
code-host enable or sandbox weakening is implemented.

Codex's app MCP server is required: it waits for the live catalog within its
startup timeout instead of continuing after the optional-server grace period
with no app tools. A failed required MCP startup reports fixed app-connection
words and a correlated `agent_mcp_unavailable` diagnostic, never child output.
All machine-tool, user-settings, token and loopback restrictions remain intact.

The legacy `assistant token failed:` diagnostic remains for LocalRuntimeError
token failures, using a fixed class label and allow-listed code only. It follows
the correlated failure record; arbitrary error names/messages are never logged.

`src/agent-cli/` owns discovery, CLI-reported authentication, login processes,
locked-down subprocess invocation, parsing, the process-tree lifetime, MCP token
lifetime and a subprocess-owned turn. `src/chatgpt/model.ts` adapts one model
round; `src/engine-model.ts` defines its model seam. `src/engine-status.ts`
composes connection diagnostics without selecting a default engine.

These modules never import app-shell, smrt-chat, app-runtime, a web framework or
a host model. Keep all value exports on `./server`; root and `./models` stay
browser-safe. Plain product labels are metadata, not branded UI.

## Two host contracts

A chat-style host calls `createChatGPTModel({ connection, model?, toolNamespace,
settingsHref? })` then `EngineModel.complete({ messages, tools, maxTokens, signal,
onText })` for each round. It executes returned `toolCalls` through its own
policy, persists history and replays `raw` provider calls and tool responses.
Only `chat()` + `onProgress` reach the plan; token limits, sampling, reasoning,
response formats, user, forced tool choice and stream flags never do. The host
must bound total rounds/time/tokens. `EngineModelFailure` carries safe fixed
words and an optional host route; arbitrary provider errors need a generic
host error handler. Never expose/log an error's message, cause or SDK options.
There is no API-key fallback. Connection `clientOptions()` is the only credential
source; resolver selection remains explicit (`createChatGPTPlanResolver` with
`appliesTo` and host-verified principal). The SDK owns its credential file.

A subprocess host calls `runAgentTurn({ text, tool, mcpUrl, signal, emit, deps,
host })`. `tool` is `claude-code` or `codex`:

- `deps.locate`, `stateDir`, `baseEnv?`, `limits?` supply a discovered executable,
  private app-owned state directory, base environment and time/result bounds.
- `deps.credentials` supplies `mint`/`revoke`. `tokenCredentials(store,
  { holder, label, scopes })` adapts app-runtime's local MCP token store
  structurally, with no dependency on app-runtime. The host verifies the owner
  first, uses a distinct holder per concurrently active conversation, and
  scopes the token to its policy. Tokens expire after 15 minutes by default;
  custom turn bounds must stay below that or supply a longer-lived credential
  implementation. Never persist the returned secret.
- `host.appendMessage` and `lastSession` own authenticated storage/session
  continuity. `guidance()` returns the system guidance and current-turn prompt;
  it runs again if an expired CLI session must restart.
- `host.allowTool` is a stream guard. The authenticated MCP endpoint must also
  enforce the tool policy; stream inspection is no replacement for authorization.
- `host.approvals.subscribe/get` supplies only approvals belonging to this turn
  and owner. It is an observation interface, with no approval decision method.
  Correlation follows serial tool results in order; unrelated events must be
  filtered by the host. `describeResult` supplies UI words and optional host
  metadata (`details`, also persisted on the tool message); `completionNote?`
  supplies a closing note for host-specific state such as drafts.

The host publishes canonical pending holds before returning a tool response.
A fast independent decision may already be approved/denied when inference reads
it; it remains a held call and emits the existing approval event, never an
ordinary successful result that bypasses chat's protected-result guard. Both CLI
fixtures cover pending, early-approved and early-denied correlation. Model output
does not supply approval identity or authority.
- `emit` receives text, tool_call, tool_result, approval_required,
  approval_decided, done and error events. `done.stop` is complete, waiting,
  aborted, timeout or error. Pending approvals return waiting; only the owner's
  independent UI/authority can approve. Host callback/storage failures propagate
  after process and token cleanup. CLI exit output is never forwarded.

## Security invariants

Allow-list child environment variables: no provider API keys, endpoint overrides
or host secrets. Token only in child environment, never argv, logs or config
files. MCP must use HTTP loopback (127.0.0.1, localhost or ::1). Claude built-ins
are absent. Codex enables only its necessary code host and confines its patch
capability as specified above; shell, web and subagent features stay disabled.
User config/hooks/plugins are ignored. Codex workspaces are private, empty and
new per attempt. Stream guards reject foreign tools
and unknown Codex action kinds. Stop/timeout kills the process group (Windows
uses taskkill /T). CLI credentials are never read: query the CLI's own status
and run its own login command, which opens the vendor page itself.

Claude's `StructuredOutput` is accepted only when the host supplies
`outputSchema` (and thus `--json-schema`). It is a result channel: its call
and correlated result never become executable app tools or tool messages;
only the final `structured_output` is published, with intermediate prose
suppressed. Without a host schema it remains forbidden. All CLI lockdown
flags stay intact. Blocked tools report a bounded ASCII name (unsafe names
become `unknown`) and `builtin`, `unoffered_mcp`, or `unknown_item` in the
correlated guard diagnostic and safe error message, never their arguments.

Native continuation proof (2026-11-12 UTC): a fresh built product chat request
escalated before `app.addField` executed, then completed all three v2 design
passes with the exact core-owned proposal (`Members`, `Visit note`, text,
`expectedRevision: 1`). Each requested `fable` / maximum effort and reported
`claude-fable-5-1`; provider-reported effort was unavailable. Pass duration,
tokens and app-tool calls were respectively 26783 ms / 53618 / 1,
28841 ms / 54889 / 1, and 26331 ms / 56277 / 1. All three accepted the native
`StructuredOutput` channel; no schema repair or write occurred. The identical
schema-enabled formatter event is forbidden by the base parser and accepted
as a non-executable result channel by this parser. Without a host schema it
remains forbidden. The earlier v1 proof completed its passes but could not
prepare a supported operation because write schemas were absent; v2 supplies
their metadata while retaining read-only execution. This proves proposal
completion, not final Apply, which requires the trusted durable host action seam.

Do not offer in-app Claude subscription login or proxy/store its credentials.
The person uses their own unmodified Claude Code CLI and its vendor login.
ChatGPT plan sign-in is a separate, opt-in preview for local open-source apps;
keep its published limitations visible to users.

## Diagnostics and tests

`createAgentCliService()` creates a host-local 15-second detection cache and
login manager. `inferenceEngineStatus(engine, host)` asks only the selected
engine: host `apiStatus`, connection `status`, or CLI `cliStatus`. Host `actions`
provide navigation; inference has no hard-coded application routes.

`agent-cli/{detect,session,turn}.test.ts`, `engine-status.test.ts` and
`chatgpt/{model,support}.test.ts` use stub executables/fake providers only.
They cover missing/signed-out/unknown status, cache isolation, key stripping,
secret-free args/config/events/messages/logs, loopback rejection, built-in tool
lockdown, fail-closed guards, session continuity, tree death on abort/timeout,
token cleanup, model option restrictions, raw call replay and classified errors.
App-shell keeps integration tests for its real MCP owner policy, approvals,
drafts, guidance, persistence, sign-in resolver selection and settings routes.

Run package build/test/typecheck as documented in AGENTS.md. No live CLI or
provider account is needed. PostgreSQL tests remain optional and unrelated to
these Node subprocess/model adapters.

## Reuse audit for the C2 extraction

Audited against base `06c0b64fe3`, including every added source file and its
exported types, helpers and constants. C2 adds no component, model, route or
MCP tool definition. CLI product/tool metadata and stream/model/host contracts
are the API introduced by moving existing shell behavior to its owning package.

Discovery used the configured **smrt-dev-mcp** server's
`review_smrt_project({ directory, detectDuplicates: true,
includeSourceEvidence: true })` on inference and app-shell, and
`build_context({ task: 'architecture', idea, rootDir })` for these purpose
queries: "local Claude Code/Codex CLI detection login sanitized environment
process tree MCP token invocation stream parser"; "ChatGPT plan model adapter
model round connection diagnostics authorization browser owner approval
observation fake CLI fixtures". `build_package_specialist_context` for inference
checked the proposed shared test entry. This server exposes architecture lookup
and manifest object lists; it has no standalone component/intent/recipe search
tool. The intent index and local source/catalog searches fill that gap.

Read `docs/knowledge/intents/index.md`, especially local credentials, prompts/AI,
auth and human approvals. Run name and purpose searches with `rg -n` over
`packages/{smrt-ui,smrt-svelte,chat,core,inference,app-runtime,smrt-app-mcp,cli,agents}`,
then repository-wide production-source searches. Also inspect
`smrt-desktop/src/bundler/{runtime,child-env}.ts`, `planner/src/lib/assistant/models.ts`,
`vitest/src/{index,test-db}.ts`, and the recipe/component knowledge catalogs.
The exact source audit is below; internal parsing/lookup helpers belong to the
same protocol implementation as their exported entry points.

| New source file (under `src/`) | Names/purpose searched | Existing capability reused or reason to retain |
| --- | --- | --- |
| `agent-cli/credentials.ts` | `AgentCredentials`, `McpTokenStoreLike`, `tokenCredentials`, `AGENT_TOKEN_TTL_SECONDS`; owner token mint/revoke/holder | Adapts app-runtime's existing `LocalMcpTokenStore.issue/revokeHolder`. No credential store added; structural interface prevents an inference-to-runtime dependency. |
| `agent-cli/detect.ts` | `AgentCliStatus`, `AgentCliLocation`, `cliEnv`, `locateCli`, `detectAgentCli(s)`, `versionOf`, `signedInFrom`; version/status parsing | Moves shell's existing CLI command-based discovery. Inference doctor probes provider endpoints, not installed CLI sessions. No equivalent in core/chat/UI/agents. |
| `agent-cli/env.ts` | `childEnv`, `nodeDir`, `allowed`; provider-key stripping, allow-list child environment | Desktop `buildChildEnv` forces build locale/npm policy, rejects MCP-token extras and omits CLI sign-in location variables. Its build-process contract is unsuitable; retain the existing shell CLI-specific allow-list. |
| `agent-cli/locate.ts` | `LocateDeps`, `defaultLocateDeps`, `candidateDirs`, `locateBinary`, `isExecutable`, `listDirs`, `names`, `findIn`, `viaLoginShell`; executable/PATH/login-shell lookup | Existing CLI/desktop runtime launchers run known binaries; none locate the owner's agent CLI in user install directories without credential reads. Moves shell's lookup and its private filesystem/name helpers. |
| `agent-cli/login.ts` | `AgentLogin`, `LoginSnapshot`, `LoginState`, `Running`, `LOGIN_TIMEOUT_MS`; vendor-owned CLI login | Reuses the CLI's own login/status commands, not a new auth/session store. app-runtime owner setup and users' browser sessions are different identities. |
| `agent-cli/runner.ts` | `RunOptions`, `RunResult`, `CollectResult`, `runProcess`, `runCollect`, `killTree`, `killNow`, `hookExit`; bounded stdin/stdout/stderr, process-group cleanup | Desktop bundler process tracking and ingestion extraction are private, different lifetime contracts. No public reusable runner supplies this stream/stdin/abort/timeout/redaction contract. Preserve the shell runner and private kill/exit hooks. |
| `agent-cli/service.ts` | `createAgentCliService`, `configureAgentCli`, `invalidateCliStatus`, `agentLogin`, `cliStatus`, `allCliStatus`, private `deps`; host-local detection cache/login lifecycle | Composes the moved detector/login manager; no existing CLI status cache. Inference settings cache stores settings, not installed CLI authentication. |
| `agent-cli/session.ts` | `AgentRunSpec`, `SpecInput`, `TOKEN_ENV`, `assertLoopbackUrl`, `buildAgentRun`, `toml`, `claudeSpec`, `codexSpec`; MCP-only Claude/Codex invocation | Moves shell's locked-down CLI protocol. MCP auth's private `validateUrl` permits HTTPS and forbids query scopes; desktop route grammar is path-only. Neither replaces this HTTP-loopback URL guard. Private TOML/spec helpers encode vendor-specific flags. |
| `agent-cli/stream.ts` | `AgentEvent`, `MCP_SERVER_NAME`, `shellToolName`, `claudeParser`, `codexParser`, `obj`, `str`, `parse`, `textOfContent`; fail-closed CLI event normalization | Chat's model/tool-loop progress does not parse vendor subprocess JSON. Preserve the shell protocol parsers and their internal JSON/text helpers. |
| `agent-cli/tools.ts` | `AgentTool`, `AgentToolInfo`, `AGENT_TOOLS`, `AGENT_TOOL_INFO`, `isAgentTool`; CLI product metadata | Moves the existing shell metadata; no new application tools. Core recipe/cookbook model metadata describes a different noun. |
| `agent-cli/turn.ts` | `AgentTurnStop/Event/Limits/Message/Options/Host`, `AgentEngineDeps`, `runAgentTurn`, `tokenFailureMessage`, `tokenFailureCode`, `cut`; result cutting | Moves shell turn behavior behind host callbacks. Chat `runAssistantTurn` owns a provider tool loop and persistence; importing it would violate layering. Approval observation delegates to host authority. Chat's private truncator uses a different output marker. Shell wire types now reuse these shared event/stop types. |
| `chatgpt/model.ts` | `ChatGPTModelOptions`, `createChatGPTModel`; plan-only model round | Reuses existing `ChatGPTPlanConnection.clientOptions`, SDK `getAI().chat` and failure classifier. Connection/resolver do not adapt model rounds; doctor is diagnostics. No alternate provider/login implementation added. |
| `chatgpt/support.ts` | `browserCommand`, `SpawnLike`, `openSystemBrowser`, `ChatGPTFailureNote`, `chatgptFailureNote`; authorization opener/failure words | Reuses `isChatGPTAuthorizationUrl` and `classifyChatGPTPlanFailure`. CLI `createBrowserOpener/openInBrowser` accepts arbitrary URLs, has no result contract/Windows quoting guard and depends on inference (cycle). Keep this specialized wrapper and fixed failure vocabulary. |
| `engine-model.ts` | `EngineModelToolCall/Request/Reply/Failure`, `EngineModel`, `engineModelReply`; model-round seam | Reuses SDK `AIMessage`, `AITool`, `AIToolCall`. Core `InferenceModelClient.message` is text-only; cookbook `EngineModel` is schema metadata; planner `AssistantModel` is WebLLM catalog data; chat's error type lacks action links and cannot be imported here. Flattened calls/raw replay require this seam. |
| `engine-status.ts` | `InferenceEngineId/Action/Status/StatusHost`, `cliTool`, `engineLabel`, `cliEngineStatus`, `chatgptEngineStatus`, `inferenceEngineStatus` | Composes existing connection status, moved CLI detection and host API diagnostics. Shell `AssistantEngineId/AssistantStatus` now alias these canonical types instead of repeating their shapes. No equivalent engine-choice dispatcher exists. smrt-ui `PageHeaderCrumb` is page ancestry and `ToastAction` executes a callback; neither is a framework-free engine remediation link contract. |
| `agent-cli/test-support.ts` | `tempDir`, `installStub`, `installFakeCli`, `fakeDeps`, `exists`; isolated CLI fixtures | Removed the parallel shell implementation. Shell re-exports inference's `./test-support` entry. smrt-vitest supplies databases/manifests, not CLI fixtures; smrt-ui test support supplies DOM/a11y. Reuse the existing Vite custom-entry mechanism and `?raw` asset loader, keeping the fixture usable from a built package. |
| `agent-cli/test-fixtures/stub-cli.mjs` | `start`, `say`, `mcpUrl`, `callTool`, `sessionOf`, `sibling`, `out`; CLI JSON protocol fakes, local tool calls, resume/dump/hang/failure scenarios | Deleted shell's duplicate fixture; one inference-owned fake serves both packages. This is test data, never a production engine or provider. |

Added `credentials.test.ts`, `turn.test.ts`, `chatgpt/model.test.ts` and
`engine-status.test.ts` exercise these contracts with test-local in-memory hosts,
spies and fake endpoints. Moved `detect.test.ts`, `session.test.ts` and
`chatgpt/support.test.ts` retain the original shell assertions. Their local
`setup`, `threadHost`, `turn`, `runOn`, `textOf`, `waitFor`, `alive`, request and
provider-factory setup/drive/assertion functions are test scenarios, not additional public
capabilities. Existing shell adapter and DOM tests remain in place.

The MCP reviews raised only existing hosted flag detection, existing shell
approval/polling code and a downstream-UI heuristic for inference. None is a
copy introduced by C2: inference remains framework-agnostic, and owner approval
authority stays with the host. This audit does not replace that authority.

## Live desktop regression design (R7/R8)

| Behavior | Trigger / positive | Failure control | Actor / executor | Boundary / validation |
| --- | --- | --- | --- | --- |
| Process readiness | CLI help with locked invocation, own auth status, private writable cwd | Missing runtime/flags, signed-out CLI, inaccessible directory; no model request | Local owner; no database effect | Exact desktop environment + inference stub tests |
| Failure diagnostics | Start/stream failure logs reference, phase, fixed cause and code location | Credential-shaped message/output never logged | Server only; existing turn cleanup | Inference/chat tests and built-app log |
| Single failure | Failed turn restores draft and offers one retry | No duplicate banner, stored fallback or composer alert | Authenticated thread; ChatService | Dock component regression |
| Live effects | Both CLIs read lists and create a named member | Delete held until independent owner decision, replay refused, abort kills tree | Original owner/tenant; existing MCP dispatcher and durable authority | Built app, fresh SQLite; docs/qa-live-engines.md in product |

Reuse search: MCP reviews of inference, chat, desktop, Svelte and template host;
intent index; `rg` name/purpose searches for preflight, engine diagnostics,
reference/error IDs, environment helpers and retry presentation in owning
packages, core, smrt-ui and smrt-svelte. Extend existing detection, turn error
boundary and dock instead of adding a second engine or error presentation.

## Owner work profiles

`work-profiles.ts` exports browser-safe `recommendedWorkProfile` and
`resolveWorkProfile`: `assist` defaults to high effort, `design` to maximum,
`background` to low. Design/assist API calls resolve to `best`; the host must
apply the selected tier to its existing inference client. Owner settings may
select engine/model/effort and each numeric budget, pass/repair counts,
automatic escalation and preview. These settings carry no tool authority.
The preferences package stores owner overrides; inference contains no storage.

Claude recommendations select the strongest installed alias, `fable`, then
`opus`, then `sonnet`; hosts can supply the installed alias inventory. Codex recommendations use the reviewed OpenAI model table. ChatGPT automatic
recommendations intersect that table with the signed-in account's live catalog.
`rankOpenAIWorkModels` annotates exact IDs only, preserving a future SDK's explicit
finite `intelligenceRank`; `strongestWorkModel` never infers strength from response
order or spelling. Reviewed 2026-11-12 against
[OpenAI's recommended models](https://learn.chatgpt.com/docs/models#recommended-models):
Astra, 6.1 Sol, 6.1 Terra, Luna. This is versioned app recommendation data grounded
in official descriptions, not an undocumented server quality field. Unknown IDs
remain selectable explicitly but never become automatic recommendations. Refresh
this table when the catalog adds a new model; an unknown-only catalog truthfully
has no automatic strongest choice. Both design and assist pick the strongest
ranked offered model. Background keeps its low-effort profile.

`ChatGPTPlanConnection.models()` retains ranks and its ten-minute account cache;
`defaultModel()` uses ranks. `createChatGPTModel` discovers the catalog when needed
and derives a single next-lower fallback from it. Host memos include account
connection generation, catalog and owner preference revision. Fixed fallback
wording is sent through existing text progress. The installed SDK still rejects
reasoning/format controls on plan requests; omit them, retain requested effort in
metadata, and never claim vendor enforcement. Live sign-in/entitlement/inference
requires the owner and is not proven by fake catalog tests.

The browser-safe root exports the same `engineLabel` used by server status;
product names come from the existing pure CLI metadata. No server-status graph
is imported by settings. `ResolvedWorkProfile.modelSelection` is derived display
evidence: `strongest` requires the recommended Claude `fable` alias or the
selected top-ranked catalog entry; an explicit model is `custom`, and an
unverified/provider selection is `configured`. Tier names alone do not establish
model strength. The metadata includes requested and resolved selection ids when
known; these are selection aliases, not a claimed provider-reported model.

`runAgentTurn({ profile, outputSchema })` supplies explicit model and effort,
Claude `--json-schema`, or Codex `--output-schema` through a private per-pass
file. Codex maximum maps to `model_reasoning_effort="xhigh"`. Existing machine
feature prohibitions and parser guards remain in force, including unknown
structured-output tool kinds: they are refused, never allowed as built-in tools.
Claude's final `structured_output` object is serialized for the host's schema
validator. A host still validates and bounds repair attempts through the design
run driver. ChatGPT's SDK rejects reasoning and JSON format controls, so its
adapter omits those unsupported controls; schema validation/repair stays host
side. Recorded effort is the requested policy where the provider cannot honor
an effort option; it is not a claim of vendor enforcement.

Token mint receives the pass timeout; `tokenCredentials` requests a lifetime
of at least that timeout plus one minute, retaining owner holder/scopes and
revocation at exit. CLI usage is recorded only when input/output token counts
are reported, otherwise unknown. `host.recordExecution` and stored assistant
`meta.workRun` (when a CLI session exists) carry profile, runtime-reported model (unknown when omitted),
requested alias/model, duration, tool count and
fallback. `createChatGPTModel` accepts the same profile and execution callback.

Both real invocation adapters wire `runWorkModelWithFallback` when a host
supplies a scoped fallback store and the next verified model. Only explicit
plan-model refusal codes qualify; arbitrary failures, policy refusals, quota,
network errors, published text or any tool activity never retry another model.
One fallback step is allowed, with shared fixed wording. The host persists the
memo under owner, engine, refused requested model and a connection/catalog key;
change the key after account/catalog or selection changes. No engine or billing
path fallback is performed. No live CLI/provider call is needed for tests.

For Settings, pass a freshly resolved profile through
`projectWorkModelSelection` with that same tenant-scoped store, owner, engine,
requested model and connection key. A remembered different model changes only
display metadata to `fallback`; `profile.model` remains the original request so
execution reads the same memo and cannot begin a fallback-of-fallback chain.
The projector only reads the existing memo: it performs no provider probe,
notification or write and exposes no connection key in the result. Hosts must
share their key derivation between display and execution, invalidating it after
connection/selection changes. The existing profile and browser-safety tests cover
selection evidence, scope, model immutability and the public label import.

Reuse audit: smrt-dev-mcp `review_smrt_project` on inference and
`build_context(task: architecture)` inventoried package exports/models. The
intent index and name/purpose searches across smrt-ui, smrt-svelte, chat, core
and inference found no existing work-intelligence resolver or owner-engine
fallback memo. `work-profiles.ts` owns that pure inference policy and reuses
`InferenceEngineId` moved unchanged to browser-safe `engine-id.ts`; existing session/turn/credentials/model adapters own all
execution. No UI helper, credential store, queue or approval system was added.

Native CLI budget enforcement is limited to the subprocess wall deadline and
observed tool-result truncation for display/history. The vendor has already
received the MCP result by then: this is not a model-context result bound.
Resource pages are bounded before context entry; generic MCP observations still
need a safe serializer with a minimum envelope preserving outcome, approvals and
cursors without inviting mutation retries. Claude's installed help has no per-call token or
step limit flag; Codex is contained by its native sandbox. Numeric
step/token settings remain host/driver admission and accounting budgets, not a
claim that a vendor CLI stops at those token counts. Hosts must reserve a
conservative allowance before a CLI pass when native usage is unknown and
must not count unknown usage as zero. The driver pauses future passes at run
exhaustion; a request already admitted may exceed a token estimate. Claude
aggregate usage includes cache reads/creation as well as uncached input/output;
Codex cached input is already part of input_tokens and is not counted twice.

A sessionless CLI pass records execution through `host.recordExecution`; its
message has no session metadata. Existing hosts retain the original tool/session
message union without fabricated session IDs.

## Per-app local CLI protection (S1 owner setting)

Integration hold: protection-off is a tested local prototype pending an owner boundary decision. App-tool approval gates remain enforced, but unrestricted native commands can edit the app's database files directly. The current implementation does not provide an always-enforced raw-file deletion guarantee. Either scope that guarantee to app tools with an explicit warning, or retain app-data isolation through an OS confinement design before integrating this mode.

`AgentTurnOptions.protection` defaults to true; omitted means the containment documented above, unchanged. Only the verified owner settings route may persist false, after an explicit command/file risk confirmation. This is not an MCP/tool argument.

| Protection | Claude Code | Codex |
| --- | --- | --- |
| On (default) | Native tools absent; personal settings/plugins ignored | Required MCP/code host only; incidental built-ins confined to the private per-turn working folder |
| Off (owner confirmation) | Native shell/files/network and personal settings/plugins allowed; MCP bearer readable/exfiltratable by shell | Native tools and personal config/plugins allowed under the owner's OS authority; full-access sandbox |

With protection **off**, both engines start in persistent `<engine state>/work` (not the project/source tree). Claude Code 2.1.319 uses `--permission-mode bypassPermissions --permission-prompts none`: native operations run without a terminal prompt. Omit `--tools ""`, `--allowedTools`, `--strict-mcp-config`, `--setting-sources ""`, `--disable-slash-commands` and `--no-chrome` so the person's normal tools/config/plugins are available. The app's private `--mcp-config` still supplies its scoped endpoint by environment reference. The cookbook host sets engine state to the app data root, so its exact cwd is `<app data>/work`; protected Codex uses `<app data>/run/turn-*/work`. Other hosts may supply a dedicated engine-state subdirectory.

**Unprotected Claude token exposure:** the turn's app MCP bearer token is injected into the CLI environment (`SMRT_SHELL_MCP_TOKEN`). With shell access, the model can read that environment and exfiltrate the token over its native network tools. Output redaction protects the displayed/persisted answer only; it cannot prevent reading or exfiltration. This mode does not claim credential isolation. The owner must decide whether this switch ships.

The cookbook host mints only the offered tool slugs intersected with the turn's permission ceiling ([host binding](../../template-sveltekit/host/server.ts)); verification further intersects with the owner's live grants and requires active owner identity ([token store](../../app-runtime/src/local-mcp-tokens.ts)). The bearer can invoke those app reads/writes as that owner while valid, subject to live tool exposure and the same server approval checks; it cannot decide approvals or change owner-only safety settings. A stolen bearer is not cryptographically tied to its child process. Its intended MCP destination is HTTP loopback only ([URL validation](../src/agent-cli/session.ts)); that destination restriction does not prevent the unprotected shell sending the credential elsewhere. Expiry is fixed at `max(15 minutes, requested turn timeout + 60 seconds)` ([credentials](../src/agent-cli/credentials.ts)), not a sliding login. The turn revokes its holder on completion, error, Stop or timeout in `runAgentTurn`'s `finally`; revocation is best effort, so expiry remains the backstop. No token value appears in these docs.

Codex 0.162.1 off uses `sandbox_mode="danger-full-access"`, `approval_policy="never"`, `web_search="live"`; it omits the optional-feature disable list, `--ignore-user-config`, `--ignore-rules` and protected workspace overrides. This explicitly permits commands, files and network under the person's OS authority and own CLI config/plugins. Modern MCP and `code_mode_host` remain enabled for app tools. `shell_environment_policy.inherit="none"` remains forced in BOTH states: model shell commands do not inherit the app credential. Protection on retains the fresh 0700 per-attempt folder and cleanup. These flags were checked against installed `claude --help` and `codex exec --help`, not inferred.

Always: strip API-key environment variables, loopback-only MCP, short-lived owner-bound token in child environment (never argv/config/logs), app tool allow-list, owner deletion policy, Stop/timeout process-group kill and credential revocation. Off-mode native events record only sanitized tool names (`agent_tool_native`), not input/output; they do not fail an otherwise valid app request. Other app MCP tools remain fail-closed. Off-mode answers buffer to a message/tool boundary and reuse `redactInferenceSecret` to prevent split credential echoes reaching UI/history. Work-profile model/effort and classified one-step fallback are unchanged. Status/preflight caches are separated by protection mode.

Stub command specs, stream turns and credential-echo tests cover both modes. The shared ChatGPT connection accepts an optional SDK `begin().cancel` handle; without it, cancellation is explicitly unavailable and pending status remains truthful. Late/expired successful callbacks are signed out instead of silently reconnecting. SDK listener/state/timeout fixes belong upstream.

S1 live proof used the built `s1-settings` product with the desktop sidecar environment and four harmless turns, one engine/state pair each. Claude on refused shell access (zero tool calls); Claude off used Bash for `date +%F`. Codex on reported shell unavailable; Codex off used exec_command for the same harmless date command. Product `docs/qa-live-engines.md` carries the exact prompts, requested/reported models and final validation. These checks do not exercise ChatGPT sign-in or chat; its SDK event-stream fix remains unreleased.

ChatGPT failure diagnostics (V2): `reportAgentFailure('chatgpt', ...)` follows bounded own-data `cause` wrappers and records only allow-listed provider codes plus a bounded `req_` or UUID request id. It never logs error messages, account fields, response bodies, tokens or arbitrary metadata. The wire error remains the existing safe message; the correlated server reference identifies the cause. Tests exercise direct and wrapped SDK failures and rejection of secret-bearing message/account fields.
