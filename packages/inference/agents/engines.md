# Local assistant engines (`./server`)

Codex readiness also exercises its secured startup in a disposable empty HOME
and CODEX_HOME, without a token or provider credentials. The probe disables its
MCP connection, overrides the provider to non-listening `127.0.0.1:1` without
auth, strips proxy variables, and aborts at `turn.started` or a startup error.
No vendor model can be called. A native disabled-code-host startup error refuses
readiness as `tool_host_policy`; the turn parser also stops before publishing a
fallback answer if a caller skips readiness. Unknown startup errors fail closed.

Live Codex 0.162.1's default model needs its code host, but enabling that host
still registers `apply_patch` even with machine features disabled and strict
third-party mode. Keep the host disabled and report incompatibility. A verified
MCP-only execution host or upstream built-in-tool allow-list is required before
enabling this profile; do not substitute another model or billing path silently.

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
- `emit` receives text, tool_call, tool_result, approval_required,
  approval_decided, done and error events. `done.stop` is complete, waiting,
  aborted, timeout or error. Pending approvals return waiting; only the owner's
  independent UI/authority can approve. Host callback/storage failures propagate
  after process and token cleanup. CLI exit output is never forwarded.

## Security invariants

Allow-list child environment variables: no provider API keys, endpoint overrides
or host secrets. Token only in child environment, never argv, logs or config
files. MCP must use HTTP loopback (127.0.0.1, localhost or ::1). Built-in shell,
file, web and subagent tools are disabled; user config/hooks/plugins are ignored.
The working directory is private and empty. Stream guards reject foreign tools
and unknown Codex action kinds. Stop/timeout kills the process group (Windows
uses taskkill /T). CLI credentials are never read: query the CLI's own status
and run its own login command, which opens the vendor page itself.

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
