# @happyvertical/smrt-content

STI content types (Article, ContentDocument, Mirror) with governance workflows, contribution intake, fact-checking, AI reviews, transparency reports, and thumbnail generation.

## Installation

```bash
pnpm add @happyvertical/smrt-content
```

## Usage

```typescript
import { Content, Contents, Article, Mirror } from '@happyvertical/smrt-content';
import { contentToString, stringToContent } from '@happyvertical/smrt-content';

// Initialize collection
const contents = await Contents.create({
  db: { url: 'sqlite:./content.db' },
});

// Create and save content
const article = new Article({
  title: 'AI in Content Processing',
  body: 'Large language models have revolutionized...',
  status: 'published',
  tags: ['ai', 'nlp'],
  category: 'technology/ai',
});
await article.initialize();
await article.save();

// Mirror content from a URL (idempotent -- returns existing if already mirrored)
const mirrored = await contents.mirror({
  url: 'https://example.com/article.html',
  context: 'research',
  mirrorDir: './cache',
});

// Upsert by slug + context
const doc = await contents.getOrUpsert({
  slug: 'project-notes',
  context: 'docs',
  title: 'Project Notes',
  body: 'Notes content...',
});

// Thumbnail generation (three strategies)
await contents.generateMissingThumbnails({
  strategy: 'headline-card',
  db: { url: 'sqlite:./content.db' },
});

// Export to markdown with YAML frontmatter
const markdown = contentToString(article);
const parsed = stringToContent(markdown);

// Batch export articles as markdown files
await contents.syncContentDir({ contentDir: './blog-posts' });
```

## Content Governance

```typescript
import {
  Content,
  ContentGovernanceAssignment,
  ContentGovernanceManager,
  GovernedContentEditor,
  configureContentGovernance,
} from '@happyvertical/smrt-content';

configureContentGovernance({
  policies: [
    {
      key: 'editorial',
      label: 'Editorial Review',
      kind: 'custom',
      instructions: 'Check tone, sourcing, and local publication standards.',
    },
  ],
  profiles: [
    {
      key: 'publication',
      label: 'Publication',
      requirements: [
        { policyKey: 'safety', blocking: true },
        { policyKey: 'facts', blocking: true },
        { policyKey: 'editorial', blocking: false },
      ],
    },
  ],
  assignments: [
    {
      contentType: 'article',
      enabled: true,
      factLinkingEnabled: true,
      transparencyEnabled: true,
      publicationProfileKey: 'publication',
      correctionProfileKey: 'correction',
      enforcePublishReadiness: true,
    },
  ],
});

const article = new Content({
  title: 'Transit service changes',
  body: 'Weekend service will resume on April 3.',
  type: 'article',
  metadata: {
    generation: {
      publicPrompt: 'Summarize the service change for riders.',
      aiAssisted: true,
      model: 'gpt-5.4',
    },
  },
});

await article.initialize();
await article.save();
await article.addFact('fact_123', 'supports');
await article.runReviewAction({ kind: 'facts', policyKey: 'facts' });
await article.runReviewAction({ kind: 'safety', policyKey: 'safety' });

article.status = 'published';
await article.save();
```

Governance stays opt-in. Plain `Content` records behave like legacy `smrt-content`
unless an assignment matches their `type` and optional exact `variant`.

Persisted governance definitions are modeled as first-class SMRT objects:

- `ContentGovernancePolicy`
- `ContentGovernanceProfile`
- `ContentGovernanceAssignment`

### Reviews & Corrections

Content reviews are AI-driven quality checks tied to governance policies.
Corrections track post-publication changes with accountability.

```typescript
// Run an AI review against a policy
const review = await article.runReviewAction({
  kind: 'facts',
  policyKey: 'facts',
});
console.log(review.status); // 'accepted' | 'flagged' | 'rejected'
console.log(review.findings); // Array of issues found

// List all reviews for content
const reviews = await article.listReviews();

// Evaluate readiness against a profile
const profiles = await article.listReviewProfilesAction();
const evaluation = await article.evaluateReviewProfile('publication');
console.log(evaluation.ready); // true if all blocking requirements met

// Issue a correction
await article.issueCorrectionAction({
  type: 'correction',
  summary: 'Updated figures to reflect Q4 data',
  note: 'Previous values were from Q3',
});
const corrections = await article.listCorrections();
```

