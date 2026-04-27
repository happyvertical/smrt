# @happyvertical/smrt-voice

## 0.22.15

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.15
  - @happyvertical/smrt-assets@0.22.15
  - @happyvertical/smrt-content@0.22.15
  - @happyvertical/smrt-tenancy@0.22.15
  - @happyvertical/smrt-config@0.22.15

## 0.22.14

### Patch Changes

- Updated dependencies [f81fc02]
  - @happyvertical/smrt-core@0.22.14
  - @happyvertical/smrt-assets@0.22.14
  - @happyvertical/smrt-content@0.22.14
  - @happyvertical/smrt-tenancy@0.22.14
  - @happyvertical/smrt-config@0.22.14

## 0.22.13

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.13
  - @happyvertical/smrt-assets@0.22.13
  - @happyvertical/smrt-content@0.22.13
  - @happyvertical/smrt-tenancy@0.22.13
  - @happyvertical/smrt-config@0.22.13

## 0.22.12

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.12
  - @happyvertical/smrt-assets@0.22.12
  - @happyvertical/smrt-content@0.22.12
  - @happyvertical/smrt-tenancy@0.22.12
  - @happyvertical/smrt-config@0.22.12

## 0.22.11

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.11
  - @happyvertical/smrt-assets@0.22.11
  - @happyvertical/smrt-content@0.22.11
  - @happyvertical/smrt-tenancy@0.22.11
  - @happyvertical/smrt-config@0.22.11

## 0.22.10

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.10
  - @happyvertical/smrt-assets@0.22.10
  - @happyvertical/smrt-content@0.22.10
  - @happyvertical/smrt-tenancy@0.22.10
  - @happyvertical/smrt-config@0.22.10

## 0.22.9

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.9
  - @happyvertical/smrt-assets@0.22.9
  - @happyvertical/smrt-content@0.22.9
  - @happyvertical/smrt-tenancy@0.22.9
  - @happyvertical/smrt-config@0.22.9

## 0.22.8

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.8
  - @happyvertical/smrt-assets@0.22.8
  - @happyvertical/smrt-content@0.22.8
  - @happyvertical/smrt-tenancy@0.22.8
  - @happyvertical/smrt-config@0.22.8

## 0.22.7

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.7
  - @happyvertical/smrt-assets@0.22.7
  - @happyvertical/smrt-content@0.22.7
  - @happyvertical/smrt-tenancy@0.22.7
  - @happyvertical/smrt-config@0.22.7

## 0.22.6

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.6
  - @happyvertical/smrt-assets@0.22.6
  - @happyvertical/smrt-content@0.22.6
  - @happyvertical/smrt-tenancy@0.22.6
  - @happyvertical/smrt-config@0.22.6

## 0.22.5

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.5
  - @happyvertical/smrt-assets@0.22.5
  - @happyvertical/smrt-content@0.22.5
  - @happyvertical/smrt-tenancy@0.22.5
  - @happyvertical/smrt-config@0.22.5

## 0.22.4

### Patch Changes

- @happyvertical/smrt-assets@0.22.4
- @happyvertical/smrt-config@0.22.4
- @happyvertical/smrt-content@0.22.4
- @happyvertical/smrt-core@0.22.4
- @happyvertical/smrt-tenancy@0.22.4

## 0.22.3

### Patch Changes

- Updated dependencies [3bad5df]
  - @happyvertical/smrt-core@0.22.3
  - @happyvertical/smrt-assets@0.22.3
  - @happyvertical/smrt-content@0.22.3
  - @happyvertical/smrt-tenancy@0.22.3
  - @happyvertical/smrt-config@0.22.3

## 0.22.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.2
  - @happyvertical/smrt-assets@0.22.2
  - @happyvertical/smrt-content@0.22.2
  - @happyvertical/smrt-tenancy@0.22.2
  - @happyvertical/smrt-config@0.22.2

## 0.22.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.22.1
  - @happyvertical/smrt-assets@0.22.1
  - @happyvertical/smrt-content@0.22.1
  - @happyvertical/smrt-tenancy@0.22.1
  - @happyvertical/smrt-config@0.22.1

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
  - @happyvertical/smrt-assets@1.0.0
  - @happyvertical/smrt-content@1.0.0
  - @happyvertical/smrt-tenancy@1.0.0
  - @happyvertical/smrt-config@1.0.0

## 0.21.52

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.52
  - @happyvertical/smrt-assets@0.21.52
  - @happyvertical/smrt-content@0.21.52
  - @happyvertical/smrt-tenancy@0.21.52
  - @happyvertical/smrt-config@0.21.52

## 0.21.51

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.51
  - @happyvertical/smrt-assets@0.21.51
  - @happyvertical/smrt-content@0.21.51
  - @happyvertical/smrt-tenancy@0.21.51
  - @happyvertical/smrt-config@0.21.51

## 0.21.50

### Patch Changes

