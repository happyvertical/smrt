# @happyvertical/smrt-desktop

The sidecar manifest is shared by the desktop runtime bundler and supervisor.
Its v1 wire format, portable path rules, and trusted package boundary are
documented in [README.md](README.md). Keep the Node 26 example and test cases
aligned with the parser. Keep the manifest package free of runtime dependencies.

From this directory, run `npm run build`, `npm run typecheck`, and
`smrt test src/sidecar-manifest.test.ts`.
