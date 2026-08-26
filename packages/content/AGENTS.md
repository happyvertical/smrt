# @happyvertical/smrt-content

STI content management with governance workflows, contribution intake, AI reviews, fact-checking, corrections, versioning, transparency reports, and thumbnail generation.

## Models

- **Content** (STI base): `type`, `variant` (generator:domain:specific format), `status` (published/draft/review/archived/deleted), `state`, `category` (hierarchical path with `/` separator), `metadata` JSON, `tags` array, `thumbnailAssetId`
- **Article**, **ContentDocument**, **Mirror**: STI subclasses — all share `contents` table via `_meta_type`
- **ContentReview**: AI review result tied to a governance policy. Fields: `contentId`, `policyKey`, `kind`, `status` (accepted/flagged/rejected), `findings`, `fingerprint`, `metadata`
- **ContentCorrection**: Post-publication change record. Fields: `contentId`, `type` (correction/retraction/update/clarification), `summary`, `note`, `status`, `metadata`
- **ContentVersion**: Content snapshot. Fields: `contentId`, `kind` (manual/draft/review/publication/correction/auto-generated), `versionNumber`, `summary`, `metadata` (includes `transparency` for publication versions)
- **ContentReference**: Junction model for content-to-content links (`content_references` table). Nullable `targetVersion` pins a citation to a specific `ContentVersion.version` for drift detection.
- **ContentGovernancePolicy**: Persisted review policy (key, label, kind, instructions)
- **ContentGovernanceProfile**: Persisted review profile (key, label, requirements array)
- **ContentGovernanceAssignment**: Governs content type/variant → profile mapping, feature flags
- **ContentContribution**: Held inbound submission with status lifecycle (submitted → approved/rejected/withdrawn → promoted)
- **ContentContributor**: Contributor profile resolved by email, with trust level (standard/trusted/blocked)
- **ContentContributionType**: Configures intake channels, rules, and promotion mapping
- **ContentContributionRevision**: Revision history for held submissions
- **ContentContributionAttachment**: Held file metadata; becomes an `Asset` on promotion

## Contents Collection

| Method | Purpose |
|--------|---------| 
| `mirror({ url })` | Downloads URL content, extracts text, creates `type: 'mirror'`. Idempotent. |
| `syncContentDir({ contentDir })` | Batch exports articles as markdown with YAML frontmatter |
| `generateMissingThumbnails(options)` | Bulk thumbnail generation for content missing `thumbnailAssetId` |
| `findWithGlobals(tenantId)` | Returns tenant-specific + global (tenantId=null) content |
| `getOrUpsert({ slug, context })` | Upsert by slug+context combination |
| `browseFacts()` | Browse fact catalog linked to content |
| `getGovernanceDefinitionsAction()` | Get all governance policy/profile/assignment definitions |
| `resolveGovernanceAction({ type, variant })` | Resolve effective governance for a content type |

## Content Instance Methods

| Method | Purpose |
|--------|---------|
| `resolveGovernance()` | Resolve effective governance config for this content |
| `runReviewAction(options)` | Run AI review against a policy; returns `ContentReview` |
| `listReviews()` | List all reviews for this content |
| `listReviewProfilesAction()` | Get readiness for all profiles |
| `evaluateReviewProfile(key)` | Evaluate one profile's requirements |
| `issueCorrectionAction(options)` | Issue a post-publication correction |
| `listCorrections()` | List corrections for this content |
| `listVersions()` | List version history |
| `mutateVersionAction(options)` | Create a version snapshot |
| `getPublishedTransparencyAction()` | Get frozen transparency from latest publication version |
| `previewTransparencyAction()` | Preview live transparency state |
| `addFact(factId, relationship)` | Link a fact (supports/contradicts/referenced_in) |
| `getFacts(options)` | Get linked facts |
| `getFactLinks()` | Get fact-content link records |
| `getFactsState()` / `syncFactsState(options)` | API-level facts get/sync |
| `addAsset(asset, relationship, sortOrder)` | Add asset association |
| `setThumbnail(image)` | Convenience: adds asset + updates `thumbnailAssetId` |
| `addReference(content, options?)` | Link to another content; `options.targetVersion` pins citation-time `ContentVersion.version` |
| `getReferences()` | Get content references |
| `getReferenceDrift()` | Per-edge `{ citedVersion, currentVersion, isDrifted }` for drift detection |

## Governance Workflow

