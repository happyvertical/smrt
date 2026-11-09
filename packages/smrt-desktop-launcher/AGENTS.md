# @happyvertical/smrt-desktop-launcher

Launcher core for the native executable a Claude Desktop or ChatGPT desktop
plugin starts (#4729). It owns diagnostics, trust checks and the stdio
lifecycle around an injected `LauncherProvider`; it does not locate an
installation, start an instance or store a credential. Those belong to the
desktop supervisor, bundler and credential custody (#4663), which implement the
three provider methods. Do not edit those packages from here.

- Keep the package free of runtime dependencies and of imports from other
  SMRT packages. The provider interface in `src/provider.ts` is the contract
  wave 1 maps onto; keep it minimal and keep README's mapping table current.
- Diagnostics are constants (`src/diagnostics.ts`). Never interpolate a path,
  origin, provider message or child output into one. Exit codes are public.
- The credential is requested only after the runtime and the endpoint have
  passed their checks, and reaches the bridge only through its environment.
  Never put it in argv, files, logs or the launcher's own stdout.
- Probes go to the literal `127.0.0.1` through `src/loopback-fetch.ts` (a
  dedicated `node:http` agent). Never use global `fetch` for them: an
  environment proxy (`NODE_USE_ENV_PROXY`) would receive the bearer token.
- Never resolve an executable through `PATH`, never use a shell, and build the
  child environment from scratch.

From this directory, run `npm run build`, `npm run typecheck`, and
`smrt test`.