- Updated dependencies [dc274dd]
  - @happyvertical/smrt-core@0.21.50
  - @happyvertical/smrt-assets@0.21.50
  - @happyvertical/smrt-content@0.21.50
  - @happyvertical/smrt-tenancy@0.21.50
  - @happyvertical/smrt-config@0.21.50

## 0.21.49

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.49
  - @happyvertical/smrt-assets@0.21.49
  - @happyvertical/smrt-content@0.21.49
  - @happyvertical/smrt-tenancy@0.21.49
  - @happyvertical/smrt-config@0.21.49

## 0.21.48

### Patch Changes

- @happyvertical/smrt-assets@0.21.48
- @happyvertical/smrt-config@0.21.48
- @happyvertical/smrt-content@0.21.48
- @happyvertical/smrt-core@0.21.48
- @happyvertical/smrt-tenancy@0.21.48

## 0.21.47

### Patch Changes

- Updated dependencies [5c0d3eb]
  - @happyvertical/smrt-core@0.21.47
  - @happyvertical/smrt-assets@0.21.47
  - @happyvertical/smrt-content@0.21.47
  - @happyvertical/smrt-tenancy@0.21.47
  - @happyvertical/smrt-config@0.21.47

## 0.21.46

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.46
  - @happyvertical/smrt-assets@0.21.46
  - @happyvertical/smrt-content@0.21.46
  - @happyvertical/smrt-tenancy@0.21.46
  - @happyvertical/smrt-config@0.21.46

## 0.21.45

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.45
  - @happyvertical/smrt-assets@0.21.45
  - @happyvertical/smrt-content@0.21.45
  - @happyvertical/smrt-tenancy@0.21.45
  - @happyvertical/smrt-config@0.21.45

## 0.21.44

### Patch Changes

- Updated dependencies [6056c00]
  - @happyvertical/smrt-core@0.21.44
  - @happyvertical/smrt-assets@0.21.44
  - @happyvertical/smrt-content@0.21.44
  - @happyvertical/smrt-tenancy@0.21.44
  - @happyvertical/smrt-config@0.21.44

## 0.21.43

### Patch Changes

- @happyvertical/smrt-assets@0.21.43
- @happyvertical/smrt-config@0.21.43
- @happyvertical/smrt-content@0.21.43
- @happyvertical/smrt-core@0.21.43
- @happyvertical/smrt-tenancy@0.21.43

## 0.21.42

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.42
  - @happyvertical/smrt-assets@0.21.42
  - @happyvertical/smrt-content@0.21.42
  - @happyvertical/smrt-tenancy@0.21.42
  - @happyvertical/smrt-config@0.21.42

## 0.21.41

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.41
  - @happyvertical/smrt-assets@0.21.41
  - @happyvertical/smrt-content@0.21.41
  - @happyvertical/smrt-tenancy@0.21.41
  - @happyvertical/smrt-config@0.21.41

## 0.21.40

### Patch Changes

- Updated dependencies [60084ad]
  - @happyvertical/smrt-core@0.21.40
  - @happyvertical/smrt-assets@0.21.40
  - @happyvertical/smrt-content@0.21.40
  - @happyvertical/smrt-tenancy@0.21.40
  - @happyvertical/smrt-config@0.21.40

## 0.21.39

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.39
  - @happyvertical/smrt-assets@0.21.39
  - @happyvertical/smrt-content@0.21.39
  - @happyvertical/smrt-tenancy@0.21.39
  - @happyvertical/smrt-config@0.21.39

## 0.21.38

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.38
  - @happyvertical/smrt-assets@0.21.38
  - @happyvertical/smrt-content@0.21.38
  - @happyvertical/smrt-tenancy@0.21.38
  - @happyvertical/smrt-config@0.21.38

## 0.21.37

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.37
  - @happyvertical/smrt-assets@0.21.37
  - @happyvertical/smrt-content@0.21.37
  - @happyvertical/smrt-tenancy@0.21.37
  - @happyvertical/smrt-config@0.21.37

## 0.21.36

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.36
  - @happyvertical/smrt-assets@0.21.36
  - @happyvertical/smrt-content@0.21.36
  - @happyvertical/smrt-tenancy@0.21.36
  - @happyvertical/smrt-config@0.21.36

## 0.21.35

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.35
  - @happyvertical/smrt-assets@0.21.35
  - @happyvertical/smrt-content@0.21.35
  - @happyvertical/smrt-tenancy@0.21.35
  - @happyvertical/smrt-config@0.21.35

## 0.21.34

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.34
  - @happyvertical/smrt-assets@0.21.34
  - @happyvertical/smrt-content@0.21.34
  - @happyvertical/smrt-tenancy@0.21.34
  - @happyvertical/smrt-config@0.21.34

## 0.21.33

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.33
  - @happyvertical/smrt-assets@0.21.33
  - @happyvertical/smrt-content@0.21.33
  - @happyvertical/smrt-tenancy@0.21.33
  - @happyvertical/smrt-config@0.21.33