### Versioning

Content versions track snapshots of content state. Publication versions
are created automatically when governed content is published.

```typescript
// Manual version snapshot
await article.mutateVersionAction({
  kind: 'publication',
  summary: 'Content published.',
});

// List version history
const versions = await article.listVersions();

// Restore a previous version
await versions.restoreIntoContent(versionId);
```

### Published Transparency

```typescript
const publishedTransparency = await article.getPublishedTransparencyAction();
const previewTransparency = await article.previewTransparencyAction();

console.log(publishedTransparency?.factsUsed);
console.log(publishedTransparency?.publicationProfileKey);
console.log(previewTransparency.references);
```

Published transparency is frozen into `ContentVersion.metadata.transparency` when a
publication snapshot is created. Built sites should render the published snapshot,
while editors can use the preview snapshot to inspect what will be shown publicly
before publishing.

### Publish Readiness

```typescript
import { evaluateContentPublishReadiness } from '@happyvertical/smrt-content';

const readiness = await evaluateContentPublishReadiness({
  content: article,
  profileKey: 'publication',
});
console.log(readiness.ready);
console.log(readiness.blockingRequirements);
```

When `enforcePublishReadiness` is enabled on a governance assignment,
`content.save()` will throw a `ValidationError` if blocking requirements
are not satisfied when status is set to `'published'`.

### Facts Integration

Content links to facts from `@happyvertical/smrt-facts` when fact-linking
is enabled in governance:

```typescript
// Link a fact to content
await article.addFact('fact_id', 'supports');
await article.addFact('fact_id', 'contradicts');
await article.addFact('fact_id', 'referenced_in');

// Get linked facts
const facts = await article.getFacts({ latestOnly: true });
const factLinks = await article.getFactLinks();

// Sync facts state (used by API)
const factsState = await article.getFactsState();
await article.syncFactsState({ factIds: ['fact1', 'fact2'] });
```

Collection-level fact browsing:

```typescript
const contents = await Contents.create({ db: dbConfig });
const factCatalog = await contents.browseFacts();
```

## Content Contributions

```typescript
import {
  ContentContributionType,
  ContentContributions,
  ContentContributionForm,
  ContentContributionInbox,
  ContentContributionPortal,
  ContentContributionTypeManager,
  ContentContributorManager,
  configureContentContributions,
} from '@happyvertical/smrt-content';

configureContentContributions({
  types: [
    {
      key: 'letter',
      label: 'Letter to the editor',
      enabled: true,
      allowedChannels: ['web', 'email'],
      allowText: true,
      allowFiles: true,
      allowEmptyText: false,
      intakeRules: {
        maxFiles: 3,
        allowedMimePatterns: ['image/*', 'application/pdf'],
        quarantineTextPatterns: ['lawsuit', 'defamation'],
      },
      promotion: {
        targetContentType: 'article',
        targetContentVariant: 'letter',
        targetContentStatus: 'draft',
        autoPromoteTrusted: true,
        createAssets: true,
        assetRelationship: 'attachment',
      },
    },
  ],
});

const contributions = await ContentContributions.create({
  db: { url: 'sqlite:./content.db' },
});

const result = await contributions.submitWebContribution({
  typeKey: 'letter',
  contributorEmail: 'reader@example.com',
  contributorName: 'Reader',
  title: 'A community letter',
  body: 'Please publish this letter.',
  attachments: [
    {
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      size: 1024,
      fileKey: 'uploads/photo.jpg',
    },
  ],
  tenantId: 'tenant-1',
});

const approved = await contributions.get({ id: result.contribution.id });
await approved?.approveAction({
  editorNote: 'Looks good for editorial review.',
  targetStatus: 'draft',
});
```

Content contributions are held separately from editorial `Content` and `Asset`
records until they are promoted. That keeps plain `smrt-content` generic, while
supporting community intake and moderation workflows when an app opts in.

The contribution holding layer adds these first-class SMRT objects:

- `ContentContributionType`
- `ContentContributor`
- `ContentContribution`
- `ContentContributionRevision`
- `ContentContributionAttachment`

Key behavior:

