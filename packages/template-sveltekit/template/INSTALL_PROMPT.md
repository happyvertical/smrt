# Agent install prompt

> Install this application using its documented deterministic path. Verify Node
> and pnpm requirements, run `pnpm install --frozen-lockfile` when a lockfile
> exists (otherwise `pnpm install`), then run `pnpm app:install`. Do not edit
> source or invent database/authentication steps. If installation fails, run
> `pnpm app:doctor`, show me its secret-free recovery findings, and ask before
> changing provider configuration.

The prompt is intentionally thin. `scripts/smrt-app.mjs` owns operations and
recovery.
