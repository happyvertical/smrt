---
'@happyvertical/smrt-users': minor
---

Remember the tenant a user last switched into (`Membership.lastSelectedAt`) and expose `SessionService.lastActiveTenantFor()` / `lastActiveTenantFor()` from `/sveltekit` so sign-in can resume it (#5358). Adds a nullable column; run `smrt db:migrate`.
