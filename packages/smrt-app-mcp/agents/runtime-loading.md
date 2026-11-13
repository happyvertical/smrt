# HTTP transport loading

The `sveltekit` entry imports the MCP SDK and its protocol adapter at the existing
async request dispatch boundary. Task interception loads the same SDK classifier
and the same protocol extension constant only when a task envelope needs them.
Route construction, runtime-binding validation and `.server` remain synchronous;
public `createMcpProtocolServer` remains synchronous on its existing entry.
Origin/auth checks still precede dispatch and an SDK load failure still rejects
with its original cause at first use. No auth or task policy is duplicated.

The fresh-Node published-entry regression refuses SDK resolution, mounts the
route, proves a cross-origin denial still returns 403, then proves an eligible
request gets that exact SDK load error. It fails against the eager build. The
full package suite retains the SDK wire, effects, actor × tenant, binding,
extension, async Tasks and revision/header refusal tests (359 tests including the startup guard). Runtime: Node 26, existing SQLite/injected executors;
no persistence, transaction or dialect behavior changes.

Reuse inspection: MCP package review, intent index and searches for
`mountMcpAppRoute`, `createMcpHandler`, SDK imports, `maybeHandleTaskRequest` and
protocol request factories found these existing seams. Only their import timing
changes; no new production component, helper, model, route or type is added.
