# @happyvertical/smrt-core

## 0.17.92

### Patch Changes

- ### Features

  - add implicit WHERE IN support for batch ID lookups (#645) (core)
  - @happyvertical/smrt-config@0.17.92
  - @happyvertical/smrt-types@0.17.92

## 0.17.91

### Patch Changes

- ### Other Changes

  - refactor: Unify manifest generation logic (#632) (manifest)
  - @happyvertical/smrt-config@0.17.91
  - @happyvertical/smrt-types@0.17.91

## 0.17.90

### Patch Changes

- ### Bug Fixes

  - FormMicButton improvements and bug fixes (#642) (forms)
  - @happyvertical/smrt-config@0.17.90
  - @happyvertical/smrt-types@0.17.90

## 0.17.89

### Patch Changes

- ### Features

  - add AI preloading and warm client caching (#641) (smrt-svelte)
  - @happyvertical/smrt-config@0.17.89
  - @happyvertical/smrt-types@0.17.89

## 0.17.88

### Patch Changes

- ### Features

  - add voice-enabled form components and browser-ai package (#640) (smrt-svelte)
  - @happyvertical/smrt-config@0.17.88
  - @happyvertical/smrt-types@0.17.88

## 0.17.87

### Patch Changes

- ### Features

  - multi-adapter testing + PostgreSQL compatibility (#637) (analytics)
  - @happyvertical/smrt-config@0.17.87
  - @happyvertical/smrt-types@0.17.87

## 0.17.86

### Patch Changes

- ### Bug Fixes

  - merge thumbnail config in generateMissingThumbnails (#636) (content)
  - @happyvertical/smrt-config@0.17.86
  - @happyvertical/smrt-types@0.17.86

## 0.17.85

### Patch Changes

- ### Features

  - add @happyvertical/smrt-analytics package (#635) (analytics)
  - @happyvertical/smrt-config@0.17.85
  - @happyvertical/smrt-types@0.17.85

## 0.17.84

### Patch Changes

- ### Bug Fixes

  - CI race conditions, foreignKey decorator, CLI method options (#634)
  - @happyvertical/smrt-config@0.17.84
  - @happyvertical/smrt-types@0.17.84

## 0.17.83

### Patch Changes

- ### Features

  - add email-based account linking for OAuth (#619) (profiles)

  ### Bug Fixes

  - improve error messages and STI parent class loading (#626) (core)
  - @happyvertical/smrt-config@0.17.83
  - @happyvertical/smrt-types@0.17.83

## 0.17.82

### Patch Changes

- ### Bug Fixes

  - resolve TypeScript error in thumbnail-generator (#617) (content)
  - skip collection classes in schema operations (#616) (core)
  - @happyvertical/smrt-config@0.17.82
  - @happyvertical/smrt-types@0.17.82

## 0.17.81

### Patch Changes

- ### Features

  - add Invoice, InvoiceLineItem, and PaymentAllocation models (#609) (commerce)

  ### Bug Fixes

  - remove gh CLI setup step (#613) (ci)
  - install gh CLI on self-hosted runners (#610) (ci)
  - call ensureAllSchemas() for JSON adapter cross-table queries (#608) (cli)

  ### Other Changes

  - chore: optimize workflows for custom ARC runner image (#615) (ci)
  - ci: use self-hosted arc-happyvertical runners (#605)
  - @happyvertical/smrt-config@0.17.81
  - @happyvertical/smrt-types@0.17.81

## 0.17.80

### Patch Changes

- ### Bug Fixes

  - ensure all tables exist for JSON adapter cross-table queries (#604) (core)
  - @happyvertical/smrt-config@0.17.80
  - @happyvertical/smrt-types@0.17.80

## 0.17.79

### Patch Changes

- ### Features

  - add TenantService with configurable tenant policies (#597) (users)

  ### Bug Fixes

  - add missing build dependency and STI strategy (#601) (users,commerce)
  - improve test isolation with randomUUID for temp paths (#599) (core)
  - support @smrt() decorator on abstract classes (TS 5.9) (#598) (core)
  - @happyvertical/smrt-config@0.17.79
  - @happyvertical/smrt-types@0.17.79

## 0.17.78

### Patch Changes

- ### Bug Fixes

  - make SmrtCollection constructor public + add smrt-svelte package (#595) (core)
  - @happyvertical/smrt-config@0.17.78
  - @happyvertical/smrt-types@0.17.78

## 0.17.77

### Patch Changes

- ### Features

  - add smrt-users module for multi-tenant user management (#594) (users)
  - @happyvertical/smrt-config@0.17.77
  - @happyvertical/smrt-types@0.17.77

## 0.17.76

### Patch Changes

- ### Features

  - add DispatchBus for inter-agent communication (#590) (dispatch)
  - add smrt-ads package for advertising delivery and tracking (#587) (ads)
  - add smrt-vitest plugin for cross-package manifest loading (#586) (vitest)

  ### Bug Fixes

  - TypeScript fixes and number type support for CLI (#591) (dispatch)
  - @happyvertical/smrt-config@0.17.76
  - @happyvertical/smrt-types@0.17.76

## 0.17.75

### Patch Changes

- ### Bug Fixes

  - allow real class to replace manifest-loaded entry (Issue #584) (#585) (core)
  - @happyvertical/smrt-config@0.17.75
  - @happyvertical/smrt-types@0.17.75

## 0.17.74

### Patch Changes

- ### Features

  - add smrt-commerce package for contracts, fulfillments, and payments (#582) (commerce)
  - @happyvertical/smrt-config@0.17.74
  - @happyvertical/smrt-types@0.17.74

## 0.17.73

### Patch Changes

- ### Features

  - add smrt-ledgers package for double-entry accounting (#580) (ledgers)
  - @happyvertical/smrt-config@0.17.73
  - @happyvertical/smrt-types@0.17.73

## 0.17.72

### Patch Changes

- ### Features

  - add smrt-properties package for digital property and zone management (#579) (properties)
  - @happyvertical/smrt-config@0.17.72
  - @happyvertical/smrt-types@0.17.72

## 0.17.71

### Patch Changes

- ### Other Changes

  - refactor: migrate Image embeddings to centralized system (#578) (assets)
  - @happyvertical/smrt-config@0.17.71
  - @happyvertical/smrt-types@0.17.71

## 0.17.70

### Patch Changes

- ### Features

  - add centralized embedding support for semantic search (#577) (core)
  - @happyvertical/smrt-config@0.17.70
  - @happyvertical/smrt-types@0.17.70

## 0.17.69

### Patch Changes

- ### Other Changes

  - chore: update @happyvertical/images to ^0.61.3 (#575) (content)
  - @happyvertical/smrt-config@0.17.69
  - @happyvertical/smrt-types@0.17.69

## 0.17.68

### Patch Changes

- ### Features

  - add thumbnail generation system with multiple strategies (#571) (content)
  - @happyvertical/smrt-config@0.17.68
  - @happyvertical/smrt-types@0.17.68

## 0.17.67

### Patch Changes

- ### Bug Fixes

  - register boolean method options with correct type (#570) (cli)
  - @happyvertical/smrt-config@0.17.67
  - @happyvertical/smrt-types@0.17.67

## 0.17.66

### Patch Changes

- ### Bug Fixes

  - ensure options.db contains db instance after initialization (#568) (core)
  - @happyvertical/smrt-config@0.17.66
  - @happyvertical/smrt-types@0.17.66

## 0.17.65

### Patch Changes

- ### Other Changes

  - chore: update @happyvertical/sdk packages to latest (#566) (deps)
  - @happyvertical/smrt-config@0.17.65
  - @happyvertical/smrt-types@0.17.65

## 0.17.64

### Patch Changes

- ### Features

  - Add db:migrate command for schema synchronization (#562) (cli)
  - @happyvertical/smrt-config@0.17.64
  - @happyvertical/smrt-types@0.17.64

## 0.17.63

### Patch Changes

- ### Bug Fixes

  - prevent class collision during vitest module re-evaluation (#556) (core)
  - @happyvertical/smrt-config@0.17.63
  - @happyvertical/smrt-types@0.17.63

## 0.17.62

### Patch Changes

- ### Bug Fixes

  - prevent duplicate command registration and execution (#554) (cli)
  - @happyvertical/smrt-config@0.17.62
  - @happyvertical/smrt-types@0.17.62

## 0.17.61

### Patch Changes

- ### Bug Fixes

  - update sql dependency to 0.60.6 for JSON export fix (#553) (deps)
  - @happyvertical/smrt-config@0.17.61
  - @happyvertical/smrt-types@0.17.61

## 0.17.60

### Patch Changes

- ### Bug Fixes

  - collection tableName correctly inherited from STI item class (#551) (#552) (core)
  - @happyvertical/smrt-config@0.17.60
  - @happyvertical/smrt-types@0.17.60

## 0.17.59

### Patch Changes

- ### Bug Fixes

  - validator uses snake_case for JSON file field lookups (#550) (cli)
  - @happyvertical/smrt-config@0.17.59
  - @happyvertical/smrt-types@0.17.59

## 0.17.58

### Patch Changes

- ### Bug Fixes

  - collection classes inherit tableName from STI item class (#548) (core)
  - @happyvertical/smrt-config@0.17.58
  - @happyvertical/smrt-types@0.17.58

## 0.17.57

### Patch Changes

- ### Other Changes

  - chore: update spider to 0.60.5 and ocr to 0.60.6 (#547) (deps)
  - @happyvertical/smrt-config@0.17.57
  - @happyvertical/smrt-types@0.17.57

## 0.17.56

### Patch Changes

- ### Bug Fixes

  - fix regression - methods with no params marked as needing ID (#546) (cli)
  - @happyvertical/smrt-config@0.17.56
  - @happyvertical/smrt-types@0.17.56

## 0.17.55

### Patch Changes

- ### Bug Fixes

  - fix heuristic for instance vs singleton custom methods (#545) (cli)
  - @happyvertical/smrt-config@0.17.55
  - @happyvertical/smrt-types@0.17.55

## 0.17.54

### Patch Changes

- ### Bug Fixes

  - use globalThis for cross-module state sharing (#544) (core)
  - @happyvertical/smrt-config@0.17.54
  - @happyvertical/smrt-types@0.17.54

## 0.17.53

### Patch Changes

- ### Features

  - add db:validate command for JSON database integrity checking (#541) (cli)
  - @happyvertical/smrt-config@0.17.53
  - @happyvertical/smrt-types@0.17.53

## 0.17.52

### Patch Changes

- ### Other Changes

  - chore: upgrade @happyvertical SDK dependencies to 0.60.5 (#539) (deps)
  - @happyvertical/smrt-config@0.17.52
  - @happyvertical/smrt-types@0.17.52

## 0.17.51

### Patch Changes

- ### Other Changes

  - chore: upgrade @happyvertical SDK dependencies to 0.60.4 (#535) (deps)
  - @happyvertical/smrt-config@0.17.51
  - @happyvertical/smrt-types@0.17.51

## 0.17.50

### Patch Changes

- ### Bug Fixes

  - case-insensitive manifest stub replacement (#531) (#532) (core)
  - @happyvertical/smrt-config@0.17.50
  - @happyvertical/smrt-types@0.17.50

## 0.17.49

### Patch Changes

- ### Features

  - add contactEmail and publisher to SiteConfig (#530) (config)
  - @happyvertical/smrt-config@0.17.49
  - @happyvertical/smrt-types@0.17.49

## 0.17.48

### Patch Changes

- ### Bug Fixes

  - only regenerate STI schema when descendants are from different packages (#529) (core)
  - @happyvertical/smrt-config@0.17.48
  - @happyvertical/smrt-types@0.17.48

## 0.17.47

### Patch Changes

- ### Bug Fixes

  - use STI base class name in schema generation for external parents (#528) (core)
  - @happyvertical/smrt-config@0.17.47
  - @happyvertical/smrt-types@0.17.47

## 0.17.46

### Patch Changes

- ### Bug Fixes

  - apply default patterns in git:init command (#526) (cli)
  - @happyvertical/smrt-config@0.17.46
  - @happyvertical/smrt-types@0.17.46

## 0.17.44

### Patch Changes

- ### Features

  - add JSON-aware git merge driver for SMRT data files (#525) (cli)
  - @happyvertical/smrt-config@0.17.44
  - @happyvertical/smrt-types@0.17.44

## 0.17.43

### Patch Changes

- ### Bug Fixes

  - add @smrt() decorator to Agent for inheritance chain discovery (#524) (agents)
  - @happyvertical/smrt-config@0.17.43
  - @happyvertical/smrt-types@0.17.43

## 0.17.42

### Patch Changes

- ### Bug Fixes

  - STI child classes correctly inherit tableName from manifest (#522) (core)
  - @happyvertical/smrt-config@0.17.42
  - @happyvertical/smrt-types@0.17.42

## 0.17.41

### Patch Changes

- ### Bug Fixes

  - use getTableStrategy() in getSTIBase() for proper inheritance detection (#520) (core)
  - address review feedback on STI manifest loading (#518) (agents)
  - @happyvertical/smrt-config@0.17.41
  - @happyvertical/smrt-types@0.17.41

## 0.17.40

### Patch Changes

- ### Bug Fixes

  - ensure manifest loaded before STI check in interesting() (#517) (agents)
  - @happyvertical/smrt-config@0.17.40
  - @happyvertical/smrt-types@0.17.40

## 0.17.39

### Patch Changes

- ### Bug Fixes

  - update @happyvertical/spider to 0.60.3 (#513) (content)
  - @happyvertical/smrt-config@0.17.39
  - @happyvertical/smrt-types@0.17.39

## 0.17.38

### Patch Changes

- ### Other Changes

  - chore: extract smrt-docs-mcp and svelte to separate repos (#511)
  - @happyvertical/smrt-config@0.17.38
  - @happyvertical/smrt-types@0.17.38

## 0.17.37

### Patch Changes

- ### Bug Fixes

  - update .npmrc to use NPM_TOKEN for GitHub Packages auth (#506)
  - @happyvertical/smrt-config@0.17.37
  - @happyvertical/smrt-types@0.17.37

## 0.17.36

### Patch Changes

- ### Bug Fixes

  - add yamllint config for GitHub Actions workflows (#494) (ci)
  - @happyvertical/smrt-config@0.17.36
  - @happyvertical/smrt-types@0.17.36

## 0.17.35

### Patch Changes

- ### Bug Fixes

  - add missing packages to changeset fixed array and sync versions (#490)

  ### Other Changes

  - chore: prepare for Renovate CE migration (#486)
  - @happyvertical/smrt-config@0.17.35
  - @happyvertical/smrt-types@0.17.35

## 0.17.34

### Patch Changes

- ### Other Changes

  - chore: add Renovate configuration (#484)
  - @happyvertical/smrt-config@0.17.34
  - @happyvertical/smrt-types@0.17.34

## 0.17.33

### Patch Changes

- ### Other Changes

  - refactor: simplify release workflow - every merge = release (#483) (ci)
  - @happyvertical/smrt-config@0.17.33
  - @happyvertical/smrt-types@0.17.33

## 0.17.32

### Patch Changes

- @happyvertical/smrt-config@0.17.32
- @happyvertical/smrt-types@0.17.32

## 0.17.31

### Patch Changes

- ### Bug Fixes

  - STI \_meta_type filter and decorator sync on stub replacement (#474) (agents,core)
  - @happyvertical/smrt-config@0.17.31
  - @happyvertical/smrt-types@0.17.31

## 0.17.30

### Patch Changes

- ### Bug Fixes

  - derive day name from date in WeatherHeader (#471) (svelte)
  - @happyvertical/smrt-config@0.17.30
  - @happyvertical/smrt-types@0.17.30

## 0.17.29

### Patch Changes

- ### Features

  - add handler function to interests system (#470) (agents)
  - @happyvertical/smrt-config@0.17.29
  - @happyvertical/smrt-types@0.17.29

## 0.17.28

### Patch Changes

- ### Features

  - add custom query support for interests system (#469) (agents)
  - @happyvertical/smrt-config@0.17.28
  - @happyvertical/smrt-types@0.17.28

## 0.17.27

### Patch Changes

- ### Features

  - add dependency graph generation with SKILL_TREE.md (#468) (deps)
  - @happyvertical/smrt-config@0.17.27
  - @happyvertical/smrt-types@0.17.27

## 0.17.26

### Patch Changes

- ### Features

  - add interests system for declarative object discovery (#466) (agents)
  - @happyvertical/smrt-config@0.17.26
  - @happyvertical/smrt-types@0.17.26

## 0.17.25

### Patch Changes

- ### Features

  - add Nostr login with magic link authentication (#460) (profiles)
  - @happyvertical/smrt-config@0.17.25
  - @happyvertical/smrt-types@0.17.25

## 0.17.24

### Patch Changes

- ### Features

  - add auth primitives for identity resolution (profiles)

  ### Bug Fixes

  - handle STI polymorphism in loadRelated() (core)
  - @happyvertical/smrt-config@0.17.24
  - @happyvertical/smrt-types@0.17.24

## 0.17.23

### Patch Changes

- ### Features

  - add @happyvertical/smrt-projects package (#454) (projects)
  - @happyvertical/smrt-config@0.17.23
  - @happyvertical/smrt-types@0.17.23

## 0.17.22

### Patch Changes

- ### Features

  - add @happyvertical/smrt-messages package (#451) (messages)
  - @happyvertical/smrt-config@0.17.22
  - @happyvertical/smrt-types@0.17.22

## 0.17.21

### Patch Changes

- ### Bug Fixes

  - load user classes even without local manifest (#448) (cli)
  - @happyvertical/smrt-config@0.17.21
  - @happyvertical/smrt-types@0.17.21

## 0.17.20

### Patch Changes

- ### Features

  - add SiteConfig and static JSON site template (#447) (config,cli)
  - @happyvertical/smrt-config@0.17.20
  - @happyvertical/smrt-types@0.17.20

## 0.17.19

### Patch Changes

- ### Bug Fixes

  - force clean rebuild during publish to avoid stale cache (#446) (ci)
  - @happyvertical/smrt-config@0.17.19
  - @happyvertical/smrt-types@0.17.19

## 0.17.18

### Patch Changes

- ### Features

  - add Content category field and Pagination component (#445)

  ### Bug Fixes

  - handle object type parameters and module-specific config (#441) (cli)
  - @happyvertical/smrt-config@0.17.18
  - @happyvertical/smrt-types@0.17.18

## 0.17.17

### Patch Changes

- ### Bug Fixes

  - use ObjectRegistry for objects command and add object-level help (#436) (cli)
  - generate slug from name field before title/label (#435) (core)
  - @happyvertical/smrt-config@0.17.17
  - @happyvertical/smrt-types@0.17.17

## 0.17.16

### Patch Changes

- ### Bug Fixes

  - downstream blockers for bentleyalberta.com and caelus (#425)
  - @happyvertical/smrt-config@0.17.16
  - @happyvertical/smrt-types@0.17.16

## 0.17.15

### Patch Changes

- ### Features

  - add generate-register command (#420) (cli)
  - @happyvertical/smrt-config@0.17.15
  - @happyvertical/smrt-types@0.17.15

## 0.17.14

### Patch Changes

- ### Bug Fixes

  - generate-routes now merges ALL discovered manifests (#418) (cli)
  - @happyvertical/smrt-config@0.17.14
  - @happyvertical/smrt-types@0.17.14

## 0.17.13

### Patch Changes

- ### Bug Fixes

  - use package imports for external packages in generate-routes (#416) (core)
  - @happyvertical/smrt-config@0.17.13
  - @happyvertical/smrt-types@0.17.13

## 0.17.12

### Patch Changes

- ### Bug Fixes

  - trigger release with #413 fix included (#414) (cli)
  - @happyvertical/smrt-config@0.17.12
  - @happyvertical/smrt-types@0.17.12

## 0.17.11

### Patch Changes

- ### Bug Fixes

  - resolve option key mismatch in generate commands (#413) (cli)
  - use kebab-case option keys in generate-routes command (#412) (cli)
  - @happyvertical/smrt-config@0.17.11
  - @happyvertical/smrt-types@0.17.11

## 0.17.10

### Patch Changes

- ### Features

  - add consumer project support and SvelteKit template (#410) (cli)
  - @happyvertical/smrt-config@0.17.10
  - @happyvertical/smrt-types@0.17.10

## 0.17.9

### Patch Changes

- ### Bug Fixes

  - use safe arithmetic syntax in cascade loop (#408) (workflows)
  - @happyvertical/smrt-config@0.17.9
  - @happyvertical/smrt-types@0.17.9

## 0.17.8

### Patch Changes

- ### Bug Fixes

  - resolve type aliases to infer string union types as text (#407) (scanner)
  - @happyvertical/smrt-config@0.17.8
  - @happyvertical/smrt-types@0.17.8

## 0.17.7

### Patch Changes

- ### Bug Fixes

  - use repository_dispatch for cascade triggers (#405) (workflows)
  - @happyvertical/smrt-config@0.17.7
  - @happyvertical/smrt-types@0.17.7

## 0.17.6

### Patch Changes

- ### Features

  - auto-cancel PR validation checks on merge (#402) (workflows)
  - @happyvertical/smrt-config@0.17.6
  - @happyvertical/smrt-types@0.17.6

## 0.17.5

### Patch Changes

- ### Bug Fixes

  - use -f flag for cascade workflow dispatch fields (#403) (workflows)
  - @happyvertical/smrt-config@0.17.5
  - @happyvertical/smrt-types@0.17.5

## 0.17.4

### Patch Changes

- ### Bug Fixes

  - improve cascade job logging and error handling (#401) (workflows)
  - @happyvertical/smrt-config@0.17.4
  - @happyvertical/smrt-types@0.17.4

## 0.17.3

### Patch Changes

- ### Bug Fixes

  - add NODE_AUTH_TOKEN for update dependencies step (#393) (ci)
  - @happyvertical/smrt-config@0.17.3
  - @happyvertical/smrt-types@0.17.3

## 0.17.2

### Patch Changes

- ### Bug Fixes

  - handle undefined JSON fields in STI sibling classes (#392) (core)
  - @happyvertical/smrt-config@0.17.2
  - @happyvertical/smrt-types@0.17.2

## 0.17.1

### Patch Changes

- ### Bug Fixes

  - replace broken changeset generation script (#390) (ci)
  - allow workflow_dispatch to trigger build and publish jobs (#388) (workflows)
  - add \_meta_type filter to Collection.findOne() for STI type discrimination (#387) (core)
  - @happyvertical/smrt-config@0.17.1
  - @happyvertical/smrt-types@0.17.1

## 0.17.0

### Minor Changes

- 620e56b: Add transformJSON() hook and preventative measures for safe JSON serialization

  **New Features:**

  - Add `transformJSON()` hook to `SmrtObject` for safe JSON serialization customization
  - Add runtime development check for unsafe `toJSON()` overrides in STI classes
  - Add comprehensive test suite for `transformJSON()` hook (12 tests)

  **Bug Fixes:**

  - Fix Content class `toJSON()` override that broke STI for descendants (issue #377)
  - Add STI compatibility tests for Content, ContentDocument, and Article (17 tests)

  **Documentation:**

  - Add warnings about `toJSON()` override dangers in core and content docs
  - Document `transformJSON()` hook pattern as recommended approach

  Closes #377, #378, #379

### Patch Changes

- @happyvertical/smrt-config@0.17.0
- @happyvertical/smrt-types@0.17.0

## 0.16.5

### Patch Changes

- @happyvertical/smrt-config@0.16.5
- @happyvertical/smrt-types@0.16.5

## 0.16.4

### Patch Changes

- @happyvertical/smrt-config@0.16.4
- @happyvertical/smrt-types@0.16.4

## 0.16.3

### Patch Changes

- 721e5b9: - fix(ci): auto-generate changesets in PR workflow
  - fix(core): implement build-time field inheritance for STI classes
- Updated dependencies [721e5b9]
  - @happyvertical/smrt-config@0.16.3
  - @happyvertical/smrt-types@0.16.3

## 0.16.2

### Patch Changes

- c2b3b49: fix(ci): remove GITHUB_TOKEN from workflow secrets

  Remove GITHUB_TOKEN from publish.yml secrets since it's automatically
  provided by GitHub Actions. Fixes 'secret name collision' errors.

- c04f2ba: refactor(manifest): eliminate runtime introspection and optimize manifest generation

  - Remove all runtime reflection/introspection from manifest code
  - Manifest generation now relies purely on AST-based static analysis
  - Import generator from source in scripts for better development workflow
  - Address code quality improvements from automated review

- 5fd254f: feat(ci): use shared direct publish workflow from SDK

  Migrate to the shared-direct-publish.yml reusable workflow from SDK for consistent
  publishing across all HappyVertical repositories. This eliminates intermediate
  "Version Packages" PRs and reduces CI runs from 3 to 2 per feature PR cycle.

  Changes:

  - Replace changesets/action@v1 with SDK's shared workflow
  - Separate cascade job for dependency triggers
  - Consistent with SDK's direct publish pattern

- 5643895: fix(ci): skip changeset check for automated Version Packages PRs

  Align with SDK direct publish pattern to prevent changeset checks on automated
  Version Packages PRs. This reduces CI overhead by eliminating unnecessary test runs.

  - @happyvertical/smrt-config@0.16.2
  - @happyvertical/smrt-types@0.16.2

## 0.16.1

### Patch Changes

- fadeb11: feat(ci): enable fixed versioning for workspace packages

  Configure monorepo for fixed versioning where all workspace packages share the same version number.
  Any change to the repository will bump all packages together. The root package.json version
  will be manually kept in sync with the workspace packages.

  - @happyvertical/smrt-config@0.16.1
  - @happyvertical/smrt-types@0.16.1

## 0.16.0

### Patch Changes

- @happyvertical/smrt-config@0.16.0
- @happyvertical/smrt-types@0.16.0

## 0.15.5

### Patch Changes

- dc292b5: fix(core): refactor schema setup to explicit initialization, fixing STI multi-level hierarchies and :memory: database bugs

  Replaces lazy initialization with explicit schema initialization at collection creation, fixing multi-level STI (Single Table Inheritance) hierarchies and :memory: database cache key bugs.

  **Root Cause:**
  The schema setup system had two critical issues:

  1. **Lazy initialization overhead**: Schema was created on EVERY database operation (save, get, list, etc.) with promise caching to prevent duplicates
  2. **:memory: cache key bug**: All in-memory databases shared the same cache key (`:memory:`) causing schema created in one DB instance to be incorrectly cached for other instances
  3. **Holdover from runtime introspection**: System still used runtime class constructor references, a holdover from pre-#131 runtime introspection

  **Solution:**
  Refactored to explicit initialization with dual caching strategy:

  **1. Explicit schema initialization in Collection.create() (collection.ts:322-328)**

  ```typescript
  // Initialize schema once at collection creation (replaces lazy initialization)
  if (instance.db && (this as any)._itemClass) {
    const className = (this as any)._itemClass.name;
    const { ensureSchema } = await import("./schema/utils.js");
    await ensureSchema(instance.db, className);
  }
  ```

  Schema created ONCE when collection is instantiated, not on every database operation.

  **2. Removed collection.setupDb() method**

  ```typescript
  // DELETED: 45 lines of lazy initialization code
  async setupDb() {
    if (this._db_setup_promise) {
      return this._db_setup_promise;
    }
    // ... complex setup logic
  }
  ```

  No longer needed - schema initialized in `Collection.create()`.

  **3. Minimal lazy init in object.save() (object.ts:741-746)**

  ```typescript
  // Ensure database schema exists (lazy initialization for standalone objects)
  // Collection-based workflows skip this via caching (schema already created in Collection.create())
  if (this.db) {
    const { ensureSchema } = await import("./schema/utils.js");
    await ensureSchema(this.db, this.constructor.name);
  }
  ```

  Supports standalone objects (created without collections) while benefiting from caching for collection-based workflows.

  **4. Dual caching strategy for :memory: databases (schema/utils.ts:139-150)**

  ```typescript
  // Dual caching strategy:
  // - File-based DBs: String keys "${dbUrl}::${tableName}"
  // - In-memory DBs: WeakMap with db instance as key (prevents cross-instance conflicts)
  const _setupTableFromClassPromises: Record<string, Promise<void> | null> = {};
  const _memoryDbSetupPromises = new WeakMap<
    any,
    Map<string, Promise<void> | null>
  >();
  ```

  Fixes bug where multiple `:memory:` databases incorrectly shared cached schema.

  **5. ObjectRegistry.getTableName() (registry.ts:1276)**

  ```typescript
  static getTableName(name: string): string | undefined {
    const registered = ObjectRegistry.classes.get(name);
    return registered?.schema?.tableName;
  }
  ```

  Retrieves table name from manifest metadata instead of class static property.

  **6. ensureSchema() function (schema/utils.ts:330)**

  ```typescript
  export async function ensureSchema(db: any, className: string): Promise<void>;
  ```

  Modern manifest-only schema initialization that:

  - Takes class name (string) instead of class constructor
  - Gets table name from `ObjectRegistry.getTableName(className)`
  - Handles STI recursion using class names: `await ensureSchema(db, stiBase)`
  - Uses dual caching strategy to handle :memory: databases correctly

  **Why This Fixes STI and :memory: Bugs:**

  - **Explicit initialization**: Schema created once at collection creation, not on every operation
  - **:memory: database isolation**: Each database instance has its own cache entry via WeakMap
  - **No more class constructor dependency**: Schema setup works purely from manifest data
  - **Proper STI recursion**: `ensureSchema(db, 'Council')` → `ensureSchema(db, 'Profile')` using class names
  - **Early base class table creation**: Manifest knows the inheritance chain, sets up base table first
  - **Performance**: Eliminates lazy initialization checks on every database operation

  **Changes:**

  - `packages/core/src/collection.ts`: Add schema initialization to `Collection.create()`, remove `setupDb()` method and `_db_setup_promise` property
  - `packages/core/src/object.ts`: Add minimal lazy init to `save()` for standalone objects (removed `ensureDbSetup()` method and `_dbSetupComplete` property)
  - `packages/core/src/schema/utils.ts`: Add dual caching strategy with WeakMap for :memory: databases, update `ensureSchema()` and `setupTableFromClass()` to use new caching
  - `packages/core/src/registry.ts`: Add `getTableName()` method for manifest-only table name retrieval
  - `packages/core/src/generators/mcp-protocol.spec.ts`: Fix test to call `Collection.create()` for explicit schema initialization (use TypeScript types instead of field helpers)
  - `packages/core/src/__tests__/sti-multilevel.test.ts`: Remove test workarounds - tests pass without artificial base class priming

  **Testing:**

  - **610 tests pass** (fixed MCP protocol test that required explicit schema initialization)
  - STI integration tests covering CREATE, READ, and polymorphic queries
  - Validates Council → Organization → Profile → SmrtObject hierarchy (4 levels)
  - **All tests pass WITHOUT artificial schema priming or lazy initialization** 🎉

  **Architecture Improvement:**
  This change represents a major architectural shift:

  1. **Explicit > Implicit**: Schema initialization happens once at a clear lifecycle point (collection creation), not lazily on every operation
  2. **Manifest-only**: Schema setup works purely from manifest metadata, no runtime class constructor references
  3. **Performance**: Eliminates redundant lazy initialization checks on every database operation
  4. **Correctness**: Fixes :memory: database cache key bug that caused cross-instance schema pollution

  **Fixes #332**

  - @happyvertical/smrt-config@0.15.5
  - @happyvertical/smrt-types@0.15.5

## 0.15.4

### Patch Changes

- c084e42: test: add comprehensive CRUD tests for @oneToMany relationships

  Adds extensive test coverage for basic database operations with relationship fields.

  **Test Coverage:**

  - CREATE operations with @oneToMany fields
  - READ operations (by ID, list all)
  - UPDATE operations
  - DELETE operations
  - Edge cases (minimal data, multiple saves)

  **Impact:**

  - Validates that relationship fields are correctly excluded from SQL operations
  - Provides regression tests for issues #324 and #327
  - Ensures CRUD operations work correctly with @oneToMany decorators

  Related to #327, #324

  - @happyvertical/smrt-config@0.15.4
  - @happyvertical/smrt-types@0.15.4

## 0.15.3

### Patch Changes

- 802adf9: fix(toJSON): exclude @oneToMany/@manyToMany fields from serialization

  Completes fix from #325 by updating toJSON() to filter out relationship fields.

  **Changes:**

  - Updated toJSON() to use field.\_meta instead of deprecated field.options
  - Added explicit filtering for oneToMany and manyToMany field types
  - Added cross-reference comments between toJSON() and SchemaGenerator

  **Impact:**

  - CRUD operations now work correctly for models with @oneToMany relationships
  - Fixes SQLITE_ERROR: table has no column named <field> in save() operations
  - Both schema generation AND serialization now filter relationship fields consistently

  Fixes #327

  - @happyvertical/smrt-config@0.15.3
  - @happyvertical/smrt-types@0.15.3

## 0.15.2

### Patch Changes

- 05b705c: fix(@oneToMany): exclude relationship fields from SQL INSERT/UPDATE statements

  Fixes #324 where @oneToMany decorated fields were incorrectly included in SQL INSERT/UPDATE statements as database columns, causing SQLITE_ERROR: table has no column named <field>.

  **Changes:**

  - Added transient field filtering to `SchemaGenerator.generateColumns()` method
  - Added explicit filtering for `oneToMany` and `manyToMany` relationship types
  - Added filtering for `meta` field types (STI support)
  - Exported `Meta<T>` type for STI meta field annotations

  **Impact:**

  - All CRUD operations now work correctly for models with @oneToMany relationships
  - Inheritance hierarchies (e.g., Council extends Organization extends Profile) work as expected
  - No breaking changes - only fixes incorrect behavior

  **Testing:**

  - Added comprehensive test suite in `issue-324-onetomany-sql.test.ts`
  - Existing transient field tests continue to pass
  - @happyvertical/smrt-config@0.15.2
  - @happyvertical/smrt-types@0.15.2

## 0.15.1

### Patch Changes

- 370ed46: Fix field name conflict by renaming internal metadata property from `field.options` to `field._meta`

  This resolves issue #319 where users could not define fields named "options" due to conflicts with the internal field metadata structure. Users can now safely use "options" as a field name.

  **Breaking change:** External code accessing `field.options` must update to `field._meta`

  - @happyvertical/smrt-config@0.15.1
  - @happyvertical/smrt-types@0.15.1

## 0.15.0

### Minor Changes

- e46b272: # BREAKING: Decorator Migration - Field Helpers Removed

  This release introduces `@field()` decorators as the **only** pattern for defining SMRT object properties. **Field helper functions have been completely removed** from the codebase.

  ## ✨ New Features

  ### Property Decorators

  ```typescript
  import { SmrtObject, smrt, field } from "@happyvertical/smrt-core";

  @smrt()
  class Product extends SmrtObject {
    // Decorator for constrained fields
    @field({ required: true })
    name: string = "";

    // TypeScript types for simple fields
    description: string = "";
    price: number = 0.0; // DECIMAL (has decimal point)
    quantity: number = 0; // INTEGER (no decimal point)
    active: boolean = true;
    tags: string[] = [];
    createdAt: Date = new Date();
  }
  ```

  ### Benefits

  - **Better IDE Support**: Full IntelliSense and type checking
  - **Cleaner Syntax**: More readable and maintainable code
  - **TypeScript-First**: Leverages native TypeScript types
  - **Automatic Schema Generation**: AST scanner infers database types from TypeScript

  ## 🔄 Changes

  ### All Domain Packages Migrated

  - **@happyvertical/smrt-profiles**: All models now use decorators
  - **@happyvertical/smrt-places**: Migrated to decorators
  - **@happyvertical/smrt-events**: EventType and related models updated
  - **@happyvertical/smrt-tags**: Tag and TagAlias migrated
  - **@happyvertical/smrt-content**: Content model updated

  ### MCP Code Generators Updated

  - `generate-smrt-class` tool now generates decorator-based code by default
  - `generate-field-definitions` tool updated to use decorators
  - All generated code follows modern TypeScript patterns

  ### Core Improvements

  - AST scanner automatically marks `oneToMany`/`manyToMany` fields as transient
  - Optimized object initialization for decorator-based classes
  - Added `ObjectRegistry.hasFieldDecorators()` helper method

  ## 📚 Migration Guide

  ### Before (Field Helpers)

  ```typescript
  import {
    SmrtObject,
    smrt,
    text,
    integer,
    decimal,
  } from "@happyvertical/smrt-core";

  @smrt()
  class Product extends SmrtObject {
    name = text({ required: true });
    quantity = integer();
    price = decimal();
  }
  ```

  ### After (Decorators)

  ```typescript
  import { SmrtObject, smrt, field } from "@happyvertical/smrt-core";

  @smrt()
  class Product extends SmrtObject {
    @field({ required: true })
    name: string = "";

    quantity: number = 0; // INTEGER
    price: number = 0.0; // DECIMAL
  }
  ```

  ## 💥 BREAKING CHANGES

  **Field helpers have been completely removed:**

  - ❌ `text()`, `integer()`, `decimal()`, `boolean()`, `datetime()`, `json()` - DELETED
  - ❌ `import { text } from '@happyvertical/smrt-core/fields'` - Will throw error
  - ✅ Use `@field()` decorator or plain TypeScript properties instead

  **Why this is better:**

  - 🧹 **Cleaner codebase** - Removed 20KB+ of legacy code
  - 🚀 **Better performance** - No Field instance overhead
  - 🤖 **AI-friendly** - Less noise, clearer patterns for agentic coders
  - 📚 **Simpler mental model** - One way to define fields, not two

  ## 📖 Documentation

  All framework documentation has been updated to show decorators as the primary pattern, with field helpers documented as a legacy alternative.

  See [CLAUDE.md](./CLAUDE.md) for complete migration guide and best practices.

### Patch Changes

- @happyvertical/smrt-config@0.15.0
- @happyvertical/smrt-types@0.15.0

## 0.14.7

### Patch Changes

- @happyvertical/smrt-config@0.14.7
- @happyvertical/smrt-types@0.14.7

## 0.14.6

### Patch Changes

- @happyvertical/smrt-config@0.14.6
- @happyvertical/smrt-types@0.14.6

## 0.14.5

### Patch Changes

- @happyvertical/smrt-config@0.14.5
- @happyvertical/smrt-types@0.14.5

## 0.14.4

### Patch Changes

- 5435c00: - fix(core): enable preserveModules to match package.json exports
  - @happyvertical/smrt-config@0.14.4
  - @happyvertical/smrt-types@0.14.4

## 0.14.3

### Patch Changes

- f0051a4: - fix(core): enable preserveModules to match package.json exports
  - @happyvertical/smrt-config@0.14.3
  - @happyvertical/smrt-types@0.14.3

## 0.14.2

### Patch Changes

- dedf98e: - fix(ci): add 30-second delay before enabling auto-merge on version PR
- Updated dependencies [dedf98e]
  - @happyvertical/smrt-config@0.14.2
  - @happyvertical/smrt-types@0.14.2

## 0.14.1

### Patch Changes

- 294e58f: - fix(core): use sync config accessor instead of async loadConfig
  - @happyvertical/smrt-config@0.14.1
  - @happyvertical/smrt-types@0.14.1

## 0.14.0

### Minor Changes

- c45b560: - feat(all): implement multi-level class inheritance support (#247)

### Patch Changes

- Updated dependencies [c45b560]
  - @happyvertical/smrt-config@0.14.0
  - @happyvertical/smrt-types@0.14.0

## 0.13.7

### Patch Changes

- febac3c: - chore(core): update SDK dependency and remove DuckDB workaround
  - fix(core): implement lazy database table initialization to prevent prerendering crashes
  - fix(ci): resolve issue triage authentication error
- Updated dependencies [febac3c]
  - @happyvertical/smrt-types@0.13.7

## 0.13.6

### Patch Changes

- 5160664: - fix(ci): resolve issue triage authentication error
- Updated dependencies [5160664]
  - @happyvertical/smrt-types@0.13.6

## 0.13.5

### Patch Changes

- 7706d2b: Fix TypeScript build errors preventing successful compilation

  - **core**: Add explicit return type to `mockCollectionConstructors` method to resolve vitest type inference error
  - **smrt-dev-mcp**: Use type assertions for MCP tool arguments and remove unused variable
  - **assets**: Correct parameter order in `db.upsert` call (unique columns before data)
  - @happyvertical/smrt-types@0.13.5

## 0.13.4

### Patch Changes

- 3f46832: - chore(all): update @happyvertical dependencies
- Updated dependencies [3f46832]
  - @happyvertical/smrt-types@0.13.4

## 0.13.3

### Patch Changes

- @happyvertical/smrt-types@0.13.3

## 0.13.2

### Patch Changes

- e7fc0d0: - chore(all): update @happyvertical dependencies
- Updated dependencies [e7fc0d0]
  - @happyvertical/smrt-types@0.13.2

## 0.13.1

### Patch Changes

- @happyvertical/smrt-types@0.13.1

## 0.13.0

### Minor Changes

- 8b35bce: - feat(all): save aggregated manifest for CLI discovery (#215)

### Patch Changes

- f620cd9: fix(core): pass manifest object name to ObjectRegistry.register()

  Fixes method discovery by ensuring the registry uses the correct manifest key when looking up methods. Previously, `ObjectRegistry.register(Praeco)` used `Praeco.name` ('Praeco' with capital P) to discover manifest, but the manifest stores entries under lowercase keys like 'praeco'. This caused method lookup to fail and prevented custom CLI commands from being generated.

  Now the consumer plugin generates: `ObjectRegistry.register(Praeco, { name: 'praeco' })`

  This ensures `getMethods('praeco')` succeeds and CLI commands like `npx smrt praeco:research` are generated correctly.

- Updated dependencies [8b35bce]
  - @happyvertical/smrt-types@0.13.0

## 0.12.0

### Minor Changes

- 6d80cc4: - test(all): remove flaky default export test (#215)
  - feat(all): integrate dynamic class loader into CLI (#215)
  - feat(all): add dynamic class loader for external packages (#215)
  - feat(all): update consumer plugin to preserve package metadata (#215)
  - feat(all): enhance manifest schema with package metadata (#215)

### Patch Changes

- Updated dependencies [6d80cc4]
  - @happyvertical/smrt-types@0.12.0

## 0.11.1

### Patch Changes

- 538c597: - fix(all): use GH_TOKEN for package access in cascade workflow
- Updated dependencies [538c597]
  - @happyvertical/smrt-types@0.11.1

## 0.11.0

### Minor Changes

- 4bf5d82: - feat(all): add automated dependency cascade workflow

### Patch Changes

- Updated dependencies [4bf5d82]
  - @happyvertical/smrt-types@0.11.0

## 0.10.4

### Patch Changes

- 192a86f: test: add comprehensive tests for issue #208 with JSON, SQLite, and DuckDB adapters
  - @happyvertical/smrt-types@0.10.4

## 0.10.3

### Patch Changes

- 2e5cab1: - fix(core): handle undefined values in optional fields to prevent database errors
  - @happyvertical/smrt-types@0.10.3

## 0.10.2

### Patch Changes

- b3be399: - fix(all): exclude protected and private properties from database schema
- Updated dependencies [b3be399]
  - @happyvertical/smrt-types@0.10.2

## 0.10.1

### Patch Changes

- be1be8f: - fix(core): use SQL standard TIMESTAMP for DuckDB compatibility
  - @happyvertical/smrt-types@0.10.1

## 0.10.0

### Minor Changes

- c6d8f52: - feat(ci): add auto-update workflow to prevent PR conflicts

### Patch Changes

- Updated dependencies [c6d8f52]
  - @happyvertical/smrt-types@0.10.0

## 0.9.0

### Minor Changes

- 85c671b: - feat(ci): add auto-update workflow to prevent PR conflicts

### Patch Changes

- Updated dependencies [85c671b]
  - @happyvertical/smrt-types@0.9.0

## 0.8.1

### Patch Changes

- fb98c3a: - fix(cli,core): enable collection constructor discovery for bundled code
  - @happyvertical/smrt-types@0.8.1

## 0.8.0

### Patch Changes

- @happyvertical/smrt-types@0.8.0

## 0.7.0

### Minor Changes

- 51c388a: - feat(generators): expose custom methods by default without explicit include
  - fix(cli): load manifest at runtime to populate ObjectRegistry

### Patch Changes

- Updated dependencies [51c388a]
  - @happyvertical/smrt-types@0.7.0

## 0.6.0

### Minor Changes

- 7c1de77: - feat(core): add getMethods() API to ObjectRegistry for custom method discovery

  - feat(cli): automatically discover and generate CLI commands for custom methods defined on SMRT objects

  Custom methods defined on SMRT objects are now automatically discovered at build time and exposed through the CLI generator. This eliminates the need for manual CLI command configuration for custom methods.

  Example:

  ```typescript
  @smrt({ cli: { include: ["list", "get", "research"] } })
  class Agent extends SmrtObject {
    async research(options: { query: string; depth?: number }) {
      // Custom method automatically gets CLI command:
      // smrt agent:research <id> --query "topic" --depth 5
    }
  }
  ```

### Patch Changes

- f0d34b0: - docs(all): add comprehensive custom method discovery documentation
- Updated dependencies [f0d34b0]
- Updated dependencies [7c1de77]
  - @happyvertical/smrt-types@0.5.5

## 0.5.7

### Patch Changes

- f9019e6: - fix(scanner): use project tsconfig.json for proper module resolution
- Updated dependencies [f9019e6]
  - @happyvertical/smrt-types@0.5.4

## 0.5.6

### Patch Changes

- 708a6ab: - fix(core): resolve circular dependency in getPackageName

## 0.5.5

### Patch Changes

- 694e1da: - fix(manifest): capture package name during registration for external packages
- Updated dependencies [694e1da]
  - @happyvertical/smrt-types@0.5.3

## 0.5.4

### Patch Changes

- 1129a5a: fix(manifest): complete external package manifest loading

  - Check both src/manifest/test-manifest.json and dist/manifest.json for built packages
  - Use createRequire(process.cwd()) to resolve packages from calling app's context
  - Walk up from package main entry to find package.json and load manifest
  - Fixes manifest loading for external dependencies (e.g., @happyvertical/smrt-events)

  Resolves #159

## 0.5.3

### Patch Changes

- Updated dependencies [b1c4faa]
  - @happyvertical/smrt-types@0.5.2

## 0.5.2

### Patch Changes

- 905bdf4: - fix(scanner): use project tsconfig.json for proper module resolution
- Updated dependencies [905bdf4]
  - @happyvertical/smrt-types@0.5.1

## 0.5.1

### Patch Changes

- 3663a95: - fix(core): resolve manifest loading issues with published packages

## 0.5.0

### Minor Changes

- 007567e: - feat(all): add local SDK development setup scripts

### Patch Changes

- 6d322c8: - fix(core): increase timeout for LRU cache eviction test
- Updated dependencies [007567e]
  - @happyvertical/smrt-types@0.5.0

## 0.4.2

### Patch Changes

- dfce003: Enable GitHub Package Registry publishing for all SMRT packages

  - Add @happyvertical scope to .npmrc for GitHub Package Registry
  - Configure authentication with GITHUB_TOKEN
  - All packages now publish to https://npm.pkg.github.com/@happyvertical/*

- Updated dependencies [dfce003]
  - @happyvertical/smrt-types@0.4.2
