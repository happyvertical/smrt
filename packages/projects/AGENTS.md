# @happyvertical/smrt-projects

Provider-agnostic project management plus the managed-application delivery
control plane. Repository and board providers remain canonical; managed apps
only receive scoped Project Integration credentials and provider-neutral
request/delivery projections.

## Managed application delivery (#1949)

- `ProjectIntegration` stores capability grants and a sensitive credential
  hash; the raw credential is returned once by
  `ProjectIntegrationCollection.provision()`/`rotate()` and is never persisted.
  Provisioning, rotation, and revocation are append-only audited.
- The stable requester identity is supplied when authenticating
  `ManagedProjectClient`; request reads are always restricted to that requester
  and integration.
- `DevelopmentRequest` preserves evidence, origin, discussion, visibility, and
  lifecycle history. `ManagedProjectClient` owns managed intake and
  `DevelopmentRequestService` adds internal triage and work projection.
- `DevelopmentRequestWorkLink` connects zero-to-many provider-neutral work
  items. Canonical status stays on the link and drives request lifecycle
  projection without granting the managed app provider credentials.
- `ProjectDeliveryEvent` is idempotent per integration key and sequenced for
  replay. Preview decisions flow through the control-plane adapter, never
  directly to repository providers.
- `AssistanceRequest` preserves conversational intake before lossless routing
  to Support, Development, or both. `smrt-support` supplies the concrete
  `ProjectAssistanceSupportAdapter`.
- `ManagedProjectClient` deliberately exposes no repository or board client;
  delivery and assistance use separate capability-gated service facades.

## Shared Professional Service evidence (#1955)

`ServiceTimeEntry` is canonical here on the existing `service_time_entries`
table. Planning, development, and support use the same immutable evidence and
correction chain. `SubscriptionServiceCommercialResolver` prices client work
through `smrt-subscriptions` (#1925); provider compensation remains a separate
resolver and snapshot. See `SERVICE_TIME_MIGRATION.md`.

## Models

| Model | Key Fields | Notes |
|-------|-----------|-------|
| **Repository** | `owner`, `name`, `providerType`, `tokenConfigKey` | `sync()`, `getIssues()`, `getPullRequests()` |
| **Issue** | `repositoryId` (FK), `number`, `title`, `body`, `state`, `labels[]` | `incorporateFeedback()`, `rollback()`, `suggestLabels()` |
| **PullRequest** | extends Issue + `headRef`, `baseRef`, `merged`, `draft` | STI on Issue table. `summarize()`, `merge()` |
| **Project** | `projectId`, `title`, `statuses[]`, `statusFieldId` | GitHub Projects V2. `addItem()`, `moveItem()`, `analyzeHealth()` |
| **Comment** | `issueId` (FK), `body`, `authorLogin` | AI analysis support |
| **Label** | `repositoryId` (FK), `name`, `color` | |

## Key Patterns

- **Token config reference**: stores env var name (`tokenConfigKey: 'GITHUB_TOKEN'`), not the token itself. Resolved at runtime from `process.env` or `getModuleConfig()`
- **Living spec** (`incorporateFeedback()`): AI synthesizes issue comments into updated body. Supports preview mode and `rollback()`
- **Provider-agnostic**: GitHub primary, GitLab/Bitbucket/Azure planned. Uses `@happyvertical/repos` and `@happyvertical/projects` SDK packages
- **PullRequest is STI on Issue**: shares table, discriminated by `_meta_type`

## Collection Methods

All collections provide: `discover({ repository, filters })`, `findByRepository(repoId)`, `findOpen(repoId?)`, `batchSync(repository)`.

## Gotchas

- **Money is integer minor units** (cents) — `$19.99` is `1999`.
  `ServiceChargeSnapshot.amount` and `ServiceCompensationSnapshot.amount`
  initialize `= 0`, never `= 0.0`: the integer literal is what maps them to
  INTEGER columns (BIGINT on fresh PostgreSQL/DuckDB databases; #2401, #2373). The two convert as a pair — the delivery margin is
  `charge - compensation`, an exact integer subtraction with no tolerance —
  and both are fed verbatim by `CommercialSnapshot.amount`, so a resolver that
  returns major units corrupts the snapshot silently on SQLite and fails with
  `22P02` on PostgreSQL. `pnpm --filter @happyvertical/smrt-projects
  test:postgres` is the lane that holds the line.
- **UI formats by dividing, never by `toFixed`**: `formatCurrency()` and
  `ServiceEvidenceList`'s `money()` scale back to major units using the
  currency's own minor-unit exponent, so zero-decimal currencies (JPY, KRW) are
  not divided.
- **Migrating an existing database**: `preflightProjectsMoneyMinorUnits(db)`
  reports which columns still hold major units and which rows would be rounded
  or exceed JavaScript's safe-integer range; `migrateProjectsMoneyToMinorUnits(db)` converts them
  (idempotent via `_smrt_backfills`). On SQLite the values are rescaled but the
  declared type needs the table-rebuild path (#2370). Fresh PostgreSQL/DuckDB
  INTEGER columns are BIGINT and hydration rejects values outside JavaScript's
  safe-integer range; existing PostgreSQL `int4` columns require #2424.
- **SDK dependency**: requires `@happyvertical/repos` and `@happyvertical/projects` from SDK
- **tokenConfigKey not tokenValue**: never store actual tokens in the database
- **synthesisCount tracks incorporateFeedback calls**: incremented on each apply