- web and email intake normalize into the same contribution package
- one contribution can contain one primary text submission plus zero or more held files
- asset-only submissions are allowed when the type permits empty text
- contributors are resolved by email and linked to a `Profile`
- trust levels are `standard`, `trusted`, or `blocked`
- intake rules can accept, quarantine, or reject before editorial review
- approval promotes into normal draft `Content` and `Asset` records with provenance metadata
- governance starts after promotion, based on the promoted content `type` and `variant`

## Chat Integration

Content has built-in AI chat via `@happyvertical/smrt-chat`:

```typescript
// API endpoint: GET /api/v1/contents/{id}/chat
// Returns: { session, threads } or { session: null, notice }
// API endpoint: POST /api/v1/contents/{id}/chat
// Creates a new chat thread for the content
```

The `ContentAgentChat` Svelte component provides a chat sidebar in the
content editor. When chat tables aren't provisioned, it gracefully shows
a "not available" notice instead of erroring.

For app-level assistants, `ContentEditor` and `GovernedContentEditor` also
publish a reusable assistant registration through `onAssistantContextChange`.
This works even when `hideChat={true}`:

```svelte
<GovernedContentEditor
  content={article}
  contentId={article.id}
  hideChat
  onAssistantContextChange={(registration) => {
    assistantStore.setContext(registration?.context ?? null);
    assistantStore.setActions(registration?.actions ?? null);
  }}
  onSave={saveArticle}
  onCancel={closeEditor}
/>
```

The registration includes a serializable `ContentEditorAssistantContext`
(`contentId`, draft fields, current editor body, reference IDs, and governed
fact/readiness summaries) plus local actions such as `triggerSave`,
`triggerReview`, `applyFieldUpdates`, and undo for AI-applied field updates.
`ContentAgentChat` can be mounted outside the editor by passing the context:

```svelte
<ContentAgentChat apiBaseUrl="/tenant/api/v1" assistantContext={context} />
```

Server integrations can use `getOrCreateContentEditorChatSession`,
`createContentEditorChatThread`, `listContentEditorChatThreadMessages`, and
`sendContentEditorChatThreadMessage` to install `/contents/:id/chat` routes
with app-specific tenancy, auth, and AI model resolution hooks instead of
copying the package dev-server endpoints.

## Dev Server

The package includes a SvelteKit dev server (`npm run dev`) with:

- **Contents page** (`/`) — Content catalog with search, filters, card/list
  views, and full CRUD. Includes governed article creation.
- **Governance page** (`/governance`) — Policy, profile, and assignment
  management via `ContentGovernanceManager`.
- **Contributions page** (`/contributions`) — Sub-tabbed: editorial inbox,
  public submit form, contributor management, contribution type config.
- **API Explorer page** (`/api-explorer`) — Browse all 69 auto-generated
  REST endpoints grouped by domain, with try-it-live for GET endpoints.

The dev server bootstraps schemas for all 13 local `@smrt()` classes on
startup and seeds sample content (3 items) for immediate testing.

## Svelte Components

### Content Management

| Component | Props | Description |
|-----------|-------|-------------|
| `ContentList` | `contents`, `onEdit`, `onDelete`, `onAdd`, `getViewHref` | Card/list catalog with search, filters, and view toggles |
| `ContentEditor` | `content`, `contentId`, `onSave`, `onCancel` | Full content editor with metadata, assets, references |
| `GovernedContentEditor` | `content`, `contentId`, `onSave`, `onCancel` | Editor with integrated governance panel and review controls |
| `ContentAgentChat` | `contentId`, `apiBasePath` | AI chat sidebar for content with thread management |
| `ArticleCard` | `article` | Card display for an article |
| `ArticleList` | `articles` | List of article cards |
| `ImageThumbnail` | `src`, `alt` | Thumbnail image display |
| `Markdown` | `source` | Markdown renderer |

### Governance

| Component | Props | Description |
|-----------|-------|-------------|
| `ContentGovernanceManager` | *(self-contained)* | Full manager for policies, profiles, and assignments |
| `ContentGovernancePanel` | `contentId` | Governance status panel for a single content item |
| `ContentGovernancePolicyEditor` | `policy`, `onSave` | Editor for a single policy |
| `ContentGovernanceProfileEditor` | `profile`, `onSave` | Editor for a single profile |
| `ContentGovernanceAssignmentEditor` | `assignment`, `onSave` | Editor for a single assignment |
| `ContentTransparencyReport` | `data` | Renders the transparency report for published content |

