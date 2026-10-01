# M6d form and resource-selection validation contract

Refs #3216. Risk: high — asynchronous authorization and approval integrity.
Source of wire truth: OpenAI mcp-extensions e314720a0daac326217d1f123fcf51647868fa9f,
full server/forms/{schema,fields,file-picker,elicitation}.ts. No generated JSON schema artifact.

| Behavior / reachable trigger | Positive | Negative / failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Test level / command |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Form declaration before suspension | Primitive, select, array, resource variants | Unknown/oversized/accessor/prototype/schema injection, invalid defaults | Server-owned declaration | N/A: pure validation | Node/browser | Pinned complete schema unions, explicitly narrowed safety profile | Unit / pnpm --filter @happyvertical/smrt-mcp-openai test |
| Form reply before use | Exact accept content, cancel, decline | Missing/unknown fields, wrong type/options/resource, oversized content | Untrusted host/app reply | N/A: validation precedes authoritative handler | Node/browser | Exact reply union | Unit / same |
| Durable form continuation | Owner+tenant+record/revision/input key survive restart | Wrong owner/tenant/request/revision, duplicate/concurrent/cancelled reply | Verified application actor, active tenant | Existing McpTaskStore job row and CAS; no new store | SQLite/PostgreSQL | Existing M5 continuation | Integration / same with SMRT_TEST_POSTGRES_URL for PostgreSQL |
| Live authority and application apply | Fresh authorization at start/resume/apply | Revocation before/after reply, callback failure, unknown external outcome | Verified actor × ownership × tenant | Existing TaskRunner, maxAttempts=1, owning handler transaction | SQLite/PostgreSQL | M5 authority callback; form answer never approval | Integration / same |
| Capability/native transport decision | Explicit usable application form fallback | Absent/unknown capability, unsupported SDK path, upstream failure | Synthetic SDK client | Same authoritative workflow | SDK v2 HTTP | openai/elicitation create/MRTR support checked explicitly | Integration / same |
| Functional form presentation | Keyboard usable accept/cancel/decline, escaped options | Inert injected text, invalid values | Synthetic browser user | Submit to owning application workflow; no browser authority | Chromium | Application form fallback, no host certification | Browser / pnpm --filter @happyvertical/smrt-mcp-openai test:forms:e2e |
| Package boundaries | Packed forms browser and server entries load | SDK v1/server imports in browser | Package consumer | N/A: static bundle/load | Node/browser | Published explicit subpaths | Pack / pnpm --filter @happyvertical/smrt-mcp-openai verify:forms:pack |

Full root gates and final independent review are coordinator-owned after #3205 repair.
Actual OpenAI host verification remains M8; synthetic tests cannot satisfy it.

Accepted review regression: for both multi-select and free-text arrays, untouched
optional fields without defaults are omitted; editing then clearing submits an
explicit empty array, accepted at minItems=0 and rejected at minItems=1. Untouched
required arrays still undergo minItems validation. Browser fixtures cover each
case; the two optional-omission cases fail against the pre-fix renderer.

## PR3283 accepted round-3 corrections

| Invariant | Reachable trigger | Positive | Negative/failure | Actor/context and executor | Runtime/contract edge | Level and command |
|---|---|---|---|---|---|---|
| Inert shared JSON | form schema/reply and shared native/context/message/mention/settings/file parsers | ordinary nested JSON; validation returns void | array getter/iterator/custom prototype, hidden getter/toJSON, inherited toJSON: zero callbacks; sparse/custom/symbol fields rejected | untrusted caller; no domain executor | Node and browser; pinned bounded JSON schema, unknown non-JSON rejected | full `test`, installed forms/shared-boundary probes |
| Reversible string arrays | free array form editor defaults and edited values | newline item, empty item, >4096 total with bounded items | invalid JSON, non-string/oversized item, minItems empty | local form input; submission spy/HTTP fixture only, no domain approval | Chromium; existing 64-item/4096-item/65536-byte profile | `test:forms:e2e`, installed validator |
| Optional empty choice | enum/oneOf selection/default | defined empty choice survives | untouched optional text omitted | local form; authenticated route still owns execution | Chromium select placeholder vs explicit empty option | `test:forms:e2e` |
| Real date-time | reply/default string validation | leap day, fractional second, offsets crossing date boundary | February31/nonleapFebruary29/April31, hour24, minute/second60, offset overflow | untrusted input; no persistence mutation | Node/public installed API; existing RFC3339-style profile | `test`, installed forms probe |

Baseline production48bc with test-only overlays: descriptor/date unit regressions
and actual Chromium round-trip/choice regressions fail before fixes; overlay hashes
and exact logs are retained externally in round-3-pr-feedback. Shared `json()`
callers were audited in validation, index, client, settings, context, messages,
mentions, file-contracts, files and forms-server: all call the boundary before
interpreting wire values; stricter descriptor rejection has full owning-package
unit/browser/installed coverage. SQL/PG/root-wide replay is N/A for these parser
and presentation-only corrections; existing durable authority remains unchanged.