## 0.21.32

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.32
  - @happyvertical/smrt-assets@0.21.32
  - @happyvertical/smrt-content@0.21.32
  - @happyvertical/smrt-tenancy@0.21.32
  - @happyvertical/smrt-config@0.21.32

## 0.21.31

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.31
  - @happyvertical/smrt-assets@0.21.31
  - @happyvertical/smrt-content@0.21.31
  - @happyvertical/smrt-tenancy@0.21.31
  - @happyvertical/smrt-config@0.21.31

## 0.21.30

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.30
  - @happyvertical/smrt-assets@0.21.30
  - @happyvertical/smrt-content@0.21.30
  - @happyvertical/smrt-tenancy@0.21.30
  - @happyvertical/smrt-config@0.21.30

## 0.21.29

### Patch Changes

- @happyvertical/smrt-assets@0.21.29
- @happyvertical/smrt-config@0.21.29
- @happyvertical/smrt-content@0.21.29
- @happyvertical/smrt-core@0.21.29
- @happyvertical/smrt-tenancy@0.21.29

## 0.21.28

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.28
  - @happyvertical/smrt-assets@0.21.28
  - @happyvertical/smrt-content@0.21.28
  - @happyvertical/smrt-tenancy@0.21.28
  - @happyvertical/smrt-config@0.21.28

## 0.21.27

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.27
  - @happyvertical/smrt-assets@0.21.27
  - @happyvertical/smrt-content@0.21.27
  - @happyvertical/smrt-tenancy@0.21.27
  - @happyvertical/smrt-config@0.21.27

## 0.21.26

### Patch Changes

- @happyvertical/smrt-content@0.21.26
- @happyvertical/smrt-tenancy@0.21.26
- @happyvertical/smrt-assets@0.21.26
- @happyvertical/smrt-config@0.21.26
- @happyvertical/smrt-core@0.21.26

## 0.21.25

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.25
  - @happyvertical/smrt-assets@0.21.25
  - @happyvertical/smrt-content@0.21.25
  - @happyvertical/smrt-tenancy@0.21.25
  - @happyvertical/smrt-config@0.21.25

## 0.21.24

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.24
  - @happyvertical/smrt-assets@0.21.24
  - @happyvertical/smrt-content@0.21.24
  - @happyvertical/smrt-tenancy@0.21.24
  - @happyvertical/smrt-config@0.21.24

## 0.21.23

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.23
  - @happyvertical/smrt-assets@0.21.23
  - @happyvertical/smrt-content@0.21.23
  - @happyvertical/smrt-tenancy@0.21.23
  - @happyvertical/smrt-config@0.21.23

## 0.21.22

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.22
  - @happyvertical/smrt-assets@0.21.22
  - @happyvertical/smrt-content@0.21.22
  - @happyvertical/smrt-tenancy@0.21.22
  - @happyvertical/smrt-config@0.21.22

## 0.21.21

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.21
  - @happyvertical/smrt-assets@0.21.21
  - @happyvertical/smrt-content@0.21.21
  - @happyvertical/smrt-tenancy@0.21.21
  - @happyvertical/smrt-config@0.21.21

## 0.21.20

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.20
  - @happyvertical/smrt-assets@0.21.20
  - @happyvertical/smrt-content@0.21.20
  - @happyvertical/smrt-tenancy@0.21.20
  - @happyvertical/smrt-config@0.21.20

## 0.21.19

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.19
  - @happyvertical/smrt-assets@0.21.19
  - @happyvertical/smrt-content@0.21.19
  - @happyvertical/smrt-tenancy@0.21.19
  - @happyvertical/smrt-config@0.21.19

## 0.21.18

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.18
  - @happyvertical/smrt-assets@0.21.18
  - @happyvertical/smrt-content@0.21.18
  - @happyvertical/smrt-tenancy@0.21.18
  - @happyvertical/smrt-config@0.21.18

## 0.21.17

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.17
  - @happyvertical/smrt-assets@0.21.17
  - @happyvertical/smrt-content@0.21.17
  - @happyvertical/smrt-tenancy@0.21.17
  - @happyvertical/smrt-config@0.21.17

## 0.21.16

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.16
  - @happyvertical/smrt-assets@0.21.16
  - @happyvertical/smrt-content@0.21.16
  - @happyvertical/smrt-tenancy@0.21.16
  - @happyvertical/smrt-config@0.21.16

## 0.21.15

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.15
  - @happyvertical/smrt-assets@0.21.15
  - @happyvertical/smrt-content@0.21.15
  - @happyvertical/smrt-tenancy@0.21.15
  - @happyvertical/smrt-config@0.21.15

## 0.21.14

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.14
  - @happyvertical/smrt-assets@0.21.14
  - @happyvertical/smrt-content@0.21.14
  - @happyvertical/smrt-tenancy@0.21.14
  - @happyvertical/smrt-config@0.21.14