### Contributions

| Component | Props | Description |
|-----------|-------|-------------|
| `ContentContributionForm` | `types`, `onSubmit`, `onCancel` | Public submission form with file uploads |
| `ContentContributionInbox` | `contributions`, `selectedId`, `onSelect`, `onApprove`, `onReject`, `onRequestChanges` | Editorial inbox with approve/reject/request-changes actions |
| `ContentContributionPortal` | `contributions`, `onSelect`, `onWithdraw` | Contributor-facing submission tracker |
| `ContentContributionTypeManager` | `types`, `onSave`, `onDelete` | Manage contribution types, channels, and promotion settings |
| `ContentContributorManager` | `contributors`, `onSave`, `onDelete` | Manage contributors with trust levels |

## API

### Classes

| Export | Description |
|--------|------------|
| `Content` | STI base model. Fields: `type`, `variant`, `status`, `state`, `category`, `tags`, `metadata`, `thumbnailAssetId` |
| `ContentAsset` | Junction model for canonical content-to-asset ownership in `content_assets` |
| `Article` | STI subclass for editorial content |
| `ContentDocument` | STI subclass for structured documents |
| `Mirror` | STI subclass for mirrored/cached external content |
| `Contents` | Collection with `mirror()`, `syncContentDir()`, `generateMissingThumbnails()`, `findWithGlobals()`, `getOrUpsert()`, `browseFacts()`, `getGovernanceDefinitionsAction()`, `resolveGovernanceAction()` |
| `ContentReference` | Junction model for content-to-content links |
| `ContentReview` | AI review result tied to a governance policy |
| `ContentCorrection` | Post-publication correction record |
| `ContentVersion` | Content snapshot with kind (`'publication'`, `'manual'`) and transparency metadata |
| `ContentContribution` | Held inbound submission with approval, rejection, withdrawal, and promotion actions |
| `ContentContributions` | Contribution collection with web intake, email ingestion, inbox, and contributor views |
| `ContentContributionType` | Persisted contribution-type override for app-defined intake rules and promotion mapping |
| `ContentContributor` | Contributor profile/trust record resolved by email |
| `ContentContributionRevision` | Revision history for held submissions |
| `ContentContributionAttachment` | Held file metadata that only becomes an `Asset` on promotion |
| `ContentGovernancePolicy` | Persisted review policy definition |
| `ContentGovernanceProfile` | Persisted review profile with requirements |
| `ContentGovernanceAssignment` | Persisted governance assignment for content type/variant |
| `ThumbnailGenerator` | Generates thumbnails via `headline-card`, `static-map`, or `ai-generate` strategies |

### Content Instance Methods

| Method | Description |
|--------|-------------|
| `resolveGovernance()` | Resolve effective governance for this content's type/variant |
| `runReviewAction(options)` | Run an AI review against a policy |
| `listReviews()` | List all reviews for this content |
| `listReviewProfilesAction()` | Get review readiness for all profiles |
| `evaluateReviewProfile(key)` | Evaluate one profile's requirements |
| `issueCorrectionAction(options)` | Issue a post-publication correction |
| `listCorrections()` | List corrections for this content |
| `listVersions()` | List version history |
| `mutateVersionAction(options)` | Create a version snapshot |
| `getPublishedTransparencyAction()` | Get frozen transparency data |
| `previewTransparencyAction()` | Preview live transparency state |
| `addFact(factId, relationship)` | Link a fact to this content |
| `getFacts(options)` | Get linked facts |
| `getFactLinks()` | Get fact-content link records |
| `getFactsState()` | Get full facts state (API) |
| `syncFactsState(options)` | Sync fact links (API) |
| `getAssets(relationship?)` | Get associated assets |
| `addAsset(asset, relationship, sortOrder)` | Add asset association |
| `removeAsset(assetId, relationship?)` | Remove asset association |
| `setThumbnail(image)` | Set thumbnail (adds asset + updates `thumbnailAssetId`) |
| `generateThumbnail(options)` | Generate a thumbnail |
| `addReference(content)` | Link to another content |
| `getReferences()` | Get content references |

### Types

