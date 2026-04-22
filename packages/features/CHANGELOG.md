# @happyvertical/smrt-features

## 0.22.4

### Patch Changes

- @happyvertical/smrt-core@0.22.4
- @happyvertical/smrt-users@0.22.4

## 0.22.3

### Patch Changes

- Updated dependencies [3bad5df]
  - @happyvertical/smrt-core@0.22.3
  - @happyvertical/smrt-users@0.22.3

## 0.22.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.2
  - @happyvertical/smrt-users@0.22.2

## 0.22.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.1
  - @happyvertical/smrt-users@0.22.1

## 1.0.0

### Patch Changes

- 9284b1c: **Release A — close #1132: self-registering package manifests**

  Consumer runtimes (tsx, SvelteKit SSR, plain `vite dev`) no longer silently drop declared model fields. Every `@happyvertical/smrt-*` domain package now loads its own build-time manifest as a top-of-entry side effect, so `@smrt()` decorators find their fields before any class module evaluates. `place.save()` / `list({ where: { externalId } })` now round-trip declared fields from a fresh `pnpm add @happyvertical/smrt-places` — no vitest plugin required.

  **New in @happyvertical/smrt-core**:

  - `ObjectRegistry.registerPackageManifest(url)` — the primitive each package calls at import time.
  - `ObjectRegistry.getDiagnostics()` / `flushDiagnostics()` / `clearDiagnostics()` — opt-in collector for registry load failures that previously surfaced only as `console.warn`. Passive in this release; Release C (#1134) flips `SMRT_STRICT_REGISTRY` on by default.
  - `SMRT_SKIP_STI_REHYDRATE=true` env flag — opts out of the unconditional STI descendant re-hydration added in #1131, now redundant for consumers on the new builds. The flag is removed in Release C (#1134) once the self-registration rollout is proven stable.

  **Per-package change**: each listed package gains a one-line `src/__smrt-register__.ts` shim that runs before its class modules load. No consumer-facing API change.

- Updated dependencies [84b2430]
- Updated dependencies [9284b1c]
- Updated dependencies [bdd4979]
- Updated dependencies [8a0311a]
  - @happyvertical/smrt-core@1.0.0
  - @happyvertical/smrt-users@1.0.0

## 0.21.50

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.52
  - @happyvertical/smrt-users@0.21.52

## 0.21.49

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.51
  - @happyvertical/smrt-users@0.21.51

## 0.21.48

### Patch Changes

- Updated dependencies [dc274dd]
  - @happyvertical/smrt-core@0.21.50
  - @happyvertical/smrt-users@0.21.50

## 0.21.47

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.49
  - @happyvertical/smrt-users@0.21.49

## 0.21.46

### Patch Changes

- @happyvertical/smrt-core@0.21.48
- @happyvertical/smrt-users@0.21.48

## 0.21.45

### Patch Changes

- Updated dependencies [5c0d3eb]
  - @happyvertical/smrt-core@0.21.47
  - @happyvertical/smrt-users@0.21.47

## 0.21.44

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.46
  - @happyvertical/smrt-users@0.21.46

## 0.21.43

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.45
  - @happyvertical/smrt-users@0.21.45

## 0.21.42

### Patch Changes

- Updated dependencies [6056c00]
  - @happyvertical/smrt-core@0.21.44
  - @happyvertical/smrt-users@0.21.44

## 0.21.41

### Patch Changes

- @happyvertical/smrt-core@0.21.43
- @happyvertical/smrt-users@0.21.43

## 0.21.40

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.42
  - @happyvertical/smrt-users@0.21.42

Initial development version in this workspace.
