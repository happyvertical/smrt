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
