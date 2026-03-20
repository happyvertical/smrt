# @happyvertical/smrt-content

STI content types (Article, ContentDocument, Mirror) with thumbnail generation, asset associations, and markdown serialization.

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

The package also exports reusable Svelte components for consuming-app control
panels and editorial workflows:

- `GovernedContentEditor`
- `ContentGovernancePanel`
- `ContentGovernanceManager`
- `ContentGovernancePolicyEditor`
- `ContentGovernanceProfileEditor`
- `ContentGovernanceAssignmentEditor`

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

Reusable Svelte exports for consuming apps:

- `ContentContributionForm`
- `ContentContributionPortal`
- `ContentContributionInbox`
- `ContentContributionTypeManager`
- `ContentContributorManager`

## API

### Classes

| Export | Description |
|--------|------------|
| `Content` | STI base model. Fields: `type`, `variant`, `status`, `state`, `category`, `tags`, `metadata`, `thumbnailAssetId` |
| `Article` | STI subclass for editorial content |
| `ContentDocument` | STI subclass for structured documents |
| `Mirror` | STI subclass for mirrored/cached external content |
| `Contents` | Collection with `mirror()`, `syncContentDir()`, `generateMissingThumbnails()`, `findWithGlobals()`, `getOrUpsert()` |
| `ContentContribution` | Held inbound submission with approval, rejection, withdrawal, and promotion actions |
| `ContentContributions` | Contribution collection with web intake, email ingestion, inbox, and contributor views |
| `ContentContributionType` | Persisted contribution-type override for app-defined intake rules and promotion mapping |
| `ContentContributor` | Contributor profile/trust record resolved by email |
| `ContentContributionRevision` | Revision history for held submissions |
| `ContentContributionAttachment` | Held file metadata that only becomes an `Asset` on promotion |
| `ThumbnailGenerator` | Generates thumbnails via `headline-card`, `static-map`, or `ai-generate` strategies |

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
| `ContentContributionTypeDefinition` | App-defined contribution type shape passed to `configureContentContributions()` |

### Utilities

| Export | Description |
|--------|------------|
| `contentToString(content)` | Serialize content to markdown with YAML frontmatter |
| `stringToContent(str)` | Parse markdown with frontmatter back to content data |
| `configureContentGovernance(config)` | Define default governance policies, profiles, and assignments |
| `configureContentContributions(config)` | Define default contribution types and intake rules |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@happyvertical/smrt-core` | ORM base (SmrtObject, SmrtCollection) |
| `@happyvertical/smrt-assets` | Asset association support |
| `@happyvertical/smrt-images` | Image/thumbnail creation |
| `@happyvertical/smrt-messages` | Email ingestion and attachment normalization for contribution intake |
| `@happyvertical/smrt-profiles` | Contributor/profile resolution by email |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/documents` | Document fetching and text extraction |
| `@happyvertical/files` | Filesystem operations |
| `@happyvertical/geo` | Static map thumbnails |
| `@happyvertical/images` | Headline card rendering |
| `yaml` | YAML frontmatter parsing |
