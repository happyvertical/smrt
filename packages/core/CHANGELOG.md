# @happyvertical/smrt-core

## 0.27.25

### Patch Changes

- ### Features

  - typography design-token ratchet + smrt-svelte migration (#1373) (#1462) (tooling)
  - @happyvertical/smrt-scanner@0.27.25
  - @happyvertical/smrt-config@0.27.25
  - @happyvertical/smrt-types@0.27.25

## 0.27.24

### Patch Changes

- ### Features

  - elevation design-token ratchet (#1373) (#1461) (tooling)
  - @happyvertical/smrt-scanner@0.27.24
  - @happyvertical/smrt-config@0.27.24
  - @happyvertical/smrt-types@0.27.24

## 0.27.23

### Patch Changes

- ### Other Changes

  - refactor: snap border-radius to --smrt-radius-\* across UI packages (S1 #1373) (#1459)
  - @happyvertical/smrt-scanner@0.27.23
  - @happyvertical/smrt-config@0.27.23
  - @happyvertical/smrt-types@0.27.23

## 0.27.22

### Patch Changes

- ### Other Changes

  - refactor: snap spacing px to --smrt-spacing-\* across UI packages (S1 #1373 phase 2) (#1457)
  - @happyvertical/smrt-scanner@0.27.22
  - @happyvertical/smrt-config@0.27.22
  - @happyvertical/smrt-types@0.27.22

## 0.27.21

### Patch Changes

- ### Other Changes

  - refactor: snap spacing px to --smrt-spacing-\* + ratchet (S1 #1373 phase 1) (#1451) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.27.21
  - @happyvertical/smrt-config@0.27.21
  - @happyvertical/smrt-types@0.27.21

## 0.27.20

### Patch Changes

- ### Other Changes

  - refactor: adopt --smrt-z-index-\* scale across UI packages (S1 #1373 phase 2) (#1450)
  - @happyvertical/smrt-scanner@0.27.20
  - @happyvertical/smrt-config@0.27.20
  - @happyvertical/smrt-types@0.27.20

## 0.27.19

### Patch Changes

- ### Other Changes

  - refactor: adopt --smrt-z-index-\* scale + add z-index ratchet (#1373) (#1449) (smrt-svelte)
  - refactor: close out S1 — tokenize tail + scope the ratchet (#1373) (#1448)
  - @happyvertical/smrt-scanner@0.27.19
  - @happyvertical/smrt-config@0.27.19
  - @happyvertical/smrt-types@0.27.19

## 0.27.18

### Patch Changes

- ### Other Changes

  - refactor: tokenize color literals in assets/chat/images (S1 #1373 phase 3) (#1447)
  - chore: sync sdk packages to v0.74.4 (#1436) (deps)
  - @happyvertical/smrt-scanner@0.27.18
  - @happyvertical/smrt-config@0.27.18
  - @happyvertical/smrt-types@0.27.18

## 0.27.17

### Patch Changes

- ### Other Changes

  - refactor: tokenize color literals (S1 #1373 phase 2) (#1445) (products)
  - refactor: tokenize color literals + flip to strict (S1 #1373 phase 2) (#1446) (content)
  - @happyvertical/smrt-scanner@0.27.17
  - @happyvertical/smrt-config@0.27.17
  - @happyvertical/smrt-types@0.27.17

## 0.27.16

### Patch Changes

- ### Other Changes

  - refactor: tokenize color literals + color-literal ratchet (S1 #1373 phase 1) (#1443) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.27.16
  - @happyvertical/smrt-config@0.27.16
  - @happyvertical/smrt-types@0.27.16

## 0.27.15

### Patch Changes

- ### Bug Fixes

  - stop SSG export leaking camelCase/snake_case secrets (#1441) (config)
  - @happyvertical/smrt-scanner@0.27.15
  - @happyvertical/smrt-config@0.27.15
  - @happyvertical/smrt-types@0.27.15

## 0.27.14

### Patch Changes

- ### Other Changes

  - refactor: logging ratchet scaffolding + core runtime migration (S14 #1432 phase 1) (#1438) (core)
  - @happyvertical/smrt-scanner@0.27.14
  - @happyvertical/smrt-config@0.27.14
  - @happyvertical/smrt-types@0.27.14

## 0.27.13

### Patch Changes

- ### Other Changes

  - build: typecheck script rollout + turbo typecheck gate (#1375) (#1437) (repo)
  - @happyvertical/smrt-scanner@0.27.13
  - @happyvertical/smrt-config@0.27.13
  - @happyvertical/smrt-types@0.27.13

## 0.27.12

### Patch Changes

- ### Bug Fixes

  - preserve tenant scoped uuid metadata (#1439) (scanner)
  - @happyvertical/smrt-scanner@0.27.12
  - @happyvertical/smrt-config@0.27.12
  - @happyvertical/smrt-types@0.27.12

## 0.27.11

### Patch Changes

- ### Merged Changes

  - [codex] add SMRT subscriptions package
  - @happyvertical/smrt-scanner@0.27.11
  - @happyvertical/smrt-config@0.27.11
  - @happyvertical/smrt-types@0.27.11

## 0.27.10

### Patch Changes

- ### Bug Fixes

  - emit consumed design tokens so themes resolve (#1431) (#1434) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.27.10
  - @happyvertical/smrt-config@0.27.10
  - @happyvertical/smrt-types@0.27.10

## 0.27.9

### Patch Changes

- ### Other Changes

  - docs: add dim-9 logging enforcement ratchet (noConsole) (#1433) (rubric)
  - @happyvertical/smrt-scanner@0.27.9
  - @happyvertical/smrt-config@0.27.9
  - @happyvertical/smrt-types@0.27.9

## 0.27.8

### Patch Changes

- ### Bug Fixes

  - preserve text id fallback schemas (core)
  - tighten uuid text schema drift handling (core)
  - raise vitest hookTimeout to 30s to match testTimeout (smrt-svelte)
  - surface tenant UUID upgrade blockers (cli)

  ### Other Changes

  - test: expect uuid tenant schema metadata (dev-mcp)
  - @happyvertical/smrt-scanner@0.27.8
  - @happyvertical/smrt-config@0.27.8
  - @happyvertical/smrt-types@0.27.8

## 0.27.7

### Patch Changes

- ### Other Changes

  - docs: reconcile production readiness rubric with standards docs
  - docs: ratify production readiness rubric for stabilization epic
  - @happyvertical/smrt-scanner@0.27.7
  - @happyvertical/smrt-config@0.27.7
  - @happyvertical/smrt-types@0.27.7

## 0.27.6

### Patch Changes

- ### Bug Fixes

  - align token fallbacks, fix DataTable color-var cluster (smrt-svelte)
  - tokenize focus rings/scrim, fix broken token vars (smrt-svelte)
  - @happyvertical/smrt-scanner@0.27.6
  - @happyvertical/smrt-config@0.27.6
  - @happyvertical/smrt-types@0.27.6

## 0.27.5

### Patch Changes

- ### Bug Fixes

  - address key drift review feedback (secrets)
  - diagnose tenant key drift (secrets)
  - @happyvertical/smrt-scanner@0.27.5
  - @happyvertical/smrt-config@0.27.5
  - @happyvertical/smrt-types@0.27.5

## 0.27.4

### Patch Changes

- ### Features

  - release smrt dev mcp project tools
  - @happyvertical/smrt-scanner@0.27.4
  - @happyvertical/smrt-config@0.27.4
  - @happyvertical/smrt-types@0.27.4

## 0.27.3

### Patch Changes

- ### Features

  - add downstream domain knowledge artifacts

  ### Bug Fixes

  - address domain knowledge review feedback
  - @happyvertical/smrt-scanner@0.27.3
  - @happyvertical/smrt-config@0.27.3
  - @happyvertical/smrt-types@0.27.3

## 0.27.2

### Patch Changes

- ### Bug Fixes

  - recognize SmrtJunction in manifest test-db detector (#1342) (vitest)
  - treat SmrtJunction collections as collections in schema gen (core)
  - @happyvertical/smrt-scanner@0.27.2
  - @happyvertical/smrt-config@0.27.2
  - @happyvertical/smrt-types@0.27.2

## 0.27.1

### Patch Changes

- ### Features

  - ship smrt review agent skill (dev-mcp)
  - route public surface review findings (dev-mcp)
  - enforce knowledge hooks (dev-mcp)
  - enrich deterministic agent outputs (dev-mcp)
  - build knowledge foundation (dev-mcp)

  ### Bug Fixes

  - address review feedback (smrt-dev-mcp)

  ### Other Changes

  - docs: document model-assisted workflow (dev-mcp)
  - test: add stdio smoke coverage (dev-mcp)
  - @happyvertical/smrt-scanner@0.27.1
  - @happyvertical/smrt-config@0.27.1
  - @happyvertical/smrt-types@0.27.1

## 1.0.0

### Minor Changes

- ### Breaking Changes

  - enforce tenant isolation on relationship loaders (core)
  - ObjectRegistry inheritance/STI lookups return qualified names (R5-canon main) (core)
  - split Folder + rename Asset.parentId (R3-D) (assets,folders)
  - introduce SmrtJunction base; rename junction surface (R2) (core)

  ### Features

  - extract SmrtPolymorphicAssociation base from AssetAssociation (core)
  - generate child accessors for @oneToMany relationships (R10) (core)
  - emit uuid ids and relationship columns (core)
  - add UUID abstract column type + differ text<->uuid tolerance (R11) (core)
  - complete FK declaration sweep across remaining domain packages (R1) (models)
  - declare remaining FK relationships across domain packages (R1) (models)
  - declare FK relationships on chat models (R1) (chat)
  - adopt @crossPackageRef on cross-package FKs (R1) (ads,affiliates,commerce)
  - stamp qualified name on registered constructors (R5-canon prep) (core)
  - rename Fact.parentId → previousFactId (R3-C) (facts)
  - migrate Tag to SmrtHierarchical (R3-B) (tags)
  - SmrtHierarchical base class + Place/Event/Account/Zone migrations (R3-A) (core)
  - manyToMany eager load + indexed meta fields (R6, R9) (core)
  - add @crossPackageRef for typed cross-package references (R1) (core)

  ### Bug Fixes

  - warn when db:migrate-uuid manifest discovery is partial (cli)
  - gate db:migrate-uuid conversion on declared-UUID schema + share one transaction (cli)
  - chunk getDescendants frontier to stay under SQLITE_MAX_VARIABLE_NUMBER (core)
  - coerce empty-string FK values to NULL for uuid columns + 0.27 upgrade guide (core)
  - differ/migrate parity + type-upgrade safety + diverse-schema fixture suite (#1336) (core)
  - break FK cycles in migration ordering (#1333) (#1334) (core)
  - consumer registry drops plain fields from external package schemas (#1331) (#1332) (core)
  - guard markPaid on price-lock expiry; carry payment tenant onto payouts (commerce)
  - reconcile differ ADD COLUMN + tracker engine type post-merge (core)
  - let hydrate() lazy-load errors propagate instead of nulling (core)
  - surface real hydrate() failures, not just missing targets (core)
  - harden SmrtPolymorphicAssociation per review (core)
  - sync committed manifest with @oneToMany foreignKey hints (profiles)
  - prefer exact-self inverse FK over ancestor fallback (core)
  - never retry TenantIsolationError; clarify loader JSDoc (core)
  - throw on invalid explicit foreignKey in eager oneToMany loader (core)
  - resolve inherited oneToMany accessors on STI subclasses (core)
  - address uuid schema review findings (core)
  - declare Asset.primaryVersionId self-referential FK (R1 round-4) (assets)
  - declare SmrtJobEvent.jobId FK to SmrtJob (R1 round-3) (jobs)
  - round-2 FK fixups + video cross-pkg decorator correction (R1) (models)
  - gate unscoped-alias inclusion to default-context merges only (tags)
  - include unscoped aliases when merging default-context tags (tags)
  - route getSTIHierarchyMembers through qualified name (Copilot) (core)
  - scope mergeTag alias migration to the resolved context (tags)
  - apply the manifest extends revert that round-6 commit missed (tags)
  - round-6 review fixups — revert two wrong round-5 patches
  - round-5 codex findings — qualified Asset lookup + tag manifest extends
  - round-5 review fixups for R5-canon followup
  - round-4 review fixups for R5-canon followup + R3-B mergeTag cycle
  - qualified-name lookups in collection.ts + schema-builder.ts (R5-canon round-3) (core)
  - round-2 review fixups for R5-canon (core)
  - round-1 review fixups for R5-canon (core,cli,agents)
  - resolve Copilot review findings on R3-D (assets)
  - align getEvolutionTree docstring with the iterative BFS impl (facts)
  - resolve Copilot review findings on R3-A follow-up (core)
  - resolve Copilot review findings on R3-B (tags)
  - drop leftover R3-A changeset to unblock auto-generation (core)
  - drop manual changeset (tags)
  - tighten round-3 ordering test + drop manual changeset (assets)
  - drop manual changeset (facts)
  - complete STI disambiguation via prototype-chain walk + drop manual changeset (core)
  - preserve folder slug context across migration (R3-D round-5) (assets)
  - route Asset.getSource/getDerivatives through the collection (R3-D round-4) (assets)
  - R3-D round-3 review — context column + tree ordering (assets)
  - preserve FolderCollection.getTree sub-tree ordering (R3-D round-2) (assets)
  - address R3-D codex review findings (core,assets)
  - hasPredecessor handles null previousFactId (R3-C round 2) (facts)
  - SmrtHierarchical qualified-name resolution + browser export (R3-A follow-up) (core)
  - R3-B round-2 review fixups (tags)
  - address R3-B review findings (tags)
  - address R3-A review findings (places,events)
  - recognize SmrtJunction at scan time + runtime guard (R2 round-9) (core)
  - expose ContentReferences.attach over REST (R2 round-8) (content)
  - don't let collection @smrt() config clobber item-class api (R2 round-7)
  - register undecorated SmrtJunction subclasses in the manifest (R2 round-6)
  - setLinks must strip rightField from snapshot opts (R2 round-5) (core,assets)
  - defend junction key fields against opts override (R2 round-4) (core,assets)
  - restore ContentReferences attach idempotency (R2 round-3) (content)
  - use positionField in AssetAssociationCollection.setLinks (R2 round-3) (assets)
  - separate setLinks position field from sortField (R2 round-2) (core)
  - address codex P1/P2 findings on R2 junction refactor (core,content)
  - address review findings on Phase A additive batch (core)
  - correct Postgres index syntax + avoid jsonPath drift loop (core)
  - thread jsonPath through every index renderer (R9 follow-up) (core)
  - route crossPackageRef through public relationship APIs (core)

  ### Other Changes

  - test: align full-registry integration with R5-canon + #1334 cycle-breaking (core)
  - docs: correct loadRelated cross-tenant option name + hierarchical bind-count comment (core)
  - test: align getSTIBase assertions with R5-canon (commerce,products)
  - refactor: simplify SmrtHierarchical.\_hierarchyCollection (R5-canon main) (core)
  - chore: de-duplicate SmrtHierarchical browser-entry export (core)
  - chore: refresh auto-generated route handlers (formatter reflow) (content)
  - chore: bump line-length limits and relax footer-leading-blank (commitlint)

### Patch Changes

- @happyvertical/smrt-scanner@1.0.0
- @happyvertical/smrt-config@1.0.0
- @happyvertical/smrt-types@1.0.0

## 0.26.5

### Patch Changes

- ### Bug Fixes

  - handle collection item overrides (core)
  - resolve STI collection test schemas (core)
  - @happyvertical/smrt-scanner@0.26.5
  - @happyvertical/smrt-config@0.26.5
  - @happyvertical/smrt-types@0.26.5

## 0.26.4

### Patch Changes

- ### Bug Fixes

  - carry manifest collection on RegisteredClass for runtime consumers (core)
  - @happyvertical/smrt-scanner@0.26.4
  - @happyvertical/smrt-config@0.26.4
  - @happyvertical/smrt-types@0.26.4

## 0.26.3

### Patch Changes

- ### Features

  - reusable CLI factory (app-cli)

  ### Bug Fixes

  - address bot review threads on #1311 (app-cli)
  - round-4 review fixes (app-cli)
  - round-3 review fixes (app-cli)
  - round-2 review fixes (app-cli)
  - review-cycle fixes for #1311 (app-cli)

  ### Other Changes

  - chore: satisfy monorepo standards (repository, smrtVitestPlugin, fixed group) (app-cli)
  - chore: sync sdk packages to v0.74.3 (deps)
  - @happyvertical/smrt-scanner@0.26.3
  - @happyvertical/smrt-config@0.26.3
  - @happyvertical/smrt-types@0.26.3

## 0.26.2

### Patch Changes

- ### Features

  - tighten @smrt() decorator coherence checks (core)

  ### Bug Fixes

  - honor cli.exclude in lint + match runtime client filter in type decls (core)
  - @happyvertical/smrt-scanner@0.26.2
  - @happyvertical/smrt-config@0.26.2
  - @happyvertical/smrt-types@0.26.2

## 0.26.1

### Patch Changes

- ### Features

  - add BackfillTracker and migrateSmrtSchemas orchestration (core)

  ### Bug Fixes

  - guard listApplied against unparseable applied_at timestamps (core)
  - API consistency, optional version, runIfPending discriminator, test tightening (core)
  - route REINDEX CONCURRENTLY outside tx planner (core)
  - memoize initialize() promise to remove TOCTOU race (core)
  - tighten engineHint type + add hasManualDrift convenience + block-comment defense (core)
  - surface unactionable schema drift + drop comment-only DDL (core)
  - align SchemaComparer engine introspection (core)
  - thread engineHint through differ/tracker + forward tracker timeouts (core)
  - resolve migration orchestration review threads (core)
  - harden migrateSmrtSchemas engine detection + document preview scope (core)
  - address PR #1300 automated review findings (core)
  - @happyvertical/smrt-scanner@0.26.1
  - @happyvertical/smrt-config@0.26.1
  - @happyvertical/smrt-types@0.26.1

## 1.0.0

### Minor Changes

- ### Breaking Changes

  - pin ContentReference targetVersion for drift detection (content)

  ### Features

  - rate-limit failed terminal-auth approval attempts per user (users)
  - terminal device-code auth + app-runtime MCP scaffolding (users,smrt-app-mcp)

  ### Bug Fixes

  - address PR review feedback (content)
  - address PR #1299 automated review findings (users,smrt-app-mcp)
  - satisfy monorepo standards (vitest plugin + changeset group) (smrt-app-mcp)

  ### Other Changes

  - docs: clarify drift detection scope and panel rendering (content)
  - refactor: remove /cli subpath — relocates to smrt-app-cli (smrt-app-mcp)

### Patch Changes

- @happyvertical/smrt-scanner@1.0.0
- @happyvertical/smrt-config@1.0.0
- @happyvertical/smrt-types@1.0.0

## 0.25.20

### Patch Changes

- @happyvertical/smrt-config@0.25.20
- @happyvertical/smrt-types@0.25.20
- @happyvertical/smrt-scanner@0.25.20

## 0.25.19

### Patch Changes

- @happyvertical/smrt-config@0.25.19
- @happyvertical/smrt-types@0.25.19
- @happyvertical/smrt-scanner@0.25.19

## 0.25.18

### Patch Changes

- ### Bug Fixes

  - implement minor smrt fixup batch
  - @happyvertical/smrt-scanner@0.25.18
  - @happyvertical/smrt-config@0.25.18
  - @happyvertical/smrt-types@0.25.18

## 0.25.17

### Patch Changes

- ### Features

  - add LicenseSale Contract STI subtype (commerce)
  - add Payout model for operator-to-supplier remittance (commerce)
  - add PaymentIntent model with multi-option semantics (commerce)
  - extend Payment with backend identity and USD-drift fields (commerce)
  - add Vendor.payoutAddresses per-currency map (commerce)

  ### Bug Fixes

  - address commerce marketplace review comments

  ### Other Changes

  - docs: document marketplace phase 1 additions (commerce)
  - @happyvertical/smrt-scanner@0.25.17
  - @happyvertical/smrt-config@0.25.17
  - @happyvertical/smrt-types@0.25.17

## 0.25.16

### Patch Changes

- ### Features

  - new package for BOM cost rollup and production (smrt-manufacturing)
  - new package for multi-location stock tracking (smrt-inventory)
  - pre-wire session + subdomain tenancy (template-sveltekit)
  - add navTreeFromManifest helper (smrt-svelte)
  - add WholesaleOrder, ProductionOrder, Cart STI subtypes (smrt-commerce)
  - tenancy + generic STI subtypes (smrt-products)

  ### Bug Fixes

  - mark Sku.productId as required (products)
  - address round-13 codex findings (review)
  - resolve three more Copilot inline comments (review)
  - resolve two new Copilot inline comments (review)
  - address round-12 code review findings (review)
  - resolve Copilot inline review comments (review)
  - address round-10 (final) code review findings (review)
  - address round-9 code review findings (review)
  - address round-8 code review findings (review)
  - address round-7 code review findings (review)
  - address round-6 code review findings (review)
  - address round-5 code review findings (review)
  - address round-4 code review findings (review)
  - make stock + production mutations transactional (inventory,manufacturing)
  - address round-3 code review findings (review)
  - address round-2 code review findings (review)
  - address phase 1 code review findings (review)
  - route around NULL conflict column UPSERT collision (#1246) (smrt-core)

  ### Other Changes

  - refactor: make dispatch-handler warns name the failure (manufacturing)
  - docs: correct "all five models" wording after Sku move (inventory)
  - ci: install commitlint from public npm directly (commitlint)
  - chore: regenerate pnpm-lock.yaml after catalog and overrides bump
  - ci: lint commit messages with workspace commitlint v20
  - chore: align pnpm.overrides at 0.74 for SDK packages
  - chore: align sdk catalog at 0.74 and register new packages
  - refactor: move Sku to smrt-products (products,inventory)
  - refactor: consolidate variant axis declaration as ProductVariant (products,inventory)
  - chore: bump @happyvertical/sql to ^0.74.0 and remove NULL-conflict workaround (deps)
  - @happyvertical/smrt-scanner@0.25.16
  - @happyvertical/smrt-config@0.25.16
  - @happyvertical/smrt-types@0.25.16

## 0.25.15

### Patch Changes

- ### Bug Fixes

  - materialize tenant-scoped manifest columns

  ### Other Changes

  - test: allow atomic migration tests more time in ci
  - @happyvertical/smrt-scanner@0.25.15
  - @happyvertical/smrt-config@0.25.15
  - @happyvertical/smrt-types@0.25.15

## 0.25.14

### Patch Changes

- 3930b05: Fix PostgreSQL ADD COLUMN migrations for JSON defaults so array defaults render valid JSONB SQL.
  - @happyvertical/smrt-scanner@0.25.14
  - @happyvertical/smrt-config@0.25.14
  - @happyvertical/smrt-types@0.25.14

## 0.25.13

### Patch Changes

- ### Bug Fixes

  - resolve atomic review followups (migrations)
  - address atomic review feedback (migrations)
  - apply schema batches atomically (migrations)
  - @happyvertical/smrt-scanner@0.25.13
  - @happyvertical/smrt-config@0.25.13
  - @happyvertical/smrt-types@0.25.13

## 0.25.12

### Patch Changes

- ### Bug Fixes

  - address contribution form review (content)
  - add native contribution form contracts (content)
  - @happyvertical/smrt-scanner@0.25.12
  - @happyvertical/smrt-config@0.25.12
  - @happyvertical/smrt-types@0.25.12

## 0.25.11

### Patch Changes

- ### Bug Fixes

  - harden smrt migrations (cli)
  - @happyvertical/smrt-scanner@0.25.11
  - @happyvertical/smrt-config@0.25.11
  - @happyvertical/smrt-types@0.25.11

## 0.25.10

### Patch Changes

- ### Features

  - add OIDC login flow (users)

  ### Bug Fixes

  - encode OIDC basic auth credentials (users)
  - @happyvertical/smrt-scanner@0.25.10
  - @happyvertical/smrt-config@0.25.10
  - @happyvertical/smrt-types@0.25.10

## 0.25.9

### Patch Changes

- ### Bug Fixes

  - keep contribution workflow status separate from intake decision (content)
  - @happyvertical/smrt-scanner@0.25.9
  - @happyvertical/smrt-config@0.25.9
  - @happyvertical/smrt-types@0.25.9

## 0.25.8

### Patch Changes

- ### Other Changes

  - ci: add svelte-check typechecks (svelte)
  - @happyvertical/smrt-scanner@0.25.8
  - @happyvertical/smrt-config@0.25.8
  - @happyvertical/smrt-types@0.25.8

## 0.25.7

### Patch Changes

- ### Features

  - add dock availability gate composer (server-side) (smrt-svelte)

  ### Bug Fixes

  - self-map TCtx constraint and strict-true gate evaluation (smrt-svelte)
  - address gate composer review feedback (smrt-svelte)
  - @happyvertical/smrt-scanner@0.25.7
  - @happyvertical/smrt-config@0.25.7
  - @happyvertical/smrt-types@0.25.7

## 0.25.6

### Patch Changes

- ### Bug Fixes

  - avoid postgres bootstrap transaction abort (core)
  - @happyvertical/smrt-scanner@0.25.6
  - @happyvertical/smrt-config@0.25.6
  - @happyvertical/smrt-types@0.25.6

## 0.25.5

### Patch Changes

- ### Features

  - land deferred workspace ergonomics (typed context, granular events) (smrt-svelte)

  ### Bug Fixes

  - parameterize ToolsDockApi generics for typed dock.setContext (smrt-svelte)
  - repair ToolDef.component and TActions typing for typed tool patterns (smrt-svelte)
  - @happyvertical/smrt-scanner@0.25.5
  - @happyvertical/smrt-config@0.25.5
  - @happyvertical/smrt-types@0.25.5

## 0.25.4

### Patch Changes

- ### Features

  - add RoleShell primitive for multi-role admin shells (smrt-svelte)

  ### Bug Fixes

  - default breadcrumb startAfter to role id and propagate collapsed to NavTree (smrt-svelte)
  - address RoleShell review feedback (smrt-svelte)
  - @happyvertical/smrt-scanner@0.25.4
  - @happyvertical/smrt-config@0.25.4
  - @happyvertical/smrt-types@0.25.4

## 0.25.3

### Patch Changes

- ### Features

  - add ToolDef iconComponent and dock.refreshAvailability (smrt-svelte)

  ### Bug Fixes

  - address iconComponent + refreshAvailability review feedback (smrt-svelte)
  - @happyvertical/smrt-scanner@0.25.3
  - @happyvertical/smrt-config@0.25.3
  - @happyvertical/smrt-types@0.25.3

## 0.25.2

### Patch Changes

- ### Features

  - add ToolsDock 'change' event and bindable mobileNavOpen (smrt-svelte)

  ### Bug Fixes

  - address ToolsDock change-event review feedback (smrt-svelte)

  ### Other Changes

  - refactor: namespace dock events with 'dock:' prefix (smrt-svelte)
  - @happyvertical/smrt-scanner@0.25.2
  - @happyvertical/smrt-config@0.25.2
  - @happyvertical/smrt-types@0.25.2

## 0.25.1

### Patch Changes

- ### Features

  - add ToolsDock system (smrt-svelte)
  - add WorkspaceShell primitive (smrt-svelte)
  - add NavTree and Breadcrumbs primitives (smrt-svelte)

  ### Bug Fixes

  - address Copilot review comments on workspace primitives (smrt-svelte)
  - address ToolsDock review findings (smrt-svelte)
  - address WorkspaceShell review findings (smrt-svelte)
  - address NavTree + Breadcrumbs review findings (smrt-svelte)

  ### Other Changes

  - chore: scaffold workspace primitives directory + shared types (smrt-svelte)
  - @happyvertical/smrt-scanner@0.25.1
  - @happyvertical/smrt-config@0.25.1
  - @happyvertical/smrt-types@0.25.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-config@1.0.0
- @happyvertical/smrt-types@1.0.0
- @happyvertical/smrt-scanner@1.0.0

## 0.24.17

### Patch Changes

- ### Other Changes

  - chore: sync sdk packages to v0.73.4 (#1188) (deps)
  - @happyvertical/smrt-scanner@0.24.17
  - @happyvertical/smrt-config@0.24.17
  - @happyvertical/smrt-types@0.24.17

## 0.24.16

### Patch Changes

- ### Merged Changes

  - [codex] Harden content editor assistant chat
  - @happyvertical/smrt-scanner@0.24.16
  - @happyvertical/smrt-config@0.24.16
  - @happyvertical/smrt-types@0.24.16

## 0.24.15

### Patch Changes

- ### Merged Changes

  - [codex] Skip object registration for collection entries
  - @happyvertical/smrt-scanner@0.24.15
  - @happyvertical/smrt-config@0.24.15
  - @happyvertical/smrt-types@0.24.15

## 0.24.14

### Patch Changes

- ### Bug Fixes

  - reset governance tool state on content changes (#1223) (content)
  - @happyvertical/smrt-scanner@0.24.14
  - @happyvertical/smrt-config@0.24.14
  - @happyvertical/smrt-types@0.24.14

## 0.24.13

### Patch Changes

- ### Features

  - expose governance dock tools (#1220) (content)
  - @happyvertical/smrt-scanner@0.24.13
  - @happyvertical/smrt-config@0.24.13
  - @happyvertical/smrt-types@0.24.13

## 0.24.12

### Patch Changes

- ### Bug Fixes

  - resolve ESM-only scanner package (#1219) (core)
  - @happyvertical/smrt-scanner@0.24.12
  - @happyvertical/smrt-config@0.24.12
  - @happyvertical/smrt-types@0.24.12

## 0.24.11

### Patch Changes

- @happyvertical/smrt-config@0.24.11
- @happyvertical/smrt-types@0.24.11
- @happyvertical/smrt-scanner@0.24.11

## 0.24.10

### Patch Changes

- ### Other Changes

  - chore: Tooling/Templates packages Phase 2 alignment (epic #1191, category #1216) (#1217)
  - @happyvertical/smrt-scanner@0.24.10
  - @happyvertical/smrt-config@0.24.10
  - @happyvertical/smrt-types@0.24.10

## 0.24.9

### Patch Changes

- ### Other Changes

  - chore: Business packages Phase 2 alignment (epic #1191, category #1214) (#1215)
  - @happyvertical/smrt-scanner@0.24.9
  - @happyvertical/smrt-config@0.24.9
  - @happyvertical/smrt-types@0.24.9

## 0.24.8

### Patch Changes

- ### Other Changes

  - chore: Content & Media packages Phase 2 alignment (epic #1191, category #1212) (#1213)
  - @happyvertical/smrt-scanner@0.24.8
  - @happyvertical/smrt-config@0.24.8
  - @happyvertical/smrt-types@0.24.8

## 0.24.7

### Patch Changes

- ### Other Changes

  - chore: Domain packages Phase 2 alignment (epic #1191, category #1210) (#1211)
  - @happyvertical/smrt-scanner@0.24.7
  - @happyvertical/smrt-config@0.24.7
  - @happyvertical/smrt-types@0.24.7

## 0.24.6

### Patch Changes

- ### Other Changes

  - chore: Agents & Runtime packages Phase 2 alignment (epic #1191, category #1208) (#1209)
  - @happyvertical/smrt-scanner@0.24.6
  - @happyvertical/smrt-config@0.24.6
  - @happyvertical/smrt-types@0.24.6

## 0.24.5

### Patch Changes

- ### Other Changes

  - chore: Foundation packages Phase 2 alignment (epic #1191, category #1206) (#1207)
  - @happyvertical/smrt-scanner@0.24.5
  - @happyvertical/smrt-config@0.24.5
  - @happyvertical/smrt-types@0.24.5

## 0.24.4

### Patch Changes

- ### Other Changes

  - chore: cross-cutting standards remainder (CC-2/3/4/6) (#1205)
  - @happyvertical/smrt-scanner@0.24.4
  - @happyvertical/smrt-config@0.24.4
  - @happyvertical/smrt-types@0.24.4

## 0.24.3

### Patch Changes

- ### Features

  - add feed source imports (#1204) (content)
  - @happyvertical/smrt-scanner@0.24.3
  - @happyvertical/smrt-config@0.24.3
  - @happyvertical/smrt-types@0.24.3

## 0.24.2

### Patch Changes

- ### Other Changes

  - chore: monorepo standards alignment (epic #1191) (#1202)
  - @happyvertical/smrt-scanner@0.24.2
  - @happyvertical/smrt-config@0.24.2
  - @happyvertical/smrt-types@0.24.2

## 0.24.1

### Patch Changes

- ### Merged Changes

  - [codex] Export content editor building blocks
  - @happyvertical/smrt-scanner@0.24.1
  - @happyvertical/smrt-config@0.24.1
  - @happyvertical/smrt-types@0.24.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-config@1.0.0
- @happyvertical/smrt-types@1.0.0
- @happyvertical/smrt-scanner@1.0.0

## 0.23.12

### Patch Changes

- ### Merged Changes

  - Add content editor WYSIWYG body and assistant context
  - @happyvertical/smrt-scanner@0.23.12
  - @happyvertical/smrt-config@0.23.12
  - @happyvertical/smrt-types@0.23.12

## 0.23.11

### Patch Changes

- ### Features

  - add Garrula social primitives (#1186) (social)
  - @happyvertical/smrt-scanner@0.23.11
  - @happyvertical/smrt-config@0.23.11
  - @happyvertical/smrt-types@0.23.11

## 0.23.10

### Patch Changes

- ### Bug Fixes

  - align smrt package version (#1185) (prompts)
  - @happyvertical/smrt-scanner@0.23.10
  - @happyvertical/smrt-config@0.23.10
  - @happyvertical/smrt-types@0.23.10

## 0.23.9

### Patch Changes

- ### Merged Changes

  - Refactor QA content integration prompts
  - @happyvertical/smrt-scanner@0.23.9
  - @happyvertical/smrt-config@0.23.9
  - @happyvertical/smrt-types@0.23.9

## 0.23.8

### Patch Changes

- ### Features

  - add media bundle persistence helpers (#1182) (media)
  - @happyvertical/smrt-scanner@0.23.8
  - @happyvertical/smrt-config@0.23.8
  - @happyvertical/smrt-types@0.23.8

## 0.23.7

### Patch Changes

- ### Other Changes

  - chore: sync sdk packages to v0.73.1 (#1181) (deps)
  - @happyvertical/smrt-scanner@0.23.7
  - @happyvertical/smrt-config@0.23.7
  - @happyvertical/smrt-types@0.23.7

## 0.23.6

### Patch Changes

- ### Bug Fixes

  - serialize postgres system table bootstrap (#1173) (core)
  - @happyvertical/smrt-scanner@0.23.6
  - @happyvertical/smrt-config@0.23.6
  - @happyvertical/smrt-types@0.23.6

## 0.23.5

### Patch Changes

- ### Bug Fixes

  - publish CLAUDE.md to npm (#1179) (ledgers,smrt-svelte)
  - @happyvertical/smrt-scanner@0.23.5
  - @happyvertical/smrt-config@0.23.5
  - @happyvertical/smrt-types@0.23.5

## 0.23.4

### Patch Changes

- ### Bug Fixes

  - rename STI data repair flag (#1174) (cli)
  - @happyvertical/smrt-scanner@0.23.4
  - @happyvertical/smrt-config@0.23.4
  - @happyvertical/smrt-types@0.23.4

## 0.23.3

### Patch Changes

- ### Bug Fixes

  - handle wrapped system index races (#1176) (core)
  - @happyvertical/smrt-scanner@0.23.3
  - @happyvertical/smrt-config@0.23.3
  - @happyvertical/smrt-types@0.23.3

## 0.23.2

### Patch Changes

- 6d6e8f5: Avoid duplicate generated virtual client keys when an object and collection share the same REST collection name.
  - @happyvertical/smrt-scanner@0.23.2
  - @happyvertical/smrt-config@0.23.2
  - @happyvertical/smrt-types@0.23.2

## 0.23.1

### Patch Changes

- ### Merged Changes

  - [codex] Handle legacy STI discriminator saves
  - @happyvertical/smrt-scanner@0.23.1
  - @happyvertical/smrt-config@0.23.1
  - @happyvertical/smrt-types@0.23.1

## 1.0.0

### Patch Changes

- @happyvertical/smrt-config@1.0.0
- @happyvertical/smrt-types@1.0.0
- @happyvertical/smrt-scanner@1.0.0

## 0.22.17

### Patch Changes

- ### Bug Fixes

  - tolerate concurrent system index creation (#1169) (core)
  - @happyvertical/smrt-scanner@0.22.17
  - @happyvertical/smrt-config@0.22.17
  - @happyvertical/smrt-types@0.22.17

## 0.22.16

### Patch Changes

- ### Bug Fixes

  - repair index drift in db:migrate (#1165) (#1166) (core,cli)
  - @happyvertical/smrt-scanner@0.22.16
  - @happyvertical/smrt-config@0.22.16
  - @happyvertical/smrt-types@0.22.16

## 0.22.15

### Patch Changes

- ### Features

  - asset-associable contract & lazy agent_config (#1161, #1162) (#1163) (content,agents)
  - @happyvertical/smrt-scanner@0.22.15
  - @happyvertical/smrt-config@0.22.15
  - @happyvertical/smrt-types@0.22.15

## 0.22.14

### Patch Changes

- f81fc02: Prefer configured AI embeddings for fact embedding work and avoid duplicate fact embedding generation during reconciliation.
  - @happyvertical/smrt-scanner@0.22.14
  - @happyvertical/smrt-config@0.22.14
  - @happyvertical/smrt-types@0.22.14

## 0.22.13

### Patch Changes

- ### Features

  - add durable job telemetry (#1158) (jobs)
  - @happyvertical/smrt-scanner@0.22.13
  - @happyvertical/smrt-config@0.22.13
  - @happyvertical/smrt-types@0.22.13

## 0.22.12

### Patch Changes

- ### Bug Fixes

  - preserve package names in generated registers (#1157) (cli)
  - @happyvertical/smrt-scanner@0.22.12
  - @happyvertical/smrt-config@0.22.12
  - @happyvertical/smrt-types@0.22.12

## 0.22.11

### Patch Changes

- ### Bug Fixes

  - fail db migrate on unrepaired drift (#1156) (cli)
  - @happyvertical/smrt-scanner@0.22.11
  - @happyvertical/smrt-config@0.22.11
  - @happyvertical/smrt-types@0.22.11

## 0.22.10

### Patch Changes

- ### Merged Changes

  - [codex] Add smrt-prompts with provider-aware integrations
  - @happyvertical/smrt-scanner@0.22.10
  - @happyvertical/smrt-config@0.22.10
  - @happyvertical/smrt-types@0.22.10

## 0.22.9

### Patch Changes

- ### Bug Fixes

  - repair safe integer schema drift (#1155) (core)
  - @happyvertical/smrt-scanner@0.22.9
  - @happyvertical/smrt-config@0.22.9
  - @happyvertical/smrt-types@0.22.9

## 0.22.8

### Patch Changes

- ### Merged Changes

  - [codex] add smrt-assets storage resolver seam
  - @happyvertical/smrt-scanner@0.22.8
  - @happyvertical/smrt-config@0.22.8
  - @happyvertical/smrt-types@0.22.8

## 0.22.7

### Patch Changes

- ### Bug Fixes

  - harden migration reconciliation (#1153) (cli)
  - @happyvertical/smrt-scanner@0.22.7
  - @happyvertical/smrt-config@0.22.7
  - @happyvertical/smrt-types@0.22.7

## 0.22.6

### Patch Changes

- ### Other Changes

  - chore: sync sdk packages to v0.71.32 (#1149) (deps)
  - @happyvertical/smrt-scanner@0.22.6
  - @happyvertical/smrt-config@0.22.6
  - @happyvertical/smrt-types@0.22.6

## 0.22.5

### Patch Changes

- ### Bug Fixes

  - restore api path typing (#1151) (core)
  - @happyvertical/smrt-scanner@0.22.5
  - @happyvertical/smrt-config@0.22.5
  - @happyvertical/smrt-types@0.22.5

## 0.22.4

### Patch Changes

- @happyvertical/smrt-config@0.22.4
- @happyvertical/smrt-types@0.22.4
- @happyvertical/smrt-scanner@0.22.4

## 0.22.3

### Patch Changes

- 3bad5df: Fix test manifest loading so downstream consumers do not register core-only test classes, and skip `SmrtCollection` manifest stubs when building test database schemas.
  - @happyvertical/smrt-scanner@0.22.3
  - @happyvertical/smrt-config@0.22.3
  - @happyvertical/smrt-types@0.22.3

## 0.22.2

### Patch Changes

- ### Bug Fixes

  - make vite-plugin sibling-module loader deterministic (#1142) (core)

  ### Merged Changes

  - [codex] Fix places coordinate SQL types
  - @happyvertical/smrt-scanner@0.22.2
  - @happyvertical/smrt-config@0.22.2
  - @happyvertical/smrt-types@0.22.2

## 0.22.1

### Patch Changes

- ### Bug Fixes

  - close two STI inheritance-cache invalidation gaps (#1139) (#1141) (core)
  - @happyvertical/smrt-scanner@0.22.1
  - @happyvertical/smrt-config@0.22.1
  - @happyvertical/smrt-types@0.22.1

## 1.0.0

### Minor Changes

- 9284b1c: **Release A — close #1132: self-registering package manifests**

  Consumer runtimes (tsx, SvelteKit SSR, plain `vite dev`) no longer silently drop declared model fields. Every `@happyvertical/smrt-*` domain package now loads its own build-time manifest as a top-of-entry side effect, so `@smrt()` decorators find their fields before any class module evaluates. `place.save()` / `list({ where: { externalId } })` now round-trip declared fields from a fresh `pnpm add @happyvertical/smrt-places` — no vitest plugin required.

  **New in @happyvertical/smrt-core**:

  - `ObjectRegistry.registerPackageManifest(url)` — the primitive each package calls at import time.
  - `ObjectRegistry.getDiagnostics()` / `flushDiagnostics()` / `clearDiagnostics()` — opt-in collector for registry load failures that previously surfaced only as `console.warn`. Passive in this release; Release C (#1134) flips `SMRT_STRICT_REGISTRY` on by default.
  - `SMRT_SKIP_STI_REHYDRATE=true` env flag — opts out of the unconditional STI descendant re-hydration added in #1131, now redundant for consumers on the new builds. The flag is removed in Release C (#1134) once the self-registration rollout is proven stable.

  **Per-package change**: each listed package gains a one-line `src/__smrt-register__.ts` shim that runs before its class modules load. No consumer-facing API change.

- 8a0311a: **Release C — collision-policy decision table + strict-mode default + retire SKIP_STI_REHYDRATE (#1134)**

  Third and final release of the ObjectRegistry / SmrtObject review thread.

  **Internal refactor (no consumer API change):**

  - `register()` and `registerFromManifest()` now share a single 16-row decision table at `packages/core/src/registry/collision-policy.ts`. The 11-branch exact-match + case-insensitive collision tree in `register()` and the 3-branch `resolveManifestCollision()` it mirrored are all collapsed onto `decideCollisionPolicy()`. Every row corresponds to a named scenario (`manifest-stub-replacement`, `sti-child-wins`, `decorator-case-insensitive-pnpm-duplicate`, etc.) that maps 1:1 to the existing issue-specific test suite (#531, #555, #584, #847, #950, #951, #1000). `resolveManifestCollision()` is deleted.

  **Breaking changes (minor):**

  - **`SMRT_STRICT_REGISTRY` is now on by default.** Severity-`'error'` diagnostics throw at record time instead of being silently collected. Affected codes: `MANIFEST_EXPORT_INVALID`, `MANIFEST_EXPORT_NOT_JSON`, `MANIFEST_EXPORT_NOT_FOUND`, `PACKAGE_MANIFEST_READ_FAILED`. Warn-severity codes are unchanged. To restore the pre-Release-C permissive behavior set `SMRT_STRICT_REGISTRY=false`.
  - **`SMRT_SKIP_STI_REHYDRATE` removed.** The env flag disappears. PR #1131's unconditional STI descendant rehydration on save is now the only behavior, preserving the stale-cache repair contract from `external-runtime-hydration.test.ts:1071`. Further optimizing the loop away is tracked in [#1139](https://github.com/happyvertical/smrt/issues/1139).
  - Collision error messages carry a stable scenario identifier in the verbose-log output. Text in end-user `throw` messages is unchanged.

  **Migration:**

  - Run your test suite with the new default. If `MANIFEST_EXPORT_*` or `PACKAGE_MANIFEST_READ_FAILED` start throwing, the underlying manifest misconfiguration is the thing to fix; if you genuinely need to keep shipping despite a broken manifest, set `SMRT_STRICT_REGISTRY=false` in your runtime env.
  - Remove any `SMRT_SKIP_STI_REHYDRATE=true` setting from your env; it's now a no-op.

### Patch Changes

- 84b2430: Rehydrate STI descendants before save-time serialization so stale external runtime field caches do not coerce sibling integer fields to empty strings.
- bdd4979: **Release B — consolidate ObjectRegistry manifest discovery (#1133)**

  Internal refactor. Public `ObjectRegistry.*` API unchanged; no consumer impact.

  - Extract `packages/core/src/manifest/store.ts` — leaf module holding globalThis cache accessors and pure fs/URL helpers with no `ObjectRegistry` dependency. Breaks the historical `registry.ts → class-registration.ts → manifest-loader.ts → registry.ts` cycle.
  - Introduce `ManifestSource` interface with six implementations (`LocalTestManifestSource`, `TestManifestSource`, `StaticManifestSource`, `EmbeddedManifestSource`, `NodeModulesFallbackSource`, `ExplicitPathsManifestSource`) and a `CompositeManifestSource` that queries them in the same priority order as the historical `discoverCachedManifestSync`.
  - `ManifestLookupQuery` carries optional `packageName` / `qualifiedName` context so multi-package same-simple-name scenarios (issue #951) resolve to the right manifest when the caller has package identity available.
  - `discoverManifestSync` and `loadAllManifests({ manifestPaths })` now delegate through `CompositeManifestSource` / `ExplicitPathsManifestSource`. Test-env gating moved into the sources themselves.
  - Drop the eagerly-maintained `__smrtRegistryClassNameMap` index; case-insensitive lookups iterate the `classes` Map with object-identity de-duplication. Removes a class of cache-sync bugs (#584, #847, #951) at negligible runtime cost in realistic SMRT apps (low-hundreds of classes).
  - Consolidate manifest-cache getters across `manifest-loader.ts` onto the `store.ts` leaf.
  - @happyvertical/smrt-scanner@1.0.0
  - @happyvertical/smrt-config@1.0.0
  - @happyvertical/smrt-types@1.0.0

## 0.21.52

### Patch Changes

- ### Features

  - public asset runtime + generic serving contract (#1128) (#1129) (assets)

  ### Bug Fixes

  - avoid DOM-only BodyInit cast in asset-serving (#1130) (assets)

  ### Merged Changes

  - [codex] split browser-safe registry runtime
  - @happyvertical/smrt-scanner@0.21.52
  - @happyvertical/smrt-config@0.21.52
  - @happyvertical/smrt-types@0.21.52

## 0.21.51

### Patch Changes

- ### Bug Fixes

  - ensure publish date persistence, align drawers, and simplify toolbar actions (#1124) (content)

  ### Merged Changes

  - [codex] fix publish-time core manifest discovery imports
  - @happyvertical/smrt-scanner@0.21.51
  - @happyvertical/smrt-config@0.21.51
  - @happyvertical/smrt-types@0.21.51

## 0.21.50

### Patch Changes

- dc274dd: Align `AgentSchedule` manifest schema output with the runtime storage contract for `agentConfig` and `methodArgs`, and improve migration status/history reporting so superseded failed generated migrations are distinguished from active schema drift.
  - @happyvertical/smrt-scanner@0.21.50
  - @happyvertical/smrt-config@0.21.50
  - @happyvertical/smrt-types@0.21.50

## 0.21.49

### Patch Changes

- ### Bug Fixes

  - support CTI-safe static exports (#1122) (cli)
  - @happyvertical/smrt-scanner@0.21.49
  - @happyvertical/smrt-config@0.21.49
  - @happyvertical/smrt-types@0.21.49

## 0.21.48

### Patch Changes

- @happyvertical/smrt-config@0.21.48
- @happyvertical/smrt-types@0.21.48
- @happyvertical/smrt-scanner@0.21.48

## 0.21.47

### Patch Changes

- 5c0d3eb: Align `AgentSchedule` manifest schema output with the runtime storage contract for `agentConfig` and `methodArgs`, and improve migration status/history reporting so superseded failed generated migrations are distinguished from active schema drift.
  - @happyvertical/smrt-scanner@0.21.47
  - @happyvertical/smrt-config@0.21.47
  - @happyvertical/smrt-types@0.21.47

## 0.21.46

### Patch Changes

- ### Merged Changes

  - Fix manifest upgrades and failed migration drift reporting
  - @happyvertical/smrt-scanner@0.21.46
  - @happyvertical/smrt-config@0.21.46
  - @happyvertical/smrt-types@0.21.46

## 0.21.45

### Patch Changes

- ### Merged Changes

  - [codex] repair live schema drift reconciliation
  - @happyvertical/smrt-scanner@0.21.45
  - @happyvertical/smrt-config@0.21.45
  - @happyvertical/smrt-types@0.21.45

## 0.21.44

### Patch Changes

- 6056c00: Improve bundled runtime behavior and operator guidance for background jobs.

  - fix `ObjectRegistry.ensureManifestLoaded()` and STI polymorphic hydration so installed external classes can be loaded on demand by qualified name
  - clarify stale-heartbeat recovery errors for long-running blocking jobs
  - document bundled runtime manifest loading, heartbeat-safe job execution, and the distinction between automatic scheduled work and manual operator actions such as forage/backfill flows
  - @happyvertical/smrt-scanner@0.21.44
  - @happyvertical/smrt-config@0.21.44
  - @happyvertical/smrt-types@0.21.44

## 0.21.43

### Patch Changes

- @happyvertical/smrt-config@0.21.43
- @happyvertical/smrt-types@0.21.43
- @happyvertical/smrt-scanner@0.21.43

## 0.21.42

### Patch Changes

- ### Merged Changes

  - [codex] Add code-first feature flags package
  - @happyvertical/smrt-scanner@0.21.42
  - @happyvertical/smrt-config@0.21.42
  - @happyvertical/smrt-types@0.21.42

## 0.21.41

### Patch Changes

- ### Merged Changes

  - [codex] align renovate automerge policy
  - @happyvertical/smrt-scanner@0.21.41
  - @happyvertical/smrt-config@0.21.41
  - @happyvertical/smrt-types@0.21.41

## 0.21.40

### Patch Changes

- 60084ad: Prefer `@huggingface/transformers` for local embeddings and fall back to
  `@xenova/transformers` only when the newer package is not installed. This
  avoids the stale `sharp@0.32.x` runtime path on Node 24 while preserving
  compatibility for older consumers.
  - @happyvertical/smrt-scanner@0.21.40
  - @happyvertical/smrt-config@0.21.40
  - @happyvertical/smrt-types@0.21.40

## 0.21.39

### Patch Changes

- ### Merged Changes

  - [codex] Fix packed export validation in CI
  - @happyvertical/smrt-scanner@0.21.39
  - @happyvertical/smrt-config@0.21.39
  - @happyvertical/smrt-types@0.21.39

## 0.21.38

### Patch Changes

- ### Bug Fixes

  - merge external manifest schema into runtime registrations (#1106)
  - @happyvertical/smrt-scanner@0.21.38
  - @happyvertical/smrt-config@0.21.38
  - @happyvertical/smrt-types@0.21.38

## 0.21.37

### Patch Changes

- ### Bug Fixes

  - persist tenant audit logs explicitly (#1104) (secrets)
  - @happyvertical/smrt-scanner@0.21.37
  - @happyvertical/smrt-config@0.21.37
  - @happyvertical/smrt-types@0.21.37

## 0.21.36

### Patch Changes

- ### Bug Fixes

  - preserve smrt runtime class names (#1103) (secrets)
  - @happyvertical/smrt-scanner@0.21.36
  - @happyvertical/smrt-config@0.21.36
  - @happyvertical/smrt-types@0.21.36

## 0.21.35

### Patch Changes

- ### Features

  - resolve tenant AI secrets with ancestor fallback (#1102) (agents)
  - @happyvertical/smrt-scanner@0.21.35
  - @happyvertical/smrt-config@0.21.35
  - @happyvertical/smrt-types@0.21.35

## 0.21.34

### Patch Changes

- ### Bug Fixes

  - guard provider sync and bump sdk (#1101) (smrt-svelte)
  - merge sti child columns in ensureSchema (#1099) (core)
  - @happyvertical/smrt-scanner@0.21.34
  - @happyvertical/smrt-config@0.21.34
  - @happyvertical/smrt-types@0.21.34

## 0.21.33

### Patch Changes

- ### Bug Fixes

  - merge sti child columns in schema aggregation (#1100) (core)
  - @happyvertical/smrt-scanner@0.21.33
  - @happyvertical/smrt-config@0.21.33
  - @happyvertical/smrt-types@0.21.33

## 0.21.32

### Patch Changes

- ### Bug Fixes

  - fail fast on missing consumer setup (#1098) (core)
  - @happyvertical/smrt-scanner@0.21.32
  - @happyvertical/smrt-config@0.21.32
  - @happyvertical/smrt-types@0.21.32

## 0.21.31

### Patch Changes

- ### Bug Fixes

  - recover stale scheduled work (#1097) (jobs)
  - @happyvertical/smrt-scanner@0.21.31
  - @happyvertical/smrt-config@0.21.31
  - @happyvertical/smrt-types@0.21.31

## 0.21.30

### Patch Changes

- ### Bug Fixes

  - resolve nested runtime manifests (#1096) (cli)
  - @happyvertical/smrt-scanner@0.21.30
  - @happyvertical/smrt-config@0.21.30
  - @happyvertical/smrt-types@0.21.30

## 0.21.29

### Patch Changes

- @happyvertical/smrt-config@0.21.29
- @happyvertical/smrt-types@0.21.29
- @happyvertical/smrt-scanner@0.21.29

## 0.21.28

### Patch Changes

- ### Bug Fixes

  - treat bare smrt imports as package usage (#1094) (scanner)
  - @happyvertical/smrt-scanner@0.21.28
  - @happyvertical/smrt-config@0.21.28
  - @happyvertical/smrt-types@0.21.28

## 0.21.27

### Patch Changes

- ### Bug Fixes

  - harden runtime manifest hydration (#1093) (core)
  - @happyvertical/smrt-scanner@0.21.27
  - @happyvertical/smrt-config@0.21.27
  - @happyvertical/smrt-types@0.21.27

## 0.21.26

### Patch Changes

- @happyvertical/smrt-config@0.21.26
- @happyvertical/smrt-types@0.21.26
- @happyvertical/smrt-scanner@0.21.26

## 0.21.25

### Patch Changes

- ### Bug Fixes

  - register persisted smrt job fields (#1091) (jobs)
  - @happyvertical/smrt-scanner@0.21.25
  - @happyvertical/smrt-config@0.21.25
  - @happyvertical/smrt-types@0.21.25

## 0.21.24

### Patch Changes

- ### Bug Fixes

  - restore bundled runtime fields (#1090) (agents)
  - @happyvertical/smrt-scanner@0.21.24
  - @happyvertical/smrt-config@0.21.24
  - @happyvertical/smrt-types@0.21.24

## 0.21.23

### Patch Changes

- ### Bug Fixes

  - preserve tenant context for queued work (#1089) (jobs)
  - @happyvertical/smrt-scanner@0.21.23
  - @happyvertical/smrt-config@0.21.23
  - @happyvertical/smrt-types@0.21.23

## 0.21.22

### Patch Changes

- ### Bug Fixes

  - hydrate partial external manifests (#1088) (core)
  - @happyvertical/smrt-scanner@0.21.22
  - @happyvertical/smrt-config@0.21.22
  - @happyvertical/smrt-types@0.21.22

## 0.21.21

### Patch Changes

- ### Merged Changes

  - [codex] remediate smrt-core audit findings
  - [codex] Fix downstream external getAllFields autoload
  - @happyvertical/smrt-scanner@0.21.21
  - @happyvertical/smrt-config@0.21.21
  - @happyvertical/smrt-types@0.21.21

## 0.21.20

### Patch Changes

- ### Merged Changes

  - Restore SmrtObject base fields and clean workspace test warnings
  - @happyvertical/smrt-scanner@0.21.20
  - @happyvertical/smrt-config@0.21.20
  - @happyvertical/smrt-types@0.21.20

## 0.21.19

### Patch Changes

- ### Bug Fixes

  - avoid ARC pnpm cache conflicts and bump sdk (#1082) (ci)
  - use mounted pnpm store on ARC runners (#1081) (ci)
  - @happyvertical/smrt-scanner@0.21.19
  - @happyvertical/smrt-config@0.21.19
  - @happyvertical/smrt-types@0.21.19

## 0.21.18

### Patch Changes

- ### Other Changes

  - chore: reduce warnings and bump happyvertical sdk (#1080) (ci)
  - @happyvertical/smrt-scanner@0.21.18
  - @happyvertical/smrt-config@0.21.18
  - @happyvertical/smrt-types@0.21.18

## 0.21.17

### Patch Changes

- ### Bug Fixes

  - publish import conditions for svelte exports (#1079) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.21.17
  - @happyvertical/smrt-config@0.21.17
  - @happyvertical/smrt-types@0.21.17

## 0.21.16

### Patch Changes

- ### Other Changes

  - refactor: remove legacy asset backfill (#1078) (content)
  - @happyvertical/smrt-scanner@0.21.16
  - @happyvertical/smrt-config@0.21.16
  - @happyvertical/smrt-types@0.21.16

## 0.21.15

### Patch Changes

- ### Features

  - expand content workspace surfaces (#1077) (content)
  - @happyvertical/smrt-scanner@0.21.15
  - @happyvertical/smrt-config@0.21.15
  - @happyvertical/smrt-types@0.21.15

## 0.21.14

### Patch Changes

- ### Bug Fixes

  - export content svelte routes (#1075) (content)
  - @happyvertical/smrt-scanner@0.21.14
  - @happyvertical/smrt-config@0.21.14
  - @happyvertical/smrt-types@0.21.14

## 0.21.13

### Patch Changes

- ### Bug Fixes

  - preserve CTI conflict columns in test dbs (#1074) (core)
  - @happyvertical/smrt-scanner@0.21.13
  - @happyvertical/smrt-config@0.21.13
  - @happyvertical/smrt-types@0.21.13

## 0.21.12

### Patch Changes

- ### Bug Fixes

  - support squash merge titles (#1073) (release)

  ### Merged Changes

  - normalize video owned asset models
  - Follow up smrt#1063 owned asset helper refactor
  - add owned asset joins for profiles, events, places, and products
  - @happyvertical/smrt-scanner@0.21.12
  - @happyvertical/smrt-config@0.21.12
  - @happyvertical/smrt-types@0.21.12

## 0.21.11

### Patch Changes

- ### Bug Fixes

  - finish release-ready content asset rollback (#1062) (content)
  - @happyvertical/smrt-scanner@0.21.11
  - @happyvertical/smrt-config@0.21.11
  - @happyvertical/smrt-types@0.21.11

## 0.21.10

### Patch Changes

- ### Bug Fixes

  - repair content package artifacts for downstream installs (#1053)
  - @happyvertical/smrt-scanner@0.21.10
  - @happyvertical/smrt-config@0.21.10
  - @happyvertical/smrt-types@0.21.10

## 0.21.9

### Patch Changes

- ### Bug Fixes

  - respect ImageThumbnail api base (#1052) (content)
  - @happyvertical/smrt-scanner@0.21.9
  - @happyvertical/smrt-config@0.21.9
  - @happyvertical/smrt-types@0.21.9

## 0.21.8

### Patch Changes

- ### Features

  - roll out package preview modules (#1050) (playground)
  - standardize package playground modules (#1049) (playground)

  ### Bug Fixes

  - validate publish prepack before merge (#1051) (ci)
  - @happyvertical/smrt-scanner@0.21.8
  - @happyvertical/smrt-config@0.21.8
  - @happyvertical/smrt-types@0.21.8

## 0.21.7

### Patch Changes

- ### Bug Fixes

  - support api base overrides and packed types (#1043) (content)
  - @happyvertical/smrt-scanner@0.21.7
  - @happyvertical/smrt-config@0.21.7
  - @happyvertical/smrt-types@0.21.7

## 0.21.6

### Patch Changes

- ### Features

  - dev server navigation and UI pages (#1040) (content)
  - @happyvertical/smrt-scanner@0.21.6
  - @happyvertical/smrt-config@0.21.6
  - @happyvertical/smrt-types@0.21.6

## 0.21.5

### Patch Changes

- ### Features

  - add contribution intake and promotion workflows (#1037) (content)
  - @happyvertical/smrt-scanner@0.21.5
  - @happyvertical/smrt-config@0.21.5
  - @happyvertical/smrt-types@0.21.5

## 0.21.4

### Patch Changes

- ### Features

  - add governed content workflows and transparency (#1036) (content)
  - @happyvertical/smrt-scanner@0.21.4
  - @happyvertical/smrt-config@0.21.4
  - @happyvertical/smrt-types@0.21.4

## 0.21.3

### Patch Changes

- ### Features

  - add MagicLinkService for passwordless email authentication (#1035) (users)
  - @happyvertical/smrt-scanner@0.21.3
  - @happyvertical/smrt-config@0.21.3
  - @happyvertical/smrt-types@0.21.3

## 0.21.2

### Patch Changes

- ### Other Changes

  - refactor: remove lazy schema creation path (#1034) (core)
  - @happyvertical/smrt-scanner@0.21.2
  - @happyvertical/smrt-config@0.21.2
  - @happyvertical/smrt-types@0.21.2

## 0.21.1

### Patch Changes

- ### Bug Fixes

  - restore shared-db lazy schemas and model content references (#1031) (core)
  - @happyvertical/smrt-scanner@0.21.1
  - @happyvertical/smrt-config@0.21.1
  - @happyvertical/smrt-types@0.21.1

## 1.0.0

### Minor Changes

- e4a2fa7: feat(dispatch): add `correlationId` for request/response linking

  Adds a first-class `correlation_id` column to the dispatch system, enabling agents to link related dispatches (e.g. a video generation request and its completion response).

  - New `correlationId` field on `DispatchEmitOptions`, `DispatchMetadata`, `DispatchListOptions`, `Dispatch`, and `DispatchData`
  - Schema DDL includes `correlation_id` column and index
  - Auto-migration for existing databases (adds column if missing)
  - Query dispatches by `correlationId` via `bus.list({ correlationId })`

### Patch Changes

- 9f01b9a: ### Features

  - add image variation toggle workflow to uploader component (images)
  - Add UI components and Material Design updates (images)
  - add AI usage tracking (core)

  ### Bug Fixes

  - use createPackageConfig for library build mode (images)
  - update sveltekit-generator tests for getCollection<any> (core)
  - address AI usage review feedback (core)
  - @happyvertical/smrt-scanner@1.0.0
  - @happyvertical/smrt-config@1.0.0
  - @happyvertical/smrt-types@1.0.0

## 0.20.56

### Patch Changes

- ### Features

  - Add UI components and Material Design updates (#1023) (images)

  ### Bug Fixes

  - use in-memory filter for json override effects to fix postgres 500s (#1025) (users)
  - @happyvertical/smrt-scanner@0.20.56
  - @happyvertical/smrt-config@0.20.56
  - @happyvertical/smrt-types@0.20.56

## 0.20.54

### Patch Changes

- ### Features

  - add AI usage tracking (#1020) (core)
  - @happyvertical/smrt-scanner@0.20.54
  - @happyvertical/smrt-config@0.20.54
  - @happyvertical/smrt-types@0.20.54

## 0.20.53

### Patch Changes

- ### Bug Fixes

  - make SMRT registration package-aware in bundles (#1019)
  - remove ui-only runtime peers (#1018)
  - @happyvertical/smrt-scanner@0.20.53
  - @happyvertical/smrt-config@0.20.53
  - @happyvertical/smrt-types@0.20.53

## 0.20.52

### Patch Changes

- ### Bug Fixes

  - use declare for summaryArticle to prevent subclass shadowing (#1017) (agents)
  - @happyvertical/smrt-scanner@0.20.52
  - @happyvertical/smrt-config@0.20.52
  - @happyvertical/smrt-types@0.20.52

## 0.20.51

### Patch Changes

- 2dba0b4: feat: make manifest discovery a pure operation — no side effects during reads (#1007)

  Added `ObjectRegistry.loadAllManifests()` for upfront manifest loading at startup.
  Removed the lazy `registerFromManifest()` side effect from `getInheritanceChain()`.
  After `loadAllManifests()` completes, inheritance queries are pure lookups.

  Added integration tests for high object counts (400+ manifest entries across 28 packages) (#1008).
  Tests validate: no circular inheritance, valid chains, pure reads, topological ordering, and DAG validity.

  - @happyvertical/smrt-scanner@0.20.51
  - @happyvertical/smrt-config@0.20.51
  - @happyvertical/smrt-types@0.20.51

## 0.20.50

### Patch Changes

- ### Bug Fixes

  - remove dependency pre-aggregation from enrichManifest (#1013) (#1014) (manifest)
  - @happyvertical/smrt-scanner@0.20.50
  - @happyvertical/smrt-config@0.20.50
  - @happyvertical/smrt-types@0.20.50

## 0.20.49

### Patch Changes

- ### Bug Fixes

  - qualified extends + findClassStrict for cross-package inheritance (#1004, #1005) (#1012) (core)
  - @happyvertical/smrt-scanner@0.20.49
  - @happyvertical/smrt-config@0.20.49
  - @happyvertical/smrt-types@0.20.49

## 0.20.48

### Patch Changes

- ### Bug Fixes

  - fix cross-package STI field registration and db:migrate error reporting (#1002) (core)
  - @happyvertical/smrt-scanner@0.20.48
  - @happyvertical/smrt-config@0.20.48
  - @happyvertical/smrt-types@0.20.48

## 0.20.47

### Patch Changes

- ### Bug Fixes

  - update group member query to use Postgres parameter bindings instead of SQLite bindings (#998) (users)
  - @happyvertical/smrt-scanner@0.20.47
  - @happyvertical/smrt-config@0.20.47
  - @happyvertical/smrt-types@0.20.47

## 0.20.46

### Patch Changes

- ### Other Changes

  - chore: Add SMRT onboarding agents and rules (#992)
  - @happyvertical/smrt-scanner@0.20.46
  - @happyvertical/smrt-config@0.20.46
  - @happyvertical/smrt-types@0.20.46

## 0.20.45

### Patch Changes

- ### Features

  - add OVERHEAD type and network context fields (#991) (affiliates)
  - @happyvertical/smrt-scanner@0.20.45
  - @happyvertical/smrt-config@0.20.45
  - @happyvertical/smrt-types@0.20.45

## 0.20.44

### Patch Changes

- ### Features

  - agent signal handler infrastructure (#990) (agents,core)
  - @happyvertical/smrt-scanner@0.20.44
  - @happyvertical/smrt-config@0.20.44
  - @happyvertical/smrt-types@0.20.44

## 0.20.43

### Patch Changes

- ### Bug Fixes

  - use isLocalObject() in registration file generator (#988) (core)

  ### Other Changes

  - docs: complete CLAUDE.md audit, README cleanup, and JSDoc for all 38 packages (#989)
  - @happyvertical/smrt-scanner@0.20.43
  - @happyvertical/smrt-config@0.20.43
  - @happyvertical/smrt-types@0.20.43

## 0.20.42

### Patch Changes

- ### Features

  - add whitelist/blacklist models and email management UI (#987) (messages)
  - @happyvertical/smrt-scanner@0.20.42
  - @happyvertical/smrt-config@0.20.42
  - @happyvertical/smrt-types@0.20.42

## 0.20.41

### Patch Changes

- ### Bug Fixes

  - skip collection classes in SvelteKit route generator (#983) (core)
  - @happyvertical/smrt-scanner@0.20.41
  - @happyvertical/smrt-config@0.20.41
  - @happyvertical/smrt-types@0.20.41

## 0.20.40

### Patch Changes

- ### Bug Fixes

  - use $lib paths for local objects with packageName set (#981) (core)
  - @happyvertical/smrt-scanner@0.20.40
  - @happyvertical/smrt-config@0.20.40
  - @happyvertical/smrt-types@0.20.40

## 0.20.39

### Patch Changes

- 5092f5e: Skip tableExists() check for migration-managed database adapters

  `Collection.create()` now checks `db.requiresSchemaCheck` before running
  `tableExists()`. Postgres and SQLite adapters (which manage schema via
  migrations) no longer pay the cost of an extra round-trip per collection
  initialization. This eliminates ~1s per collection over high-latency
  connections (e.g. Tailscale).

  - @happyvertical/smrt-scanner@0.20.39
  - @happyvertical/smrt-config@0.20.39
  - @happyvertical/smrt-types@0.20.39

## 0.20.38

### Patch Changes

- ### Bug Fixes

  - add smrt-affiliates and smrt-sites to changeset fixed array (#977) (release)
  - @happyvertical/smrt-scanner@0.20.38
  - @happyvertical/smrt-config@0.20.38
  - @happyvertical/smrt-types@0.20.38

## 0.20.37

### Patch Changes

- ### Bug Fixes

  - resolve TSTypeLiteral to 'object' for json field inference (#976) (scanner)
  - @happyvertical/smrt-scanner@0.20.37
  - @happyvertical/smrt-config@0.20.37
  - @happyvertical/smrt-types@0.20.37

## 0.20.36

### Patch Changes

- ### Other Changes

  - chore: bump SDK packages to ^0.69.7 (#975) (deps)
  - @happyvertical/smrt-scanner@0.20.36
  - @happyvertical/smrt-config@0.20.36
  - @happyvertical/smrt-types@0.20.36

## 0.20.35

### Patch Changes

- ### Features

  - AgentAdminExport contract + vite plugin registry (#974) (agents)
  - @happyvertical/smrt-scanner@0.20.35
  - @happyvertical/smrt-config@0.20.35
  - @happyvertical/smrt-types@0.20.35

## 0.20.34

### Patch Changes

- ### Bug Fixes

  - lazy schemas in SmrtClass.initialize() (#973) (core)
  - @happyvertical/smrt-scanner@0.20.34
  - @happyvertical/smrt-config@0.20.34
  - @happyvertical/smrt-types@0.20.34

## 0.20.33

### Patch Changes

- ### Bug Fixes

  - cache tableExists() to avoid redundant DB round-trips (#971) (core)
  - @happyvertical/smrt-scanner@0.20.33
  - @happyvertical/smrt-config@0.20.33
  - @happyvertical/smrt-types@0.20.33

## 0.20.32

### Patch Changes

- ### Bug Fixes

  - use db.query() for system tables instead of syncSchema() (#969) (core)
  - @happyvertical/smrt-scanner@0.20.32
  - @happyvertical/smrt-config@0.20.32
  - @happyvertical/smrt-types@0.20.32

## 0.20.31

### Patch Changes

- ### Bug Fixes

  - standardize manifest generation through plugins (#968) (core)
  - @happyvertical/smrt-scanner@0.20.31
  - @happyvertical/smrt-config@0.20.31
  - @happyvertical/smrt-types@0.20.31

## 0.20.30

### Patch Changes

- ### Bug Fixes

  - deduplicate imports in generate-register (#966) (cli)
  - @happyvertical/smrt-scanner@0.20.30
  - @happyvertical/smrt-config@0.20.30
  - @happyvertical/smrt-types@0.20.30

## 0.20.29

### Patch Changes

- ### Bug Fixes

  - write local manifest for non-library builds (#964) (core)
  - @happyvertical/smrt-scanner@0.20.29
  - @happyvertical/smrt-config@0.20.29
  - @happyvertical/smrt-types@0.20.29

## 0.20.28

### Patch Changes

- ### Bug Fixes

  - pass agent config to constructor, separate from method args (#962) (jobs)
  - @happyvertical/smrt-scanner@0.20.28
  - @happyvertical/smrt-config@0.20.28
  - @happyvertical/smrt-types@0.20.28

## 0.20.27

### Patch Changes

- ### Bug Fixes

  - allow pnpm duplicate copies in case-insensitive collision check (#961) (core)
  - @happyvertical/smrt-scanner@0.20.27
  - @happyvertical/smrt-config@0.20.27
  - @happyvertical/smrt-types@0.20.27

## 0.20.26

### Patch Changes

- ### Features

  - implement reconcile, evolution tree, and confidence scoring (facts)
  - add FactContent and FactTag join tables (facts)
  - scaffold smrt-facts package with core models and tests (facts)

  ### Bug Fixes

  - BFS cycle detection, prompt injection defense, parallel entity loading (facts)
  - add cycle detection, fix confidence calculation in reconcile (facts)
  - add getByRelationship method to FactContentCollection (facts)

  ### Other Changes

  - docs: add CLAUDE.md and SPEC.md for smrt-facts package (facts)
  - refactor: use DB queries instead of in-memory filtering (facts)
  - @happyvertical/smrt-scanner@0.20.26
  - @happyvertical/smrt-config@0.20.26
  - @happyvertical/smrt-types@0.20.26

## 0.20.25

### Patch Changes

- ### Features

  - scaffold @happyvertical/smrt-facts package with core models (#956) (facts)
  - @happyvertical/smrt-scanner@0.20.25
  - @happyvertical/smrt-config@0.20.25
  - @happyvertical/smrt-types@0.20.25

## 0.20.24

### Patch Changes

- ### Features

  - add native vector storage for embeddings (#955) (core)
  - @happyvertical/smrt-scanner@0.20.24
  - @happyvertical/smrt-config@0.20.24
  - @happyvertical/smrt-types@0.20.24

## 0.20.23

### Patch Changes

- ### Features

  - qualified registry keys and scanner consolidation (#953) (core,scanner,cli)
  - @happyvertical/smrt-scanner@0.20.23
  - @happyvertical/smrt-config@0.20.23
  - @happyvertical/smrt-types@0.20.23

## 0.20.22

### Patch Changes

- ### Bug Fixes

  - review fixes, STI collision handling, PostgreSQL compat (#952) (chat,core,jobs,messages)
  - @happyvertical/smrt-scanner@0.20.22
  - @happyvertical/smrt-config@0.20.22
  - @happyvertical/smrt-types@0.20.22

## 0.20.21

### Patch Changes

- ### Bug Fixes

  - review fixes, PG compat, manifest dedup, email sync (#948) (chat,jobs,core,messages)
  - @happyvertical/smrt-scanner@0.20.21
  - @happyvertical/smrt-config@0.20.21
  - @happyvertical/smrt-types@0.20.21

## 0.20.20

### Patch Changes

- ### Bug Fixes

  - use toJSON() in serializeInstance to avoid circular JSON crash (#947) (tenancy)
  - @happyvertical/smrt-scanner@0.20.20
  - @happyvertical/smrt-config@0.20.20
  - @happyvertical/smrt-types@0.20.20

## 0.20.19

### Patch Changes

- ### Bug Fixes

  - merge DDL columns across STI subclasses in test DB (#945) (vitest)
  - @happyvertical/smrt-scanner@0.20.19
  - @happyvertical/smrt-config@0.20.19
  - @happyvertical/smrt-types@0.20.19

## 0.20.18

### Patch Changes

- ### Features

  - add smrt-chat package (#944) (chat)
  - @happyvertical/smrt-scanner@0.20.18
  - @happyvertical/smrt-config@0.20.18
  - @happyvertical/smrt-types@0.20.18

## 0.20.17

### Patch Changes

- ### Features

  - DispatchBus integration for directory provisioning (#943) (tenancy)
  - @happyvertical/smrt-scanner@0.20.17
  - @happyvertical/smrt-config@0.20.17
  - @happyvertical/smrt-types@0.20.17

## 0.20.16

### Patch Changes

- ### Bug Fixes

  - resolve broken types.js import in Svelte component dist (#942) (jobs)
  - @happyvertical/smrt-scanner@0.20.16
  - @happyvertical/smrt-config@0.20.16
  - @happyvertical/smrt-types@0.20.16

## 0.20.15

### Patch Changes

- ### Bug Fixes

  - findClass resolves simple names via classNameMap (#941) (core)
  - @happyvertical/smrt-scanner@0.20.15
  - @happyvertical/smrt-config@0.20.15
  - @happyvertical/smrt-types@0.20.15

## 0.20.14

### Patch Changes

- ### Bug Fixes

  - fix Svelte component import paths and event handler (#940) (jobs,messages)
  - @happyvertical/smrt-scanner@0.20.14
  - @happyvertical/smrt-config@0.20.14
  - @happyvertical/smrt-types@0.20.14

## 0.20.10

### Patch Changes

- ### Features

  - unified multi-channel messaging with send support (#939) (smrt-messages)
  - @happyvertical/smrt-scanner@0.20.10
  - @happyvertical/smrt-config@0.20.10
  - @happyvertical/smrt-types@0.20.10

## 0.20.9

### Patch Changes

- ### Bug Fixes

  - sync video, voice, social package versions to 0.20.7 (#938)
  - @happyvertical/smrt-scanner@0.20.9
  - @happyvertical/smrt-config@0.20.9
  - @happyvertical/smrt-types@0.20.9

## 0.20.8

### Patch Changes

- ### Features

  - extract Image into new package, enhance smrt-assets infrastructure (#937) (smrt-images)
  - @happyvertical/smrt-scanner@0.20.8
  - @happyvertical/smrt-config@0.20.8
  - @happyvertical/smrt-types@0.20.8

## 0.20.7

### Patch Changes

- ### Features

  - add STI support to Property class (#936) (smrt-properties)
  - @happyvertical/smrt-scanner@0.20.7
  - @happyvertical/smrt-config@0.20.7
  - @happyvertical/smrt-types@0.20.7

## 0.20.6

### Patch Changes

- ### Other Changes

  - refactor: remove legacy dynamic schema creation code (#934)
  - @happyvertical/smrt-scanner@0.20.6
  - @happyvertical/smrt-config@0.20.6
  - @happyvertical/smrt-types@0.20.6

## 0.20.5

### Patch Changes

- ### Features

  - add AgentActionContext types for agent action handlers (#933) (agents)

  ### Bug Fixes

  - handle string literal union types in OXC parser (#932) (scanner)
  - @happyvertical/smrt-scanner@0.20.5
  - @happyvertical/smrt-config@0.20.5
  - @happyvertical/smrt-types@0.20.5

## 0.20.4

### Patch Changes

- ### Bug Fixes

  - globalThis singleton for AgentUIRegistry + CLI env loading (#930) (agents)

  ### Other Changes

  - refactor: make AI and heavy deps optional for lite usage (#931) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.20.4
  - @happyvertical/smrt-config@0.20.4
  - @happyvertical/smrt-types@0.20.4

## 0.20.3

### Patch Changes

- ### Bug Fixes

  - load .env before config, hard fail on broken register.js, fix URL display (#929) (cli)
  - @happyvertical/smrt-scanner@0.20.3
  - @happyvertical/smrt-config@0.20.3
  - @happyvertical/smrt-types@0.20.3

## 0.20.2

### Patch Changes

- ### Bug Fixes

  - cycle detection for self-referential extends in registry (#928) (core)
  - @happyvertical/smrt-scanner@0.20.2
  - @happyvertical/smrt-config@0.20.2
  - @happyvertical/smrt-types@0.20.2

## 0.20.1

### Patch Changes

- ### Bug Fixes

  - add ui entry points for domain package svelte exports (#921)
  - @happyvertical/smrt-scanner@0.20.1
  - @happyvertical/smrt-config@0.20.1
  - @happyvertical/smrt-types@0.20.1

## 1.0.0

### Minor Changes

- ### Breaking Changes

  - Address critical accessibility and security issues (#916) (smrt-svelte)

### Patch Changes

- @happyvertical/smrt-scanner@1.0.0
- @happyvertical/smrt-config@1.0.0
- @happyvertical/smrt-types@1.0.0

## 0.19.82

### Patch Changes

- ### Bug Fixes

  - resolve import aliases in extends clauses (#920) (scanner)
  - @happyvertical/smrt-scanner@0.19.82
  - @happyvertical/smrt-config@0.19.82
  - @happyvertical/smrt-types@0.19.82

## 0.19.81

### Patch Changes

- ### Other Changes

  - chore: bump SDK catalog to 0.68.6, external packages to latest (#919) (deps)
  - @happyvertical/smrt-scanner@0.19.81
  - @happyvertical/smrt-config@0.19.81
  - @happyvertical/smrt-types@0.19.81

## 0.19.80

### Patch Changes

- ### Bug Fixes

  - handle multi-line commit bodies in auto-changeset (#918) (ci)

  ### Other Changes

  - chore: centralize SDK dependency versions with pnpm catalog (#917)
  - @happyvertical/smrt-scanner@0.19.80
  - @happyvertical/smrt-config@0.19.80
  - @happyvertical/smrt-types@0.19.80

## 0.19.79

### Patch Changes

- ### Features

  - core type safety, deprecate .claude-meta.json, add CLAUDE.md docs (#889)
  - @happyvertical/smrt-scanner@0.19.79
  - @happyvertical/smrt-config@0.19.79
  - @happyvertical/smrt-types@0.19.79

## 0.19.78

### Patch Changes

- ### Features

  - enhance components for downstream app refactoring (#890) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.19.78
  - @happyvertical/smrt-config@0.19.78
  - @happyvertical/smrt-types@0.19.78

## 0.19.77

### Patch Changes

- ### Features

  - add ./server export for server-side agent utilities (#886) (agents)
  - @happyvertical/smrt-scanner@0.19.77
  - @happyvertical/smrt-config@0.19.77
  - @happyvertical/smrt-types@0.19.77

## 0.19.76

### Patch Changes

- ### Bug Fixes

  - use package.json exports check for admin detection (#884) (agents)
  - @happyvertical/smrt-scanner@0.19.76
  - @happyvertical/smrt-config@0.19.76
  - @happyvertical/smrt-types@0.19.76

## 0.19.75

### Patch Changes

- ### Features

  - add tableStrategy 'sti' to Tenant model (#883) (users)
  - @happyvertical/smrt-scanner@0.19.75
  - @happyvertical/smrt-config@0.19.75
  - @happyvertical/smrt-types@0.19.75

## 0.19.74

### Patch Changes

- ### Features

  - add smrt-sites package for site lifecycle management (#880) (sites)
  - @happyvertical/smrt-scanner@0.19.74
  - @happyvertical/smrt-config@0.19.74
  - @happyvertical/smrt-types@0.19.74

## 0.19.73

### Patch Changes

- ### Features

  - virtual module for auto-registration + route generation (#879) (agents)
  - @happyvertical/smrt-scanner@0.19.73
  - @happyvertical/smrt-config@0.19.73
  - @happyvertical/smrt-types@0.19.73

## 0.19.72

### Patch Changes

- ### Features

  - add admin route declarations and Vite plugin for SvelteKit route generation (#878) (agents)
  - @happyvertical/smrt-scanner@0.19.72
  - @happyvertical/smrt-config@0.19.72
  - @happyvertical/smrt-types@0.19.72

## 0.19.71

### Patch Changes

- ### Features

  - Character, VideoShot, VideoComposition model hierarchy (#877) (video)
  - @happyvertical/smrt-scanner@0.19.71
  - @happyvertical/smrt-config@0.19.71
  - @happyvertical/smrt-types@0.19.71

## 0.19.70

### Patch Changes

- ### Features

  - include SDK packages in docs:claude output (#874) (cli)
  - @happyvertical/smrt-scanner@0.19.70
  - @happyvertical/smrt-config@0.19.70
  - @happyvertical/smrt-types@0.19.70

## 0.19.69

### Patch Changes

- ### Features

  - support agent manifests in OXC scanner path (#876) (scanner)
  - @happyvertical/smrt-scanner@0.19.69
  - @happyvertical/smrt-config@0.19.69
  - @happyvertical/smrt-types@0.19.69

## 0.19.68

### Patch Changes

- ### Features

  - tenant-aware agent system with manifest auto-generation (#875) (agents)
  - @happyvertical/smrt-scanner@0.19.68
  - @happyvertical/smrt-config@0.19.68
  - @happyvertical/smrt-types@0.19.68

## 0.19.67

### Patch Changes

- ### Bug Fixes

  - Multiple issues - system context, STI filtering, SvelteKit, circular inheritance, and docs (#872)
  - @happyvertical/smrt-scanner@0.19.67
  - @happyvertical/smrt-config@0.19.67
  - @happyvertical/smrt-types@0.19.67

## 0.19.66

### Patch Changes

- ### Bug Fixes

  - use shared pluralize function in manifest generator (#865) (core)
  - @happyvertical/smrt-scanner@0.19.66
  - @happyvertical/smrt-config@0.19.66
  - @happyvertical/smrt-types@0.19.66

## 0.19.65

### Patch Changes

- ### Bug Fixes

  - update @happyvertical/sql to ^0.67.7 (#864) (deps)
  - @happyvertical/smrt-scanner@0.19.65
  - @happyvertical/smrt-config@0.19.65
  - @happyvertical/smrt-types@0.19.65

## 0.19.64

### Patch Changes

- ### Bug Fixes

  - include CREATE INDEX statements in test database DDL (#863) (vitest)
  - @happyvertical/smrt-scanner@0.19.64
  - @happyvertical/smrt-config@0.19.64
  - @happyvertical/smrt-types@0.19.64

## 0.19.63

### Patch Changes

- ### Bug Fixes

  - address connection leak, DDL application, and doc issues (#862) (vitest)
  - @happyvertical/smrt-scanner@0.19.63
  - @happyvertical/smrt-config@0.19.63
  - @happyvertical/smrt-types@0.19.63

## 0.19.62

### Patch Changes

- ### Features

  - enhance Grid component with header slot and responsive features (#857) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.19.62
  - @happyvertical/smrt-config@0.19.62
  - @happyvertical/smrt-types@0.19.62

## 0.19.61

### Patch Changes

- ### Other Changes

  - ci: consolidate version validation into build job (#856)
  - @happyvertical/smrt-scanner@0.19.61
  - @happyvertical/smrt-config@0.19.61
  - @happyvertical/smrt-types@0.19.61

## 0.19.60

### Patch Changes

- ### Features

  - add createIsolatedTestDbFromManifest helper (#855) (vitest)
  - @happyvertical/smrt-scanner@0.19.60
  - @happyvertical/smrt-config@0.19.60
  - @happyvertical/smrt-types@0.19.60

## 0.19.59

### Patch Changes

- ### Features

  - add comprehensive multi-theme system to smrt-svelte (#852)
  - @happyvertical/smrt-scanner@0.19.59
  - @happyvertical/smrt-config@0.19.59
  - @happyvertical/smrt-types@0.19.59

## 0.19.58

### Patch Changes

- ### Bug Fixes

  - pass smrtDependencies to generateManifest for STI inheritance (#850) (#851) (core)
  - @happyvertical/smrt-scanner@0.19.58
  - @happyvertical/smrt-config@0.19.58
  - @happyvertical/smrt-types@0.19.58

## 0.19.57

### Patch Changes

- ### Bug Fixes

  - clear classNameMap in ObjectRegistry.clear() (#849) (core)
  - @happyvertical/smrt-scanner@0.19.57
  - @happyvertical/smrt-config@0.19.57
  - @happyvertical/smrt-types@0.19.57

## 0.19.56

### Patch Changes

- ### Bug Fixes

  - respect optional marker for @foreignKey fields (#848) (scanner)
  - @happyvertical/smrt-scanner@0.19.56
  - @happyvertical/smrt-config@0.19.56
  - @happyvertical/smrt-types@0.19.56

## 0.19.55

### Patch Changes

- ### Features

  - add domain packages, fix test infrastructure, and reorganize documentation (#843)
  - @happyvertical/smrt-scanner@0.19.55
  - @happyvertical/smrt-config@0.19.55
  - @happyvertical/smrt-types@0.19.55

## 0.19.54

### Patch Changes

- ### Features

  - add voice, video, and social domain packages for Histrio (#840) (smrt)
  - @happyvertical/smrt-scanner@0.19.54
  - @happyvertical/smrt-config@0.19.54
  - @happyvertical/smrt-types@0.19.54

## 0.19.53

### Patch Changes

- ### Bug Fixes

  - preserve \_\_tenancy metadata during field merging (#842) (core)
  - @happyvertical/smrt-scanner@0.19.53
  - @happyvertical/smrt-config@0.19.53
  - @happyvertical/smrt-types@0.19.53

## 0.19.52

### Patch Changes

- ### Bug Fixes

  - add JSON type handling to SchemaGenerator.formatDefaultValue() (#837) (core)
  - @happyvertical/smrt-scanner@0.19.52
  - @happyvertical/smrt-config@0.19.52
  - @happyvertical/smrt-types@0.19.52

## 0.19.51

### Patch Changes

- ### Bug Fixes

  - increase hookTimeout for CI stability (ads)
  - reduce weighted selection test iterations for CI performance (ads)
  - fix export command API calls (cli)
  - @happyvertical/smrt-scanner@0.19.51
  - @happyvertical/smrt-config@0.19.51
  - @happyvertical/smrt-types@0.19.51

## 0.19.50

### Patch Changes

- ### Features

  - add unified smrt export command for static site generation (cli)
  - @happyvertical/smrt-scanner@0.19.50
  - @happyvertical/smrt-config@0.19.50
  - @happyvertical/smrt-types@0.19.50

## 0.19.49

### Patch Changes

- ### Other Changes

  - refactor: migrate from field helpers to decorator-only pattern (#831)
  - @happyvertical/smrt-scanner@0.19.49
  - @happyvertical/smrt-config@0.19.49
  - @happyvertical/smrt-types@0.19.49

## 0.19.48

### Patch Changes

- ### Features

  - add multi-tenancy support across all domain modules (#827) (tenancy)

  ### Bug Fixes

  - prevent flaky memory leak test timeout in CI (#828) (core)
  - @happyvertical/smrt-scanner@0.19.48
  - @happyvertical/smrt-config@0.19.48
  - @happyvertical/smrt-types@0.19.48

## 0.19.47

### Patch Changes

- ### Other Changes

  - docs: document auto-populate feature for issue #809 (#811) (tenancy)
  - @happyvertical/smrt-scanner@0.19.47
  - @happyvertical/smrt-config@0.19.47
  - @happyvertical/smrt-types@0.19.47

## 0.19.46

### Patch Changes

- ### Features

  - add allowLocalModels option to prevent 404s (#806) (browser-ai)

  ### Bug Fixes

  - increase timeout for LRU cache eviction test (#808) (core)
  - preserve snake_case field names in formatDataJs when defined in manifest (#783) (core)
  - @happyvertical/smrt-scanner@0.19.46
  - @happyvertical/smrt-config@0.19.46
  - @happyvertical/smrt-types@0.19.46

## 0.19.45

### Patch Changes

- ### Features

  - comprehensive framework documentation improvements (#807)
  - @happyvertical/smrt-scanner@0.19.45
  - @happyvertical/smrt-config@0.19.45
  - @happyvertical/smrt-types@0.19.45

## 0.19.44

### Patch Changes

- ### Features

  - add tree shaking for external SMRT packages (#788) (core)
  - @happyvertical/smrt-scanner@0.19.44
  - @happyvertical/smrt-config@0.19.44
  - @happyvertical/smrt-types@0.19.44

## 0.19.43

### Patch Changes

- ### Other Changes

  - perf: pre-compute validation rules at build time (#787) (core)
  - perf: reduce console noise by making registry logs conditional (#782) (#786) (core)
  - @happyvertical/smrt-scanner@0.19.43
  - @happyvertical/smrt-config@0.19.43
  - @happyvertical/smrt-types@0.19.43

## 0.19.42

### Patch Changes

- ### Bug Fixes

  - add type annotations for parse() calls (#785) (core)

  ### Other Changes

  - perf: enable discovery cache by default and add --timing flag (#784) (cli)
  - refactor: remove SMRT prefix from component names (#781)
  - @happyvertical/smrt-scanner@0.19.42
  - @happyvertical/smrt-config@0.19.42
  - @happyvertical/smrt-types@0.19.42

## 0.19.41

### Patch Changes

- ### Bug Fixes

  - use qualified name for STI \_meta_type filter (#780) (agents)

  ### Other Changes

  - ci: shard core tests across 3 parallel jobs (#777)
  - @happyvertical/smrt-scanner@0.19.41
  - @happyvertical/smrt-config@0.19.41
  - @happyvertical/smrt-types@0.19.41

## 0.19.40

### Patch Changes

- @happyvertical/smrt-config@0.19.40
- @happyvertical/smrt-types@0.19.40
- @happyvertical/smrt-scanner@0.19.40

## 0.19.39

### Patch Changes

- ### Features

  - add isType() and resolveType() helpers for STI name resolution (#776) (core)

  ### Other Changes

  - docs: add collection features documentation (#779) (core)
  - docs: add documentation for describe() method and embedding system (#778) (core)
  - @happyvertical/smrt-scanner@0.19.39
  - @happyvertical/smrt-config@0.19.39
  - @happyvertical/smrt-types@0.19.39

## 0.19.38

### Patch Changes

- ### Other Changes

  - ci: split test jobs and use turbo remote cache (#775)
  - @happyvertical/smrt-scanner@0.19.38
  - @happyvertical/smrt-config@0.19.38
  - @happyvertical/smrt-types@0.19.38

## 0.19.37

### Patch Changes

- ### Bug Fixes

  - make SmrtProvider SSR-friendly (#773) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.19.37
  - @happyvertical/smrt-config@0.19.37
  - @happyvertical/smrt-types@0.19.37

## 0.19.36

### Patch Changes

- ### Bug Fixes

  - deduplicate manifest discovery and detect version conflicts (#772) (cli)
  - @happyvertical/smrt-scanner@0.19.36
  - @happyvertical/smrt-config@0.19.36
  - @happyvertical/smrt-types@0.19.36

## 0.19.35

### Patch Changes

- ### Features

  - add delete() method to SmrtCollection (#770)
  - @happyvertical/smrt-scanner@0.19.35
  - @happyvertical/smrt-config@0.19.35
  - @happyvertical/smrt-types@0.19.35

## 0.19.34

### Patch Changes

- ### Bug Fixes

  - OXC scanner inherits STI fields from parent classes (#769) (core)
  - @happyvertical/smrt-scanner@0.19.34
  - @happyvertical/smrt-config@0.19.34
  - @happyvertical/smrt-types@0.19.34

## 0.19.33

### Patch Changes

- ### Bug Fixes

  - remove unused ./schema export (#767) (core)
  - @happyvertical/smrt-scanner@0.19.33
  - @happyvertical/smrt-config@0.19.33
  - @happyvertical/smrt-types@0.19.33

## 0.19.32

### Patch Changes

- ### Features

  - add 'review' status to Content publication workflow (#765) (content)
  - add WeakMap fast path to manifest discovery (#762)

  ### Bug Fixes

  - add schema.ts re-export file for build compatibility (#766) (core)
  - resolve TypeScript errors caught by publish workflow (#764)
  - remove public export of system schema SQL strings (#763)
  - @happyvertical/smrt-scanner@0.19.32
  - @happyvertical/smrt-config@0.19.32
  - @happyvertical/smrt-types@0.19.32

## 0.19.31

### Patch Changes

- ### Bug Fixes

  - suppress non-JSON output when --json flag is used (#761) (cli)
  - @happyvertical/smrt-scanner@0.19.31
  - @happyvertical/smrt-config@0.19.31
  - @happyvertical/smrt-types@0.19.31

## 0.19.30

### Patch Changes

- ### Features

  - add docs:claude command for generating framework context (#759) (cli)

  ### Bug Fixes

  - suppress non-JSON output when --json flag is used (#760) (cli)
  - @happyvertical/smrt-scanner@0.19.30
  - @happyvertical/smrt-config@0.19.30
  - @happyvertical/smrt-types@0.19.30

## 0.19.29

### Patch Changes

- ### Bug Fixes

  - prevent ensureAllSchemas deprecation warning spam (#756) (core)
  - @happyvertical/smrt-scanner@0.19.29
  - @happyvertical/smrt-config@0.19.29
  - @happyvertical/smrt-types@0.19.29

## 0.19.28

### Patch Changes

- a9102f4: Fix class name collision in bundled contexts (Vite/SvelteKit)

  When bundlers like Vite duplicate module code into multiple chunks, the same class
  can be registered multiple times with different source file paths (e.g., different
  chunk files). This caused false collision errors for legitimate re-registrations.

  The fix detects bundled contexts by checking if the source file is in a build
  output directory (.svelte-kit/output, dist, build, .next, .nuxt) and allows
  re-registration if the existing entry came from a known package manifest.

  - @happyvertical/smrt-scanner@0.19.28
  - @happyvertical/smrt-config@0.19.28
  - @happyvertical/smrt-types@0.19.28

## 0.19.27

### Patch Changes

- ### Features

  - add smrt-affiliates package for partner commission tracking (#752) (affiliates)
  - @happyvertical/smrt-scanner@0.19.27
  - @happyvertical/smrt-config@0.19.27
  - @happyvertical/smrt-types@0.19.27

## 0.19.26

### Patch Changes

- ### Bug Fixes

  - correctly parse and access hyphenated CLI options (#749) (#751) (cli)
  - @happyvertical/smrt-scanner@0.19.26
  - @happyvertical/smrt-config@0.19.26
  - @happyvertical/smrt-types@0.19.26

## 0.19.25

### Patch Changes

- ### Bug Fixes

  - decorator relationship hoisting and upgrade-sti early return (#750)
  - @happyvertical/smrt-scanner@0.19.25
  - @happyvertical/smrt-config@0.19.25
  - @happyvertical/smrt-types@0.19.25

## 0.19.24

### Patch Changes

- ### Bug Fixes

  - relationship loading for external packages and upgrade-sti table iteration (#747)
  - @happyvertical/smrt-scanner@0.19.24
  - @happyvertical/smrt-config@0.19.24
  - @happyvertical/smrt-types@0.19.24

## 0.19.23

### Patch Changes

- ### Bug Fixes

  - use SchemaComparer for db:migrate and fix double execution (#745) (cli)
  - @happyvertical/smrt-scanner@0.19.23
  - @happyvertical/smrt-config@0.19.23
  - @happyvertical/smrt-types@0.19.23

## 0.19.22

### Patch Changes

- ### Bug Fixes

  - detect functionally equivalent indexes in schema comparison (#743) (migrations)
  - @happyvertical/smrt-scanner@0.19.22
  - @happyvertical/smrt-config@0.19.22
  - @happyvertical/smrt-types@0.19.22

## 0.19.21

### Patch Changes

- ### Other Changes

  - chore: update all dependencies to latest (#742) (deps)
  - @happyvertical/smrt-scanner@0.19.21
  - @happyvertical/smrt-config@0.19.21
  - @happyvertical/smrt-types@0.19.21

## 0.19.20

### Patch Changes

- ### Bug Fixes

  - show underlying database error in migration failures (#740) (cli)
  - @happyvertical/smrt-scanner@0.19.20
  - @happyvertical/smrt-config@0.19.20
  - @happyvertical/smrt-types@0.19.20

## 0.19.19

### Patch Changes

- ### Bug Fixes

  - use JSON type for \_meta_data in getAllSchemas() (#739) (core)
  - @happyvertical/smrt-scanner@0.19.19
  - @happyvertical/smrt-config@0.19.19
  - @happyvertical/smrt-types@0.19.19

## 0.19.18

### Patch Changes

- ### Features

  - add conflictColumns support for junction tables (#738) (core)
  - @happyvertical/smrt-scanner@0.19.18
  - @happyvertical/smrt-config@0.19.18
  - @happyvertical/smrt-types@0.19.18

## 0.19.17

### Patch Changes

- ### Bug Fixes

  - resolve db:setup table creation issues (#735) (#737) (core)
  - @happyvertical/smrt-scanner@0.19.17
  - @happyvertical/smrt-config@0.19.17
  - @happyvertical/smrt-types@0.19.17

## 0.19.16

### Patch Changes

- ### Bug Fixes

  - correct sveltekit export path in package.json (#734) (users)
  - @happyvertical/smrt-scanner@0.19.16
  - @happyvertical/smrt-config@0.19.16
  - @happyvertical/smrt-types@0.19.16

## 0.19.15

### Patch Changes

- ### Bug Fixes

  - switch to vite build for proper ESM module resolution (#733) (ledgers)
  - @happyvertical/smrt-scanner@0.19.15
  - @happyvertical/smrt-config@0.19.15
  - @happyvertical/smrt-types@0.19.15

## 0.19.14

### Patch Changes

- ### Bug Fixes

  - correct URL logging in db:setup and db:migrate (#732) (cli)
  - handle self-referencing foreignKey in dependency graph (#731) (core)
  - @happyvertical/smrt-scanner@0.19.14
  - @happyvertical/smrt-config@0.19.14
  - @happyvertical/smrt-types@0.19.14

## 0.19.13

### Patch Changes

- ### Other Changes

  - perf: optimize manifest-loader to reduce 52k+ lookups to ~2k (#730) (core)
  - @happyvertical/smrt-scanner@0.19.13
  - @happyvertical/smrt-config@0.19.13
  - @happyvertical/smrt-types@0.19.13

## 0.19.12

### Patch Changes

- ### Features

  - add smrt-secrets integration for EmailAccount credentials (#726) (messages)
  - @happyvertical/smrt-scanner@0.19.12
  - @happyvertical/smrt-config@0.19.12
  - @happyvertical/smrt-types@0.19.12

## 0.19.11

### Patch Changes

- ### Features

  - implement qualified class names for namespace isolation (#713) (#715) (core)
  - @happyvertical/smrt-scanner@0.19.11
  - @happyvertical/smrt-config@0.19.11
  - @happyvertical/smrt-types@0.19.11

## 0.19.10

### Patch Changes

- ### Bug Fixes

  - rename test Secret class to avoid collision with smrt-secrets (#712) (core)
  - @happyvertical/smrt-scanner@0.19.10
  - @happyvertical/smrt-config@0.19.10
  - @happyvertical/smrt-types@0.19.10

## 0.19.9

### Patch Changes

- ### Bug Fixes

  - skip default UI for SvelteKit projects (#709) (core)
  - @happyvertical/smrt-scanner@0.19.9
  - @happyvertical/smrt-config@0.19.9
  - @happyvertical/smrt-types@0.19.9

## 0.19.8

### Patch Changes

- ### Bug Fixes

  - enable external package discovery for STI inheritance (#707) (vite-plugin)
  - @happyvertical/smrt-scanner@0.19.8
  - @happyvertical/smrt-config@0.19.8
  - @happyvertical/smrt-types@0.19.8

## 0.19.7

### Patch Changes

- ### Bug Fixes

  - include base columns and STI meta columns in getAllSchemas() DDL (#690) (#706) (core)
  - @happyvertical/smrt-scanner@0.19.7
  - @happyvertical/smrt-config@0.19.7
  - @happyvertical/smrt-types@0.19.7

## 0.19.6

### Patch Changes

- ### Bug Fixes

  - resolve STI base by inheritance chain, not tableName (#703) (#705) (core)
  - @happyvertical/smrt-scanner@0.19.6
  - @happyvertical/smrt-config@0.19.6
  - @happyvertical/smrt-types@0.19.6

## 0.19.5

### Patch Changes

- ### Features

  - add @happyvertical/smrt-secrets package (#702) (secrets)
  - @happyvertical/smrt-scanner@0.19.5
  - @happyvertical/smrt-config@0.19.5
  - @happyvertical/smrt-types@0.19.5

## 0.19.4

### Patch Changes

- ### Features

  - add @happyvertical/smrt-jobs for background job processing (#701) (jobs)
  - @happyvertical/smrt-scanner@0.19.4
  - @happyvertical/smrt-config@0.19.4
  - @happyvertical/smrt-types@0.19.4

## 0.19.3

### Patch Changes

- ### Bug Fixes

  - resolve STI base tableName in getAllSchemas for subclasses (#693) (#694) (core)
  - @happyvertical/smrt-scanner@0.19.3
  - @happyvertical/smrt-config@0.19.3
  - @happyvertical/smrt-types@0.19.3

## 0.19.2

### Patch Changes

- ### Features

  - add @smrt({ tenantScoped }) configuration option (#692) (core)
  - @happyvertical/smrt-scanner@0.19.2
  - @happyvertical/smrt-config@0.19.2
  - @happyvertical/smrt-types@0.19.2

## 0.19.1

### Patch Changes

- ### Bug Fixes

  - detect STI subclass columns in db:migrate (#690) (#691) (core)
  - @happyvertical/smrt-scanner@0.19.1
  - @happyvertical/smrt-config@0.19.1
  - @happyvertical/smrt-types@0.19.1

## 1.0.0

### Minor Changes

- ### Breaking Changes

  - remove town and weather components (#687) (smrt-svelte)

### Patch Changes

- @happyvertical/smrt-scanner@1.0.0
- @happyvertical/smrt-config@1.0.0
- @happyvertical/smrt-types@1.0.0

## 0.18.6

### Patch Changes

- ### Bug Fixes

  - make package browser-compatible (#684) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.18.6
  - @happyvertical/smrt-config@0.18.6
  - @happyvertical/smrt-types@0.18.6

## 0.18.5

### Patch Changes

- ### Bug Fixes

  - update SDK dependencies to ^0.66.0 (#683) (deps)
  - @happyvertical/smrt-scanner@0.18.5
  - @happyvertical/smrt-config@0.18.5
  - @happyvertical/smrt-types@0.18.5

## 0.18.4

### Patch Changes

- ### Features

  - standardize module exports with optional Svelte UI (#678) (types,smrt-svelte,modules)
  - @happyvertical/smrt-scanner@0.18.4
  - @happyvertical/smrt-config@0.18.4
  - @happyvertical/smrt-types@0.18.4

## 0.18.3

### Patch Changes

- ### Features

  - add production-ready multi-tenancy framework (#676) (core,tenancy)
  - @happyvertical/smrt-scanner@0.18.3
  - @happyvertical/smrt-config@0.18.3
  - @happyvertical/smrt-types@0.18.3

## 0.18.2

### Patch Changes

- ### Features

  - case-insensitive registry and new UI components (#672) (core,smrt-svelte)
  - migrate components from @happyvertical/svelte (#674) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.18.2
  - @happyvertical/smrt-config@0.18.2
  - @happyvertical/smrt-types@0.18.2

## 0.18.1

### Patch Changes

- ### Features

  - add database-backed agent configuration system (#671) (agents)
  - @happyvertical/smrt-scanner@0.18.1
  - @happyvertical/smrt-config@0.18.1
  - @happyvertical/smrt-types@0.18.1

## 1.0.0

### Minor Changes

- ### Breaking Changes

  - remove automatic table creation from production code paths (#667) (core)

  ### Bug Fixes

  - address Copilot review comments for version safeguard (#670) (ci)
  - downgrade version after changeset runs, add PR preview (#669) (ci)
  - downgrade major changesets to minor to prevent 1.0.0 releases (#668) (ci)

### Patch Changes

- @happyvertical/smrt-scanner@1.0.0
- @happyvertical/smrt-config@1.0.0
- @happyvertical/smrt-types@1.0.0

## 0.17.100

### Patch Changes

- ### Bug Fixes

  - cache fields for sync access during queries (#664) (core)
  - @happyvertical/smrt-scanner@0.17.100
  - @happyvertical/smrt-config@0.17.100
  - @happyvertical/smrt-types@0.17.100

## 0.17.99

### Patch Changes

- ### Features

  - make smrt-scanner a direct dependency (#662) (core)
  - @happyvertical/smrt-scanner@0.17.99
  - @happyvertical/smrt-config@0.17.99
  - @happyvertical/smrt-types@0.17.99

## 0.17.98

### Patch Changes

- ### Features

  - add invoice, time tracking, and M3 components (#661) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.17.98
  - @happyvertical/smrt-config@0.17.98
  - @happyvertical/smrt-types@0.17.98

## 0.17.97

### Patch Changes

- ### Other Changes

  - refactor: migrate component library to Material Design 3 (#660) (smrt-svelte)
  - @happyvertical/smrt-scanner@0.17.97
  - @happyvertical/smrt-config@0.17.97
  - @happyvertical/smrt-types@0.17.97

## 0.17.96

### Patch Changes

- 2eac718: Add production-ready migration system with db:migrate command
  - @happyvertical/smrt-scanner@0.17.96
  - @happyvertical/smrt-config@0.17.96
  - @happyvertical/smrt-types@0.17.96

## 0.17.95

### Patch Changes

- ### Features

  - add invoice and UI components (#650) (smrt-svelte)

  ### Bug Fixes

  - add missing required fields to tests (#649) (analytics)
  - @happyvertical/smrt-scanner@0.17.95
  - @happyvertical/smrt-config@0.17.95
  - @happyvertical/smrt-types@0.17.95

## 0.17.94

### Patch Changes

- ### Features

  - add OXC-based scanner for faster manifest generation (#647) (scanner)
  - @happyvertical/smrt-scanner@0.17.94
  - @happyvertical/smrt-config@0.17.94
  - @happyvertical/smrt-types@0.17.94

## 0.17.93

### Patch Changes

- ### Other Changes

  - perf: cache STI sibling discovery and skip for framework base classes (#646) (core)
  - @happyvertical/smrt-config@0.17.93
  - @happyvertical/smrt-types@0.17.93

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
