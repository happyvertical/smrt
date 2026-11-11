# Local assistant engines (`./server`)

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
