# Protocol conformance fixture (#4317)

`src/mcp-conformance.spec.ts` tests the production HTTP handler with the installed
official client and the reviewed baseline. Its child process owns an isolated
consumer workspace containing package/model manifests and authored docs. It does
not inherit the arbitrary size of the caller's checkout or change global cwd.

The official request deadline, assertions, baseline and production TTL0 freshness
behavior stay unchanged. Discovery and subsequent reads after package/doc edits
must remain observable. This fixture proves protocol behavior; it is not evidence
of an arbitrary-workspace latency SLA. Broader workspace, discovery and freshness
coverage remains in `src/knowledge/` tests.

| Behavior | Trigger | Positive | Negative | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Use the actual protocol implementation | Official client connects to isolated host | Reviewed suite/baseline passes | Unexpected scenario still fails | MCP client and production handler in a real child | HTTP/child process; no SQL transaction | Node 26/MCP 2026-07-28; no DB | Official client and unchanged deadline | Conformance integration | `pnpm --filter @happyvertical/smrt-dev-mcp exec vitest run src/mcp-conformance.spec.ts` |
| Retain metadata/header contracts | Modern requests/discovery | Cache/result metadata and reads match assertions | Header/method mismatch is rejected | HTTP client | HTTP; no SQL transaction | Node 26/MCP; no DB | Production HTTP adapter | Integration | `pnpm --filter @happyvertical/smrt-dev-mcp exec vitest run src/mcp-conformance.spec.ts` |
| Meaningful bounded discovery | Fixture has model/package/docs | Exact fixture package resources and model field are present | Accidental monorepo discovery cannot satisfy exact set | Consumer workspace | Filesystem/index read; no SQL transaction | Node 26; no DB | Real manifest/doc discovery | Integration | `pnpm --filter @happyvertical/smrt-dev-mcp exec vitest run src/mcp-conformance.spec.ts` |
| Preserve live freshness | Add package and edit authored docs | Subsequent list/read reflects changes | Stale/empty success fails assertions | Consumer editing project files | Filesystem and HTTP; no SQL transaction | Node 26/MCP; no DB | TTL0 resource contract | Integration | `pnpm --filter @happyvertical/smrt-dev-mcp exec vitest run src/mcp-conformance.spec.ts` |
| Isolate and clean execution | Host startup, exit or teardown | Child cwd and temporary files are scoped and removed | Startup/termination failure is bounded and reported | Test integration owner | Child process/filesystem; no SQL transaction | Node 26; no DB | IPC, signals and temporary resources | Integration | `pnpm --filter @happyvertical/smrt-dev-mcp exec vitest run src/mcp-conformance.spec.ts` |
