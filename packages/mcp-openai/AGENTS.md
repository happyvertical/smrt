# Optional OpenAI navigation adapter

`src/index.ts` composes existing principal-authorized app-MCP workflows. Settings
persistence, atomic assignment and tenant checks stay in the owning application
handler. The adapter validates wire contracts; it never authenticates or retries
writes. `src/client.ts` uses only the portable browser bridge and bounded inert
host context. No SDK v1 helper, second server, or OpenAI types in portable APIs.

Pinned contract, fallbacks, package gates and external-host evidence limitations
are in README.md; behavior/threat rows are in TEST-DESIGN.md. Run build, typecheck,
test, test:e2e and verify:pack. Synthetic hosts do not prove OpenAI host support.
