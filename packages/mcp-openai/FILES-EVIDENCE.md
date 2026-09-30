# M6c scoped validation

Synthetic data only. Node 26.8.1 / pnpm 11.25.0 satisfy package engines. Install
and the entire optional-package dependency build closure completed normally.
Final dependency integration includes M6a `4c134c951ab4e65115dac6bddaac2527d967e202`,
foundation `aaa84400e9f0d814f587ff77299b2f451549d34b`, security
`60d408c4f40fbcb5669960b7d3c57ea50af1cab1`, patch #3218
`695a38b63d89f265ceffcc5d7199779bf7c4b614`, and canonical generator #3219
`df03490e2e159d460cc2e5474cb1be0c130e9701`. The bridge test merge keeps the
newer full M4 suite, including its registered extension test. File authority,
MIME/byte bounds, ETag and disposal code is unchanged by dependency integration.

- `pnpm install`: pass.
- `pnpm --filter '@happyvertical/smrt-mcp-openai^...' build`: pass.
- `pnpm --filter @happyvertical/smrt-mcp-apps build`: pass after seam integration.
- Optional package `build`, `typecheck`, `test`: pass; 53 tests across four files,
  including real SDK-v2 HTTP and principal/owner/tenant/guessed/revoked denials.
- Optional package `test:e2e`: four unchanged navigation browser scenarios pass.
- Optional package `test:files:e2e`: seven Chromium scenarios pass against a real
  sandboxed iframe and synthetic host (native/absent/unknown, tenant/owner denies,
  conflict/revocation/subscription, bounds/MIME/open/failure, late disposal).
- Optional package `verify:pack`, `verify:files:pack`: pass for actual tarball,
  browser bundle and plain Node import of explicit files and files/server exports.
- Scoped pinned Biome CI: pass, no fixes.
- `pnpm knowledge:graph` and post-build `pnpm knowledge:check --strict --format markdown`: pass.
- Root test execution is reserved for the coordinator and was not run here.

Full command output is captured under `/tmp/smrt-3214-final` in the implementation
workspace. Parent schedules full root gates and independent high-risk review.
Live OpenAI host verification is **blocked by missing configured host connection**;
no product/build/platform claim follows from these synthetic tests. Host resource
operations use the actual browser wire shape and existing bridge, not an invented
SDK-v2 server bidirectional transport. No database dialect/persistence implementation
changed: host compare/write and existing application provider remain executors.
