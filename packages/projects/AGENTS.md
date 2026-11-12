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

## Shared Professional Service evidence (#1955, #3288)

`ServiceTimeEntry`, `ServiceChargeSnapshot`, `ServiceCompensationSnapshot`,
their collections, and `ServiceEvidenceService` are owned by
`@happyvertical/smrt-timesheets` (#3288) and **re-exported** here unchanged,
on the unchanged `service_time_entries` / snapshot tables. Do not reintroduce
a projects subclass: a third same-named class on the table breaks the
single-table-family resolution (see `packages/timesheets/AGENTS.md`).
`caseId` / `specialistId` exist only on smrt-support's subtype;
`SubscriptionServiceCommercialResolver` reads them duck-typed when a support
entry is priced. It prices client work through `smrt-subscriptions` (#1925);
provider compensation remains a separate resolver and snapshot. The
time-entry Svelte components are re-exported from smrt-timesheets too. See
`SERVICE_TIME_MIGRATION.md`.

## Models

| Model | Key Fields | Notes |
|-------|-----------|-------|
| **Repository** | `owner`, `name`, `providerType`, `tokenConfigKey`, `archived`, `lastPushedAt`, `openPullRequestCount`, `ciState`, `latestReleaseTag/Date/Url`, `lastObservedAt`, `missingSince` | `sync()`, `getIssues()`, `getPullRequests()`. Unique per (tenant, provider, owner, name); independent of any project |
| **Issue** | `repositoryId` (optional FK), `projectId` (optional FK), `number`, `title`, `body`, `state`, `labels[]` | `incorporateFeedback()`, `rollback()`, `suggestLabels()` |
| **PullRequest** | extends Issue + `headRef`, `baseRef`, `merged`, `draft` | STI on Issue table. `summarize()`, `merge()` |
| **Project** | `projectId`, `title`, `statuses[]`, `statusFieldId` | GitHub Projects V2. `addItem()`, `moveItem()`, `analyzeHealth()` |
| **ProjectQuestion** | polymorphic project target, `prompt`, `answer`, owner, `status`, `revision` | Owner question lifecycle; mutate through `ProjectGovernanceService`. |
| **ProjectDecision** | polymorphic project target, options, `outcome`, `rationale`, owner, `status`, `revision` | Project choice lifecycle; mutate through `ProjectGovernanceService`. |
| **ProjectGovernanceEvent** | question/decision target, actor, action, status, revision | Immutable lifecycle history. |
| **Comment** | `issueId` (FK), `body`, `authorLogin` | AI analysis support |
| **Label** | `repositoryId` (optional FK), `projectId` (optional FK), `name`, `color` | Scope: repository, project, or neither |

## Key Patterns

- **Organization sync (#4905)**: `RepositoryCollection.syncOrganization({ owner, tokenConfigKey, tenantId?, force?, throttleMs?, lister? })` lists the owner through `@happyvertical/repos` `listOrganizationRepositories` (needs >= 0.111.11), upserts one `Repository` per listed repo, sets `archived` and the activity snapshot (`lastPushedAt`, `openPullRequestCount`, `ciState` of the default-branch head, `latestRelease*`), and sets `missingSince` on same-owner rows no longer listed (cleared if they return; an empty listing withholds vanish detection). Throttled by the newest `lastObservedAt` (`SYNC_THROTTLE_MS`); `force` bypasses. Opens no transaction, so a failed run leaves earlier rows saved and a rerun converges. Works with a read-only token named by `tokenConfigKey`; run it from a scheduled job. `listActive()` hides archived and missing rows. Repositories outside the org are added with `getOrCreate(owner, name)` and are never touched by another owner's sync. The default `lister` is injectable; tests stub it. Project links (H2) attach by repository id and must not change the unique key. Scope: the ambient tenant (or `tenantId`); with no tenant context only null-tenant rows are touched. `lastObservedAt` is stamped only when a pass completes. Owner/name match case-insensitively. Migration: `db:migrate` adds the columns and a unique index `repositories_tenant_provider_owner_name_key`; databases that already hold duplicate (tenant, provider, owner, name) rows must dedupe them first or the index fails. NULL-tenant rows are not DB-unique (SQL NULL semantics); the service dedupes them.

- **Repository is optional (project-native issues)**: an Issue/Label may carry only a `projectId`. `issue.hasRepository()` gates every provider call: `sync()` is a no-op, `close/addLabels/removeLabel/assign/addComment/rollback/incorporateFeedback(apply)` change local state only, `getComments()` reads stored `Comment` rows, `getRepository()` throws, `getUrl()` returns `''`. No unique key spans `repositoryId`+`number` (lookups only), so NULL repositories need no partial index. Schema change adds `issues.project_id`/`labels.project_id` and relaxes `repository_id` to nullable on both; `db:migrate` generates it from the manifest.

- **Token config reference**: stores env var name (`tokenConfigKey: 'GITHUB_TOKEN'`), not the token itself. Resolved at runtime from `process.env` or `getModuleConfig()`
- **Living spec** (`incorporateFeedback()`): AI synthesizes issue comments into updated body. Supports preview mode and `rollback()`. Prompt `projects.issue.incorporateFeedback` declares tier `great` (persisted synthesis, #4755 rule in `../prompts/AGENTS.md`); `do()` binds it, while a configured same-named profile's provider path runs that profile instead
- **Provider-agnostic**: GitHub primary, GitLab/Bitbucket/Azure planned. Uses `@happyvertical/repos` and `@happyvertical/projects` SDK packages
- **PullRequest is STI on Issue**: shares table, discriminated by `_meta_type`

## Collection Methods

All collections provide: `discover({ repository, filters })`, `findByRepository(repoId)`, `findOpen(repoId?)`, `batchSync(repository)`.

## Gotchas

- **Money is integer minor units** (cents) — `$19.99` is `1999`.
  `ServiceChargeSnapshot.amount` and `ServiceCompensationSnapshot.amount`
  (declared in smrt-timesheets)
  initialize `= 0`, never `= 0.0`: the integer literal is what maps them to
  INTEGER columns (BIGINT on fresh PostgreSQL/DuckDB databases; #2401, #2373). The two convert as a pair — the delivery margin is
  `charge - compensation`, an exact integer subtraction with no tolerance —
  and both are fed verbatim by `CommercialSnapshot.amount`, so a resolver that
  returns major units is wrong on every engine: snapshot `save()` refuses a
  fractional value (`19.99`) on SQLite and PostgreSQL alike, but a whole
  major-unit value (`150` for $150.00) is a valid integer and is stored
  100× too small. `pnpm --filter @happyvertical/smrt-timesheets
  test:postgres` is the lane that holds the line (moved with the snapshots in
  #3288).
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
