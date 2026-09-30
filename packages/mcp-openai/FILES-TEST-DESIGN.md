# M6c file authority matrix — #3214

Risk: high, file capability, owner/active-tenant isolation and write authority.
Contract: OpenAI e314720a0daac326217d1f123fcf51647868fa9f `docs/spec.md`,
`typescript/src/shared/file-entrypoint.ts`, `typescript/src/app/resources.ts`,
`typescript/src/app/files.ts`, `typescript/src/shared/resources.ts` (full Zod
schemas, not SDK-v1 runtime dependency). Official MCP server documentation was
searched/fetched; its SDK-v1 installation example does not override M0's native
split SDK-v2 contract. Browser protocol 2026-01-26; server 2026-07-28.

Existing authorized workflow handlers own grants and provider actions. The adapter
owns wire validation and lifecycle only. Host opaque handles never become server
filesystem paths; host and application independently authorize access. Application
authority checks run through the same server tool before each operation, including
subscription updates. Native ETag compare/write belongs to the host, never a new
server filesystem. No automatic write retry after any result/error.

Commands use `pnpm --filter @happyvertical/smrt-mcp-openai`.

| Behavior / reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/external edge | Level/command |
|---|---|---|---|---|---|---|
| File entrypoint tool | Valid extension + opaque input | Path/name traversal, URI confusion, unknown/missing fields, oversized input | Existing principal + owner + active tenant | Existing workflow handler | Node, pinned FileInput | unit + actual SDK HTTP / test |
| Read / every operation | Exact granted file, bounded text/blob MIME | Guessed handle, revoked owner, other tenant, oversize, MIME mismatch, bad base64/representation | Server authority tool then bound host grant | Existing app handler; host reads resource | Browser, resources/read | unit + real browser / test, test:e2e |
| Write | Read writable ETag then compare/write | Missing writable/etag, stale/conflict, concurrent call, too-large, malformed result, upstream unknown outcome | Same owner/tenant rechecked per write | Host atomic ifMatch; no adapter retry | Browser, openai/resources/write | unit + real browser / test, test:e2e |
| Subscription | Bounded single active subscription with authorized refresh | Revocation, wrong URI, stale handle, cancellation, late notification, disposal | Fresh app + host checks each refresh | Host subscription, no persistence | Browser, notifications/resources/updated | unit + real browser / test, test:e2e |
| Local open | User-mediated, app-authorized exact allowlisted path | Caller path, URI/traversal, remote path interpreted locally, denied gesture | Existing provider tool + bound host | Host open; never Node fs | Browser, openai/files/open | unit + browser / test, test:e2e |
| Capability fallback | Absent/unknown calls ordinary authorized import/open/download tool | Unknown capability cannot enable native transport; provider failure propagated | Existing app policy and handler | Existing provider actions | Node/browser, ordinary tools/call | integration / test, test:e2e |
| Packaging | Explicit optional files subpaths load packed Node/browser | No v1 or Node imports in browser module, ordinary tool unchanged | Consumer | N/A: no transaction | Packed Node/browser | build, typecheck, verify:pack, test:e2e |

Feature addition: base-regression test N/A. No database dialect changes: host owns
file transaction; synthetic app authority fixtures use existing workflow policy.
Actual OpenAI host remains unavailable: synthetic browser evidence cannot establish
product/build/platform support. Parent owns integrated root gates and final reviews.
