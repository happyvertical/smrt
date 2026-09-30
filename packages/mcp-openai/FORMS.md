# Optional extended forms and resource selection

`@happyvertical/smrt-mcp-openai/forms` validates the bounded OpenAI wire profile.
`/forms/view` renders a functional application form without host capabilities.
`/forms/server` composes that input with the existing durable MCP workflow.
No form answer supplies identity, file permission, or domain approval.

## Pinned contract and native limitation

Wire source: OpenAI mcp-extensions
[e314720a0daac326217d1f123fcf51647868fa9f](https://github.com/openai/mcp-extensions/tree/e314720a0daac326217d1f123fcf51647868fa9f/typescript/src/server/forms):
full `fields.ts`, `file-picker.ts`, `schema.ts`, and `elicitation.ts` were inspected.
The repository supplies TypeScript/Zod source, not a generated JSON schema artifact.
Official [MCP guidance](https://developers.openai.com/plugins/build/mcp-server)
requires server-side authorization and says elicitation collects information,
not credentials or authentication bypasses.

The pinned extension advertises `extensions['openai/elicitation'].form` and calls
`openai/elicitation/create`. SMRT's scoped `@modelcontextprotocol/server` 2.0.0,
protocol 2026-07-28, has a public `InputRequest` union of `CreateMessageRequest |
ListRootsRequest | ElicitRequest`. `inputRequired.elicit` emits only
`elicitation/create`; `ServerContext.mcpReq.elicitInput` explicitly throws on
2026-07-28. The public MRTR union does not include the OpenAI method. The upstream
helper uses monolithic SDK v1 and is not an acceptable substitute. Therefore
`openAiFormSupport` returns `native:false` even with a present host capability,
with `sdk-mrtr-unsupported`. Absent and unknown capabilities also select the
functional application-form fallback. No OpenAI extension capability is
advertised, no callback is kept alive, and the stateless mount is unchanged.
Actual OpenAI host support is unverified and remains the M8 acceptance gate.

## Bounded wire profile

Supported fields cover boolean, number/integer, string, titled/legacy single
select, titled/untitled multi-select, string arrays, suggestions, thumbnail/preview
metadata, and file/resource picker strings or arrays. Replies are exactly
`{action:'accept',content:{...}}`, `{action:'cancel'}`, or `{action:'decline'}`.
The parser rejects unknown fields instead of stripping semantic instructions.
Limits: 64 fields/options/selections, 4096-character values, 256-character resource
names, 2048-character URIs, 65536-byte inert JSON budget, depth 16. Numeric bounds
must be finite; integer answers must be safe integers. Required/enum/default and
resource-selection rules are checked without coercion or inserted defaults.

Deliberate stricter safety profile: arbitrary regex `pattern` is rejected rather
than evaluated; prototype-sensitive names and accessors are rejected; images
must be HTTPS without credentials or bounded raster data URIs. The fallback
renderer does not fetch images. Resources must use opaque absolute URIs;
`file:`, `data:`, and `javascript:` are rejected, and a remote application cannot
interpret a desktop path. The owning grant provider must authorize every selected
URI, including offered options and implicit/user-supplied selections. Selection
is input only. Unknown resource metadata does not become permission.

## Durable application integration

Inside the existing task runner, call `continueOpenAiForm` with a server-owned
`McpWorkflowContinuation` (`recordId`, immutable `revision`, unique `inputKey`,
HTTPS or loopback `reviewUrl`), schema, fresh `authorizeApply`, and `applyInput`.
Forms containing pickers also require `authorizeResource`. The task must already
have the exact same continuation binding. M5 persists its owner and active tenant,
checks live task authority at start/resume, and uses one job row for suspension,
first-response CAS, cancellation, and execution. No new approval store exists.

The authenticated application form reads the descriptor through
`createMcpContinuationTool` or its actor/tenant-bound `McpTaskStore`, renders it
with `renderOpenAiForm`, then calls `submitOpenAiForm` on its server. Supply that
verified actor's tenant-bound store and a policy callback which resolves fresh
application authority. Never derive either from submitted form values. Submit
validates the stored schema, a canonical SHA-256 schema fingerprint, and exact binding before persisting a bound reply;
the worker validates again, checks selected resource grants, then reauthorizes both application access and active task ownership after asynchronous checks
before `applyInput`. Direct `tasks/update` cannot bypass worker validation.

A submitted reply is not a completed operation. Concurrent replies use the
existing store's first-response-wins CAS; stale/cancelled/consumed requests fail
closed. Poll the task for its authoritative result. Worker restart replays the
handler, so all code before suspension must be read-only or use the existing
owning action/runOnce idempotency API. Remote jobs use `maxAttempts:1`; unknown
external outcomes fail for manual reconciliation, not automatic replay.
`applyInput` must enforce domain review and immutable revision in its owning
transaction, and external access must recheck applicable authority at its own
boundary. Iolaus retains its dedicated human review page and no employer
transmission occurs in fixtures. Accepting a form does not approve an application.

Run package build, typecheck, test, test:forms:e2e and verify:forms:pack. See
[FORMS-TEST-DESIGN.md](FORMS-TEST-DESIGN.md) for the evidence contract. Tests use
synthetic data only; PostgreSQL authority tests use `SMRT_TEST_POSTGRES_URL`.