| Export | Description |
|--------|------------|
| `ContentOptions` | Options for `Content` constructor |
| `ContentsOptions` | Options for `Contents.create()` |
| `ThumbnailStrategy` | `'headline-card' \| 'static-map' \| 'ai-generate'` |
| `ThumbnailOptions` | Union of strategy-specific option types |
| `HeadlineCardThumbnailOptions` | Options for headline-card strategy |
| `StaticMapThumbnailOptions` | Options for static-map strategy |
| `AIGenerateThumbnailOptions` | Options for ai-generate strategy |
| `ContentContributionTypeDefinition` | App-defined contribution type shape |
| `ContentGovernanceConfig` | Shape passed to `configureContentGovernance()` |
| `ContentGovernanceState` | Resolved governance state for a content item |
| `ContentReviewResult` | AI review output with findings |
| `ContentReviewFinding` | Individual issue from a review |
| `ContentCorrectionType` | `'correction' \| 'retraction' \| 'update' \| 'clarification'` |
| `ContentVersionKind` | `'publication' \| 'manual'` |
| `ContentTransparencyData` | Full transparency report data shape |
| `ContentPublishReadinessState` | Profile evaluation result |

### Utilities

| Export | Description |
|--------|------------|
| `contentToString(content)` | Serialize content to markdown with YAML frontmatter |
| `stringToContent(str)` | Parse markdown with frontmatter back to content data |
| `configureContentGovernance(config)` | Define default governance policies, profiles, and assignments |
| `configureContentContributions(config)` | Define default contribution types and intake rules |
| `evaluateContentPublishReadiness(options)` | Evaluate publication readiness against a profile |
| `normalizeContentTransparency(raw)` | Normalize raw transparency data into standard shape |

## Auto-Generated Endpoints

The `@smrt()` decorator generates REST API, MCP tools, and CLI commands.

### Content Endpoints (instance-level)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/contents` | List contents |
| POST | `/api/v1/contents` | Create content |
| GET | `/api/v1/contents/{id}` | Get content |
| PUT | `/api/v1/contents/{id}` | Update content |
| DELETE | `/api/v1/contents/{id}` | Delete content |
| GET | `/api/v1/contents/{id}/facts` | Get facts state |
| PUT | `/api/v1/contents/{id}/facts` | Sync facts state |
| GET | `/api/v1/contents/{id}/governance` | Get governance state |
| GET | `/api/v1/contents/{id}/reviews` | List reviews |
| POST | `/api/v1/contents/{id}/reviews` | Run AI review |
| GET | `/api/v1/contents/{id}/review-profiles` | Review readiness |
| GET | `/api/v1/contents/{id}/review-profiles/{profileKey}` | Evaluate profile |
| GET | `/api/v1/contents/{id}/transparency` | Published transparency |
| GET | `/api/v1/contents/{id}/transparency/preview` | Preview transparency |
| GET | `/api/v1/contents/{id}/corrections` | List corrections |
| POST | `/api/v1/contents/{id}/corrections` | Issue correction |
| GET | `/api/v1/contents/{id}/versions` | List versions |
| POST | `/api/v1/contents/{id}/versions` | Create version |

### Collection Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/contents/by-slug?slug=...` | Get by slug |
| GET | `/api/v1/contents/facts` | Browse fact catalog |
| GET | `/api/v1/contents/governance` | Governance definitions |
| GET | `/api/v1/contents/governance/resolve?type=...` | Resolve governance |

All SMRT models (`ContentGovernancePolicy`, `ContentContribution`, etc.)
also get standard CRUD + custom collection-level endpoints.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@happyvertical/smrt-core` | ORM base (SmrtObject, SmrtCollection) |
| `@happyvertical/smrt-assets` | Asset association support |
| `@happyvertical/smrt-images` | Image/thumbnail creation |
| `@happyvertical/smrt-facts` | Fact linking and browsing |
| `@happyvertical/smrt-chat` | Content chat sessions and threads |
| `@happyvertical/smrt-messages` | Email ingestion for contribution intake |
| `@happyvertical/smrt-profiles` | Contributor/profile resolution by email |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/documents` | Document fetching and text extraction |
| `@happyvertical/files` | Filesystem operations |
| `@happyvertical/geo` | Static map thumbnails |
| `@happyvertical/images` | Headline card rendering |
| `yaml` | YAML frontmatter parsing |