## 0.21.13

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.13
  - @happyvertical/smrt-assets@0.21.13
  - @happyvertical/smrt-content@0.21.13
  - @happyvertical/smrt-tenancy@0.21.13
  - @happyvertical/smrt-config@0.21.13

## 0.21.12

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.12
  - @happyvertical/smrt-assets@0.21.12
  - @happyvertical/smrt-content@0.21.12
  - @happyvertical/smrt-tenancy@0.21.12
  - @happyvertical/smrt-config@0.21.12

## 0.21.11

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.11
  - @happyvertical/smrt-assets@0.21.11
  - @happyvertical/smrt-content@0.21.11
  - @happyvertical/smrt-tenancy@0.21.11
  - @happyvertical/smrt-config@0.21.11

## 0.21.10

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.10
  - @happyvertical/smrt-assets@0.21.10
  - @happyvertical/smrt-content@0.21.10
  - @happyvertical/smrt-tenancy@0.21.10
  - @happyvertical/smrt-config@0.21.10

## 0.21.9

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.9
  - @happyvertical/smrt-assets@0.21.9
  - @happyvertical/smrt-content@0.21.9
  - @happyvertical/smrt-tenancy@0.21.9
  - @happyvertical/smrt-config@0.21.9

## 0.21.8

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.8
  - @happyvertical/smrt-assets@0.21.8
  - @happyvertical/smrt-content@0.21.8
  - @happyvertical/smrt-tenancy@0.21.8
  - @happyvertical/smrt-config@0.21.8

## 0.21.7

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.7
  - @happyvertical/smrt-assets@0.21.7
  - @happyvertical/smrt-content@0.21.7
  - @happyvertical/smrt-tenancy@0.21.7
  - @happyvertical/smrt-config@0.21.7

## 0.21.6

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.6
  - @happyvertical/smrt-assets@0.21.6
  - @happyvertical/smrt-content@0.21.6
  - @happyvertical/smrt-tenancy@0.21.6
  - @happyvertical/smrt-config@0.21.6

## 0.21.5

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.5
  - @happyvertical/smrt-assets@0.21.5
  - @happyvertical/smrt-content@0.21.5
  - @happyvertical/smrt-tenancy@0.21.5
  - @happyvertical/smrt-config@0.21.5

## 0.21.4

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.4
  - @happyvertical/smrt-assets@0.21.4
  - @happyvertical/smrt-content@0.21.4
  - @happyvertical/smrt-tenancy@0.21.4
  - @happyvertical/smrt-config@0.21.4

## 0.21.3

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.3
  - @happyvertical/smrt-assets@0.21.3
  - @happyvertical/smrt-content@0.21.3
  - @happyvertical/smrt-tenancy@0.21.3
  - @happyvertical/smrt-config@0.21.3

## 0.21.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.2
  - @happyvertical/smrt-assets@0.21.2
  - @happyvertical/smrt-content@0.21.2
  - @happyvertical/smrt-tenancy@0.21.2
  - @happyvertical/smrt-config@0.21.2

## 0.21.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.21.1
  - @happyvertical/smrt-assets@0.21.1
  - @happyvertical/smrt-content@0.21.1
  - @happyvertical/smrt-tenancy@0.21.1
  - @happyvertical/smrt-config@0.21.1

## 1.0.0

### Patch Changes

- Updated dependencies [9f01b9a]
- Updated dependencies [e4a2fa7]
  - @happyvertical/smrt-core@1.0.0
  - @happyvertical/smrt-assets@1.0.0
  - @happyvertical/smrt-content@1.0.0
  - @happyvertical/smrt-tenancy@1.0.0
  - @happyvertical/smrt-config@1.0.0

## 0.20.56

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.56
  - @happyvertical/smrt-assets@0.20.56
  - @happyvertical/smrt-content@0.20.56
  - @happyvertical/smrt-tenancy@0.20.56
  - @happyvertical/smrt-config@0.20.56

## 0.20.54

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.54
  - @happyvertical/smrt-assets@0.20.54
  - @happyvertical/smrt-content@0.20.54
  - @happyvertical/smrt-tenancy@0.20.54
  - @happyvertical/smrt-config@0.20.54

## 0.20.53

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.53
  - @happyvertical/smrt-assets@0.20.53
  - @happyvertical/smrt-content@0.20.53
  - @happyvertical/smrt-tenancy@0.20.53
  - @happyvertical/smrt-config@0.20.53

## 0.20.52

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.52
  - @happyvertical/smrt-assets@0.20.52
  - @happyvertical/smrt-content@0.20.52
  - @happyvertical/smrt-tenancy@0.20.52
  - @happyvertical/smrt-config@0.20.52

## 0.20.51

### Patch Changes

- Updated dependencies [2dba0b4]
  - @happyvertical/smrt-core@0.20.51
  - @happyvertical/smrt-assets@0.20.51
  - @happyvertical/smrt-content@0.20.51
  - @happyvertical/smrt-tenancy@0.20.51
  - @happyvertical/smrt-config@0.20.51