1. `configureContentGovernance({ policies, profiles, assignments })` — static config
2. Or persist `ContentGovernancePolicy/Profile/Assignment` objects — DB overrides static
3. Effective config: DB layer merges over static defaults
4. `content.resolveGovernance()` → `ResolvedContentGovernance` with `isGoverned`, `reviewPolicies`, profile keys, feature flags
5. `content.runReviewAction()` creates a `ContentReview` with fingerprint for staleness detection
6. `content.evaluateReviewProfile(key)` checks all requirements
7. `content.save()` auto-validates publish readiness when `enforcePublishReadiness` is true
8. Publication auto-creates a `ContentVersion` with frozen transparency data

## Thumbnail Generation

Three strategies via ThumbnailGenerator:
- **headline-card**: title on branded background (via `@happyvertical/images`)
- **static-map**: requires `metadata.latitude`/`longitude` (via `@happyvertical/geo`)
- **ai-generate**: AI image generation (dynamic import of `@happyvertical/ai`)

## Svelte Components

### Content Management
`ContentList`, `ContentEditor`, `GovernedContentEditor`, `ContentAgentChat`, `ContentTitleField`, `ContentStatusFields`, `ContentMetadataFields`, `ContentReferencesPanel`, `ContentImageBrowser`, `ContentReviewStatusTray`, `ArticleCard`, `ArticleList`, `ImageThumbnail`, `Markdown`

### Governance
`ContentGovernanceManager`, `ContentGovernancePanel`, `ContentGovernancePolicyEditor`, `ContentGovernanceProfileEditor`, `ContentGovernanceAssignmentEditor`, `ContentTransparencyReport`

### Contributions
`ContentContributionForm`, `ContentContributionInbox`, `ContentContributionPortal`, `ContentContributionTypeManager`, `ContentContributorManager`

## ContentList migration (#2451)

`ContentList` no longer holds bespoke local state. `src/svelte/content-list-controller.ts`
is the single adapter every presentation reads from, and one shared
`DataTableController` (from `@happyvertical/smrt-ui/data`) owns search, filters,
sorting, page, and selection.

| Before | After |
|--------|-------|
| local `searchTerm`/`selectedType`/`selectedStatus` runes | controller commands `setSearch` / `setFilters` (stable filter ids `type`, `status`) |
| `filteredContents` `$derived` per view | `toContentListRows` → `selectContentListRows` → `paginateContentListRows`, computed once for all three modes |
| bespoke `<table>` markup in compact mode | smrt-ui `DataTable` with the shared columns plus per-column cell snippets |
| no selection | checkbox selection in every mode via `toggleRowSelection` / `setSelectedRows` |
| `getViewHref` called inline three times | `resolveContentHref` / `contentListRowActions` (one eligibility source) |

Props are unchanged and still exported as `ContentListProps`: `apiBaseUrl`,
`contents`, `type` (still locks and hides the type filter), `defaultViewMode`
(still seeds once), `onEdit`, `onDelete`, `onAdd`, `controls`, `getViewHref`.
New optional props: `loading`, `error`, `onRetry`, and `dataSurface`
(`{ registry, descriptor? }`).

Adapter exports (also re-exported from `./svelte`): `createContentListController`,
`buildContentListColumns`, `buildContentListSurfaceDescriptor`,
`toContentListRows`, `selectContentListRows`, `paginateContentListRows`,
`contentListFilters`, `readContentListFilter`, `applyContentListFilter`,
`contentListRowActions`, `resolveContentHref`, `selectableContentListRowIds`,
`resolveSelectedContentListRows`, `resolveSelectedContents`, plus the
`CONTENT_LIST_*` identity constants.

Notes:

- Controller modes are all `manual`: the adapter owns search, filters, sorting,
  and paging in **every** presentation, and the compact table receives
  `data={pageRows}` plus `totalRows={queryRows.length}`. Letting DataTable
  filter locally over already-filtered rows re-ran the transform with subtly
  different semantics (untrimmed search, its own equality rules), so the two
  presentations could disagree. The component clamps the page with
  `controller.clampPage(queryRows.length)`. #2452 replaces the local
  implementation of that transform with a server query behind the same contract.
- A `type` prop lock is enforced against live state, not just against the prop:
  a data-surface `set-filters` or `reset` command that drops the type filter is
  re-applied by the lock effect (equality-guarded, so it settles).
- Selection may only address durable rows. All three presentations render a
  disabled, explained checkbox for `identified: false` rows, page select-all
  skips them, and a normalization effect re-dispatches `setSelectedRows` without
  any non-durable id, which covers data-surface commands too.
