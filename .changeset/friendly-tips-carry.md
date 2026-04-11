---
"@happyvertical/smrt-agents": patch
"@happyvertical/smrt-core": patch
"@happyvertical/smrt-jobs": patch
---

Improve bundled runtime behavior and operator guidance for background jobs.

- fix `ObjectRegistry.ensureManifestLoaded()` and STI polymorphic hydration so installed external classes can be loaded on demand by qualified name
- clarify stale-heartbeat recovery errors for long-running blocking jobs
- document bundled runtime manifest loading, heartbeat-safe job execution, and the distinction between automatic scheduled work and manual operator actions such as forage/backfill flows