## 0.20.50

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.50
  - @happyvertical/smrt-assets@0.20.50
  - @happyvertical/smrt-content@0.20.50
  - @happyvertical/smrt-tenancy@0.20.50
  - @happyvertical/smrt-config@0.20.50

## 0.20.49

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.49
  - @happyvertical/smrt-assets@0.20.49
  - @happyvertical/smrt-content@0.20.49
  - @happyvertical/smrt-tenancy@0.20.49
  - @happyvertical/smrt-config@0.20.49

## 0.20.48

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.48
  - @happyvertical/smrt-assets@0.20.48
  - @happyvertical/smrt-content@0.20.48
  - @happyvertical/smrt-tenancy@0.20.48
  - @happyvertical/smrt-config@0.20.48

## 0.20.47

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.47
  - @happyvertical/smrt-assets@0.20.47
  - @happyvertical/smrt-content@0.20.47
  - @happyvertical/smrt-tenancy@0.20.47
  - @happyvertical/smrt-config@0.20.47

## 0.20.46

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.46
  - @happyvertical/smrt-assets@0.20.46
  - @happyvertical/smrt-content@0.20.46
  - @happyvertical/smrt-tenancy@0.20.46
  - @happyvertical/smrt-config@0.20.46

## 0.20.45

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.45
  - @happyvertical/smrt-assets@0.20.45
  - @happyvertical/smrt-content@0.20.45
  - @happyvertical/smrt-tenancy@0.20.45
  - @happyvertical/smrt-config@0.20.45

## 0.20.44

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.44
  - @happyvertical/smrt-assets@0.20.44
  - @happyvertical/smrt-content@0.20.44
  - @happyvertical/smrt-tenancy@0.20.44
  - @happyvertical/smrt-config@0.20.44

## 0.20.43

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.43
  - @happyvertical/smrt-assets@0.20.43
  - @happyvertical/smrt-content@0.20.43
  - @happyvertical/smrt-tenancy@0.20.43
  - @happyvertical/smrt-config@0.20.43

## 0.20.42

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.42
  - @happyvertical/smrt-assets@0.20.42
  - @happyvertical/smrt-content@0.20.42
  - @happyvertical/smrt-tenancy@0.20.42
  - @happyvertical/smrt-config@0.20.42

## 0.20.41

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.41
  - @happyvertical/smrt-assets@0.20.41
  - @happyvertical/smrt-content@0.20.41
  - @happyvertical/smrt-tenancy@0.20.41
  - @happyvertical/smrt-config@0.20.41

## 0.20.40

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.40
  - @happyvertical/smrt-assets@0.20.40
  - @happyvertical/smrt-content@0.20.40
  - @happyvertical/smrt-tenancy@0.20.40
  - @happyvertical/smrt-config@0.20.40

## 0.20.39

### Patch Changes

- Updated dependencies [5092f5e]
  - @happyvertical/smrt-core@0.20.39
  - @happyvertical/smrt-assets@0.20.39
  - @happyvertical/smrt-content@0.20.39
  - @happyvertical/smrt-tenancy@0.20.39
  - @happyvertical/smrt-config@0.20.39

## 0.20.38

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.38
  - @happyvertical/smrt-assets@0.20.38
  - @happyvertical/smrt-content@0.20.38
  - @happyvertical/smrt-tenancy@0.20.38
  - @happyvertical/smrt-config@0.20.38

## 0.20.37

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.37
  - @happyvertical/smrt-assets@0.20.37
  - @happyvertical/smrt-content@0.20.37
  - @happyvertical/smrt-tenancy@0.20.37
  - @happyvertical/smrt-config@0.20.37

## 0.20.36

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.36
  - @happyvertical/smrt-assets@0.20.36
  - @happyvertical/smrt-content@0.20.36
  - @happyvertical/smrt-tenancy@0.20.36
  - @happyvertical/smrt-config@0.20.36

## 0.20.35

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.35
  - @happyvertical/smrt-assets@0.20.35
  - @happyvertical/smrt-content@0.20.35
  - @happyvertical/smrt-tenancy@0.20.35
  - @happyvertical/smrt-config@0.20.35

## 0.20.34

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.34
  - @happyvertical/smrt-assets@0.20.34
  - @happyvertical/smrt-content@0.20.34
  - @happyvertical/smrt-tenancy@0.20.34
  - @happyvertical/smrt-config@0.20.34

## 0.20.33

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.33
  - @happyvertical/smrt-assets@0.20.33
  - @happyvertical/smrt-content@0.20.33
  - @happyvertical/smrt-tenancy@0.20.33
  - @happyvertical/smrt-config@0.20.33