- Compact mode renders a content-owned `select` column (header + cell snippets)
  instead of passing `selectable` to DataTable. DataTable has no per-row
  selection predicate, so its header select-all addresses the synthetic id of an
  unidentified row; the normalization effect then strips it and the header stays
  indeterminate forever. Because column order is reconciled from the
  controller's known column ids, the structural `select` and `actions` ids are
  part of `CONTENT_LIST_TABLE_COLUMN_IDS` — omit them and selection renders
  behind every data column.
- Only rendered columns are published to a data surface. `description` is a
  hidden, search-only column so search still reaches the deck; the descriptor
  additionally declares the `id` row-key column, which the surface contract
  requires but the table never renders.
- Rows without a durable `id` (or repeating one) still render, keyed by
  position, but are marked `identified: false`;
  `resolveSelectedContentListRows` drops them so a bulk action can never act on
  an unaddressable row. `ContentData` has no expiry or site field, so the
  `site` column is derived from `url`/`source`.
- `dataSurface` registers the compact table only. Agent addressability for the
  grid and detailed presentations lands with #2456.
- Compact mode stays mounted for empty and loading results — DataTable renders
  its own `empty` snippet and loading row — because it owns the mounted surface:
  swapping it for the shared empty panel unregisters the surface, and an agent
  whose own search returned nothing then gets `not_found` on the command that
  would undo it. The shared loading/empty panels are the card presentations'
  only; the `error` branch still replaces the list in every mode, since a load
  failure is host-driven rather than surface-driven.

## Dev Server

`npm run dev` starts SvelteKit at `localhost:5173` with 4 pages:

- `/` — Content catalog (CRUD, search, filters, card/list views)
- `/governance` — Policy/profile/assignment management
- `/contributions` — Inbox, submit form, contributor/type management
- `/api-explorer` — Browse 69 endpoints with try-it-live for GET

On startup, `hooks.server.ts` bootstraps schemas for all 13 local classes,
loads cross-package manifests, and seeds 3 sample content items.

## Chat Integration

Content `GET/POST /api/v1/contents/{id}/chat` endpoint creates
chat sessions via `@happyvertical/smrt-chat`. Gracefully handles
missing chat tables (returns `session: null` with notice).
`ContentAgentChat` Svelte component provides the UI.

For global assistant shells, `ContentEditor` and `GovernedContentEditor`
support `onAssistantContextChange`. The callback receives a serializable
`ContentEditorAssistantContext` plus local editor actions, and still fires when
`hideChat={true}`. `ContentAgentChat` can be mounted outside the editor with an
`assistantContext` prop. Server-side consumers can reuse the exported
`getOrCreateContentEditorChatSession`, `createContentEditorChatThread`,
`listContentEditorChatThreadMessages`, and
`sendContentEditorChatThreadMessage` helpers for app-specific tenancy/auth/AI
route wiring.

