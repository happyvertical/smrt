# M6c scoped validation

Synthetic data only. Node 26.8.1 / pnpm 11.25.0 satisfy package engines. Install
and the entire optional-package dependency build closure completed normally.
The native bridge seam is upstream M4 commit `226199fc541768e279858fc075698a8f57cdbe22`
(local application `24dc48dd7`; the sole merge resolution preserves older base
browser tests and appends the exact new extension scenario).

- `pnpm install`: pass.
- `pnpm --filter '@happyvertical/smrt-mcp-openai^...' build`: pass.
- `pnpm --filter @happyvertical/smrt-mcp-apps build`: pass after seam integration.
- Optional package `build`, `typecheck`, `test`: pass; 51 tests across four files,
  including real SDK-v2 HTTP and principal/owner/tenant/guessed/revoked denials.
- Optional package `test:e2e`: four unchanged navigation browser scenarios pass.
- Optional package `test:files:e2e`: seven Chromium scenarios pass against a real
  sandboxed iframe and synthetic host (native/absent/unknown, tenant/owner denies,
  conflict/revocation/subscription, bounds/MIME/open/failure, late disposal).
- Optional package `verify:pack`, `verify:files:pack`: pass for actual tarball,
  browser bundle and plain Node import of explicit files and files/server exports.
- `pnpm knowledge:graph`: pass; five built packages in this scoped closure.

Full command output is captured under `/tmp/smrt-3214-evidence` in the implementation
workspace. Parent schedules full root gates and independent high-risk review.
Live OpenAI host verification is **blocked by missing configured host connection**;
no product/build/platform claim follows from these synthetic tests. Host resource
operations use the actual browser wire shape and existing bridge, not an invented
SDK-v2 server bidirectional transport. No database dialect/persistence implementation
changed: host compare/write and existing application provider remain executors.