## 0.20.32

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.32
  - @happyvertical/smrt-assets@0.20.32
  - @happyvertical/smrt-content@0.20.32
  - @happyvertical/smrt-tenancy@0.20.32
  - @happyvertical/smrt-config@0.20.32

## 0.20.31

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.31
  - @happyvertical/smrt-assets@0.20.31
  - @happyvertical/smrt-content@0.20.31
  - @happyvertical/smrt-tenancy@0.20.31
  - @happyvertical/smrt-config@0.20.31

## 0.20.30

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.30
  - @happyvertical/smrt-assets@0.20.30
  - @happyvertical/smrt-content@0.20.30
  - @happyvertical/smrt-tenancy@0.20.30
  - @happyvertical/smrt-config@0.20.30

## 0.20.29

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.29
  - @happyvertical/smrt-assets@0.20.29
  - @happyvertical/smrt-content@0.20.29
  - @happyvertical/smrt-tenancy@0.20.29
  - @happyvertical/smrt-config@0.20.29

## 0.20.28

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.28
  - @happyvertical/smrt-assets@0.20.28
  - @happyvertical/smrt-content@0.20.28
  - @happyvertical/smrt-tenancy@0.20.28
  - @happyvertical/smrt-config@0.20.28

## 0.20.27

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.27
  - @happyvertical/smrt-assets@0.20.27
  - @happyvertical/smrt-content@0.20.27
  - @happyvertical/smrt-tenancy@0.20.27
  - @happyvertical/smrt-config@0.20.27

## 0.20.26

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.26
  - @happyvertical/smrt-assets@0.20.26
  - @happyvertical/smrt-content@0.20.26
  - @happyvertical/smrt-tenancy@0.20.26
  - @happyvertical/smrt-config@0.20.26

## 0.20.25

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.25
  - @happyvertical/smrt-assets@0.20.25
  - @happyvertical/smrt-content@0.20.25
  - @happyvertical/smrt-tenancy@0.20.25
  - @happyvertical/smrt-config@0.20.25

## 0.20.24

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.24
  - @happyvertical/smrt-assets@0.20.24
  - @happyvertical/smrt-content@0.20.24
  - @happyvertical/smrt-tenancy@0.20.24
  - @happyvertical/smrt-config@0.20.24

## 0.20.23

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.23
  - @happyvertical/smrt-assets@0.20.23
  - @happyvertical/smrt-content@0.20.23
  - @happyvertical/smrt-tenancy@0.20.23
  - @happyvertical/smrt-config@0.20.23

## 0.20.22

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.22
  - @happyvertical/smrt-assets@0.20.22
  - @happyvertical/smrt-content@0.20.22
  - @happyvertical/smrt-tenancy@0.20.22
  - @happyvertical/smrt-config@0.20.22

## 0.20.21

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.21
  - @happyvertical/smrt-assets@0.20.21
  - @happyvertical/smrt-content@0.20.21
  - @happyvertical/smrt-tenancy@0.20.21
  - @happyvertical/smrt-config@0.20.21

## 0.20.20

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.20
  - @happyvertical/smrt-assets@0.20.20
  - @happyvertical/smrt-content@0.20.20
  - @happyvertical/smrt-tenancy@0.20.20
  - @happyvertical/smrt-config@0.20.20

## 0.20.19

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.19
  - @happyvertical/smrt-assets@0.20.19
  - @happyvertical/smrt-content@0.20.19
  - @happyvertical/smrt-tenancy@0.20.19
  - @happyvertical/smrt-config@0.20.19

## 0.20.18

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.18
  - @happyvertical/smrt-assets@0.20.18
  - @happyvertical/smrt-content@0.20.18
  - @happyvertical/smrt-tenancy@0.20.18
  - @happyvertical/smrt-config@0.20.18

## 0.20.17

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.17
  - @happyvertical/smrt-assets@0.20.17
  - @happyvertical/smrt-content@0.20.17
  - @happyvertical/smrt-tenancy@0.20.17
  - @happyvertical/smrt-config@0.20.17

## 0.20.16

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.16
  - @happyvertical/smrt-assets@0.20.16
  - @happyvertical/smrt-content@0.20.16
  - @happyvertical/smrt-tenancy@0.20.16
  - @happyvertical/smrt-config@0.20.16

## 0.20.15

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.15
  - @happyvertical/smrt-assets@0.20.15
  - @happyvertical/smrt-content@0.20.15
  - @happyvertical/smrt-tenancy@0.20.15
  - @happyvertical/smrt-config@0.20.15

## 0.20.14

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.14
  - @happyvertical/smrt-assets@0.20.14
  - @happyvertical/smrt-content@0.20.14
  - @happyvertical/smrt-tenancy@0.20.14
  - @happyvertical/smrt-config@0.20.14

## 0.20.10

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.10
  - @happyvertical/smrt-assets@0.20.10
  - @happyvertical/smrt-content@0.20.10
  - @happyvertical/smrt-tenancy@0.20.10
  - @happyvertical/smrt-config@0.20.10