These handlers go exclusively through the tenant-bound `ChatService` facade
(S5 #1392) — `getAgentSession`/`findActiveAgentSessions`/`getThread`/
`listRoomThreads`/`getThreadMessages` for reads and `startThread`/`sendMessage`/
`sendAgentReply` (internal agent-runtime subpath) for writes. They never reach
into the now-`#private` chat collections, so cross-tenant chat state can no
longer be selected by raw id before authorization.

The content-editor session is created with a content-scoped `sessionKey`
(`contentChatSessionKey(contentId)` → `content:<id>`, S5 #1392). Without it,
`createAgentSession` reuses ANY active `content_editor` session for the same
profile/tenant, so a request about a new content id would reuse — and the
handler would rewrite — a session created for a different content and return the
other content's room/threads. Keying on the content id makes each content get a
distinct session/room.

## Relationship Models

- **ContentReference**: SMRT junction model backing `content_references` for content-to-content links
- **ContentAsset**: dedicated SMRT junction model backing `content_assets` for content-owned asset links

```typescript
await content.addAsset(image, 'thumbnail', 0);  // relationship, sortOrder
await content.getAssets('attachment');
await content.setThumbnail(image);  // convenience: adds asset + updates thumbnailAssetId
await content.addReference(otherContent);                            // unpinned
await content.addReference(otherContent, { targetVersion: 2 });      // pinned to v2
await content.getReferences();
await content.getReferenceDrift();  // → [{ targetId, citedVersion, currentVersion, isDrifted }, ...]
```

## API Contracts

`Content` implements `AssetAssociable` and `MetadataAccessor` (issue #1162). Consumers can type their parameters as `Content` (or the interfaces directly) and rely on the methods existing without `typeof === 'function'` defensive checks:

```typescript
import type { AssetAssociable, MetadataAccessor } from '@happyvertical/smrt-content';

async function attachThumbnail(doc: AssetAssociable, asset: Asset) {
  await doc.addAsset(asset, 'thumbnail', 0); // contract guaranteed
}

function bumpRevision(doc: MetadataAccessor) {
  const meta = doc.getMetadata();
  doc.updateMetadata({ revision: (meta.revision ?? 0) + 1 });
}
```

## Category Navigation

`getCategorySegments()`, `getParentCategory()`, `getRootCategory()`, `getAncestorPaths()`, `isInCategory(path, includeChildren?)`

## Prompt Registry

Content prompts are registered with `@happyvertical/smrt-prompts` so tenants can override template/profile/model/params at runtime:

```typescript
import {
  smrtContentReviewPrompt,             // key: 'smrtContent.review'
  smrtContentApplyCorrectionPrompt,    // key: 'smrtContent.applyCorrection'
  smrtContentThumbnailAIGeneratePrompt, // key: 'smrtContent.thumbnail.aiGenerate'
} from '@happyvertical/smrt-content';
```

`smrtContent.thumbnail.aiGenerate` powers the AI image-generation prompt used by `ThumbnailGenerator` (strategy `'ai-generate'`). Variables substituted into the template: `style`, `title`, `styleHint`, `descriptionClause`. Internal foreign-key fields (`id`, `tenantId`) and the freeform `metadata` blob are intentionally excluded — `metadata` may carry tenant-private configuration or coordinates unrelated to the visual prompt.

## Gotchas

- **STI discriminator**: qualified names like `@happyvertical/smrt-content:Article`
- **Optional tenancy**: `@TenantScoped({ mode: 'optional' })` — null tenantId = global content
- **Metadata is primary extension pattern**: use JSON `metadata` field, not additional class fields
- **Static map coordinates**: uses unary `+` for strict parsing (rejects "45invalid" unlike parseFloat)
- **Review fingerprints**: reviews track content state at review time; stale reviews are detected by fingerprint mismatch
- **Publish readiness enforcement**: `save()` throws `ValidationError` if blocking requirements aren't met when setting status to `'published'`
- **Transparency snapshots**: published transparency is frozen into `ContentVersion.metadata.transparency` — use published for public display, preview for editors
- **Reference pinning**: `ContentReference` is keyed on `(source_id, target_id)`; `targetVersion` is an attribute of the edge, not part of identity. Re-calling `addReference(target, { targetVersion })` updates the pin in place. Unpinned references (`targetVersion: null`) report `isDrifted: false` regardless of how stale the target is — pin them only when you want drift to be detectable.
- **Generated API routes are not tracked**: everything the vite plugin emits under `src/routes/api/v1` is build output, listed in the bounded `.gitignore` block and regenerated on `npm run dev`. The handwritten handlers beside them (`contents/[id]/chat/**`, `images/**`) stay tracked and linted. Do not commit generated routes — they are not Biome-formatted, so tracking them turns the Lint job red (#2198)
- **`pnpm typecheck` regenerates package-owned routes safely**: Svelte's analysis may load dependent package Vite configs, but those configs anchor their root to their own package. Content's generated API routes therefore remain under `src/routes/api/v1` and the bounded `.gitignore` block stays stable (#2199).
- **Tests import generated routes and that is fine**: `contents-api.test.ts` imports `contents/+server.ts` and `contents/[id]/+server.ts` to exercise the generated CRUD handlers against a real SQLite database. The `test` script runs `svelte-kit sync` first, which regenerates the whole route tree, so those files exist by the time Vitest loads — no committed copy needed. Run `pnpm test`, never bare `vitest`, or the imports fail to resolve
- **`generate:test` exists for the callers that bypass `test`**: `scripts/check-coverage.mjs` runs bare `vitest --coverage`, so without a `generate:test` hook the route imports above fail and the Coverage Gate reports `no coverage produced` rather than a real percentage. It is `cache: false` in `packages/content/turbo.json` — the root task's `outputs` describe core's manifest, so a turbo cache hit would restore nothing and silently skip `svelte-kit sync`
- **Chat tables**: chat endpoint requires `@happyvertical/smrt-chat` tables; dev server handles missing tables gracefully
- **Dev server bootstraps all classes**: `hooks.server.ts` generates schemas for all 13 local `@smrt()` classes plus cross-package manifests
