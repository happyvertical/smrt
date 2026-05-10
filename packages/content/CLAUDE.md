# @happyvertical/smrt-content

STI content management with governance workflows, contribution intake, AI reviews, fact-checking, corrections, versioning, transparency reports, and thumbnail generation.

## Models

- **Content** (STI base): `type`, `variant` (generator:domain:specific format), `status` (published/draft/review/archived/deleted), `state`, `category` (hierarchical path with `/` separator), `metadata` JSON, `tags` array, `thumbnailAssetId`
- **Article**, **ContentDocument**, **Mirror**: STI subclasses — all share `contents` table via `_meta_type`
- **ContentReview**: AI review result tied to a governance policy. Fields: `contentId`, `policyKey`, `kind`, `status` (accepted/flagged/rejected), `findings`, `fingerprint`, `metadata`
- **ContentCorrection**: Post-publication change record. Fields: `contentId`, `type` (correction/retraction/update/clarification), `summary`, `note`, `status`, `metadata`
- **ContentVersion**: Content snapshot. Fields: `contentId`, `kind` (publication/manual), `versionNumber`, `summary`, `metadata` (includes `transparency` for publication versions)
- **ContentReference**: Junction model for content-to-content links (`content_references` table)
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
| `addReference(content)` | Link to another content |
| `getReferences()` | Get content references |

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

## Svelte Components (19 total)

### Content Management
`ContentList`, `ContentEditor`, `GovernedContentEditor`, `ContentAgentChat`, `ArticleCard`, `ArticleList`, `ImageThumbnail`, `Markdown`

### Governance
`ContentGovernanceManager`, `ContentGovernancePanel`, `ContentGovernancePolicyEditor`, `ContentGovernanceProfileEditor`, `ContentGovernanceAssignmentEditor`, `ContentTransparencyReport`

### Contributions
`ContentContributionForm`, `ContentContributionInbox`, `ContentContributionPortal`, `ContentContributionTypeManager`, `ContentContributorManager`

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

## Relationship Models

- **ContentReference**: SMRT junction model backing `content_references` for content-to-content links
- **ContentAsset**: dedicated SMRT junction model backing `content_assets` for content-owned asset links

```typescript
await content.addAsset(image, 'thumbnail', 0);  // relationship, sortOrder
await content.getAssets('attachment');
await content.setThumbnail(image);  // convenience: adds asset + updates thumbnailAssetId
await content.addReference(otherContent);
await content.getReferences();
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
- **Chat tables**: chat endpoint requires `@happyvertical/smrt-chat` tables; dev server handles missing tables gracefully
- **Dev server bootstraps all classes**: `hooks.server.ts` generates schemas for all 13 local `@smrt()` classes plus cross-package manifests