## 0.20.9

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.9
  - @happyvertical/smrt-assets@0.20.9
  - @happyvertical/smrt-content@0.20.9
  - @happyvertical/smrt-tenancy@0.20.9
  - @happyvertical/smrt-config@0.20.9

## 0.0.39

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.8
  - @happyvertical/smrt-assets@0.20.8
  - @happyvertical/smrt-content@0.20.8
  - @happyvertical/smrt-tenancy@0.20.8
  - @happyvertical/smrt-config@0.20.8

## 0.0.38

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.7
  - @happyvertical/smrt-assets@0.20.7
  - @happyvertical/smrt-content@0.20.7
  - @happyvertical/smrt-tenancy@0.20.7
  - @happyvertical/smrt-config@0.20.7

## 0.0.37

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.6
  - @happyvertical/smrt-assets@0.20.6
  - @happyvertical/smrt-content@0.20.6
  - @happyvertical/smrt-tenancy@0.20.6
  - @happyvertical/smrt-config@0.20.6

## 0.0.36

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.5
  - @happyvertical/smrt-assets@0.20.5
  - @happyvertical/smrt-content@0.20.5
  - @happyvertical/smrt-tenancy@0.20.5
  - @happyvertical/smrt-config@0.20.5

## 0.0.35

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.4
  - @happyvertical/smrt-assets@0.20.4
  - @happyvertical/smrt-content@0.20.4
  - @happyvertical/smrt-tenancy@0.20.4
  - @happyvertical/smrt-config@0.20.4

## 0.0.34

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.3
  - @happyvertical/smrt-assets@0.20.3
  - @happyvertical/smrt-content@0.20.3
  - @happyvertical/smrt-tenancy@0.20.3
  - @happyvertical/smrt-config@0.20.3

## 0.0.33

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.2
  - @happyvertical/smrt-assets@0.20.2
  - @happyvertical/smrt-content@0.20.2
  - @happyvertical/smrt-tenancy@0.20.2
  - @happyvertical/smrt-config@0.20.2

## 0.0.32

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.20.1
  - @happyvertical/smrt-assets@0.20.1
  - @happyvertical/smrt-content@0.20.1
  - @happyvertical/smrt-tenancy@0.20.1
  - @happyvertical/smrt-config@0.20.1

## 0.0.31

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@1.0.0
  - @happyvertical/smrt-assets@1.0.0
  - @happyvertical/smrt-content@1.0.0
  - @happyvertical/smrt-tenancy@1.0.0
  - @happyvertical/smrt-config@1.0.0

## 0.0.30

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.82
  - @happyvertical/smrt-assets@0.19.82
  - @happyvertical/smrt-content@0.19.82
  - @happyvertical/smrt-tenancy@0.19.82
  - @happyvertical/smrt-config@0.19.82

## 0.0.29

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.81
  - @happyvertical/smrt-assets@0.19.81
  - @happyvertical/smrt-content@0.19.81
  - @happyvertical/smrt-tenancy@0.19.81
  - @happyvertical/smrt-config@0.19.81

## 0.0.28

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.80
  - @happyvertical/smrt-assets@0.19.80
  - @happyvertical/smrt-content@0.19.80
  - @happyvertical/smrt-tenancy@0.19.80
  - @happyvertical/smrt-config@0.19.80

## 0.0.27

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.79
  - @happyvertical/smrt-assets@0.19.79
  - @happyvertical/smrt-content@0.19.79
  - @happyvertical/smrt-tenancy@0.19.79
  - @happyvertical/smrt-config@0.19.79

## 0.0.26

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.78
  - @happyvertical/smrt-assets@0.19.78
  - @happyvertical/smrt-content@0.19.78
  - @happyvertical/smrt-tenancy@0.19.78
  - @happyvertical/smrt-config@0.19.78

## 0.0.25

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.77
  - @happyvertical/smrt-assets@0.19.77
  - @happyvertical/smrt-content@0.19.77
  - @happyvertical/smrt-tenancy@0.19.77
  - @happyvertical/smrt-config@0.19.77

## 0.0.24

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.76
  - @happyvertical/smrt-assets@0.19.76
  - @happyvertical/smrt-content@0.19.76
  - @happyvertical/smrt-tenancy@0.19.76
  - @happyvertical/smrt-config@0.19.76

## 0.0.23

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.75
  - @happyvertical/smrt-assets@0.19.75
  - @happyvertical/smrt-content@0.19.75
  - @happyvertical/smrt-tenancy@0.19.75
  - @happyvertical/smrt-config@0.19.75

## 0.0.22

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.74
  - @happyvertical/smrt-assets@0.19.74
  - @happyvertical/smrt-content@0.19.74
  - @happyvertical/smrt-tenancy@0.19.74
  - @happyvertical/smrt-config@0.19.74

