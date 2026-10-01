# @happyvertical/smrt-mcp-apps

Browser-only view-side portable MCP Apps bridge. `src/index.ts` owns lifecycle,
correlated transport and capability gates; `src/validation.ts` owns bounded JSON
and the deliberately text/structured subset. No server credentials, Svelte,
OpenAI symbols or browser authorization/REST engine belong here.

The pinned upstream protocol/schema and known prose discrepancy are documented in
[README.md](README.md). Never change the protocol or widen a modality silently.
Host window and exact origin are immutable. Disposal rejects pending work.
Public registries remain in smrt-ui; Svelte bindings use the smrt-web intent
compiler through the explicit `smrt-svelte/mcp-apps` subpath.

Run package build/typecheck/test/test:e2e/verify:pack plus the Svelte browser gate
listed in README. `e2e/` is a synthetic host, not external-host compatibility
proof. Keep the generated reference resource under 100 KiB and CSP no-network.