## 0.0.21

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.73
  - @happyvertical/smrt-assets@0.19.73
  - @happyvertical/smrt-content@0.19.73
  - @happyvertical/smrt-tenancy@0.19.73
  - @happyvertical/smrt-config@0.19.73

## 0.0.20

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.72
  - @happyvertical/smrt-assets@0.19.72
  - @happyvertical/smrt-content@0.19.72
  - @happyvertical/smrt-tenancy@0.19.72
  - @happyvertical/smrt-config@0.19.72

## 0.0.19

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.71
  - @happyvertical/smrt-assets@0.19.71
  - @happyvertical/smrt-content@0.19.71
  - @happyvertical/smrt-tenancy@0.19.71
  - @happyvertical/smrt-config@0.19.71

## 0.0.18

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.70
  - @happyvertical/smrt-assets@0.19.70
  - @happyvertical/smrt-content@0.19.70
  - @happyvertical/smrt-tenancy@0.19.70
  - @happyvertical/smrt-config@0.19.70

## 0.0.17

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.69
  - @happyvertical/smrt-assets@0.19.69
  - @happyvertical/smrt-content@0.19.69
  - @happyvertical/smrt-tenancy@0.19.69
  - @happyvertical/smrt-config@0.19.69

## 0.0.16

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.68
  - @happyvertical/smrt-assets@0.19.68
  - @happyvertical/smrt-content@0.19.68
  - @happyvertical/smrt-tenancy@0.19.68
  - @happyvertical/smrt-config@0.19.68

## 0.0.15

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.67
  - @happyvertical/smrt-assets@0.19.67
  - @happyvertical/smrt-content@0.19.67
  - @happyvertical/smrt-tenancy@0.19.67
  - @happyvertical/smrt-config@0.19.67

## 0.0.14

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.66
  - @happyvertical/smrt-assets@0.19.66
  - @happyvertical/smrt-content@0.19.66
  - @happyvertical/smrt-tenancy@0.19.66
  - @happyvertical/smrt-config@0.19.66

## 0.0.13

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.65
  - @happyvertical/smrt-assets@0.19.65
  - @happyvertical/smrt-content@0.19.65
  - @happyvertical/smrt-tenancy@0.19.65
  - @happyvertical/smrt-config@0.19.65

## 0.0.12

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.64
  - @happyvertical/smrt-assets@0.19.64
  - @happyvertical/smrt-content@0.19.64
  - @happyvertical/smrt-tenancy@0.19.64
  - @happyvertical/smrt-config@0.19.64

## 0.0.11

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.63
  - @happyvertical/smrt-assets@0.19.63
  - @happyvertical/smrt-content@0.19.63
  - @happyvertical/smrt-tenancy@0.19.63
  - @happyvertical/smrt-config@0.19.63

## 0.0.10

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.62
  - @happyvertical/smrt-assets@0.19.62
  - @happyvertical/smrt-content@0.19.62
  - @happyvertical/smrt-tenancy@0.19.62
  - @happyvertical/smrt-config@0.19.62

## 0.0.9

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.61
  - @happyvertical/smrt-assets@0.19.61
  - @happyvertical/smrt-content@0.19.61
  - @happyvertical/smrt-tenancy@0.19.61
  - @happyvertical/smrt-config@0.19.61

## 0.0.8

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.60
  - @happyvertical/smrt-assets@0.19.60
  - @happyvertical/smrt-content@0.19.60
  - @happyvertical/smrt-tenancy@0.19.60
  - @happyvertical/smrt-config@0.19.60

## 0.0.7

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.59
  - @happyvertical/smrt-assets@0.19.59
  - @happyvertical/smrt-content@0.19.59
  - @happyvertical/smrt-tenancy@0.19.59
  - @happyvertical/smrt-config@0.19.59

## 0.0.6

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.58
  - @happyvertical/smrt-assets@0.19.58
  - @happyvertical/smrt-content@0.19.58
  - @happyvertical/smrt-tenancy@0.19.58
  - @happyvertical/smrt-config@0.19.58

## 0.0.5

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.57
  - @happyvertical/smrt-assets@0.19.57
  - @happyvertical/smrt-content@0.19.57
  - @happyvertical/smrt-tenancy@0.19.57
  - @happyvertical/smrt-config@0.19.57

## 0.0.4

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.56
  - @happyvertical/smrt-assets@0.19.56
  - @happyvertical/smrt-content@0.19.56
  - @happyvertical/smrt-tenancy@0.19.56
  - @happyvertical/smrt-config@0.19.56

## 0.0.3

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.55
  - @happyvertical/smrt-assets@0.19.55
  - @happyvertical/smrt-content@0.19.55
  - @happyvertical/smrt-tenancy@0.19.55
  - @happyvertical/smrt-config@0.19.55

## 0.0.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.19.54
  - @happyvertical/smrt-assets@0.19.54
  - @happyvertical/smrt-content@0.19.54
  - @happyvertical/smrt-tenancy@0.19.54
  - @happyvertical/smrt-config@0.19.54
