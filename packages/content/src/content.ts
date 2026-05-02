import { type Asset, AssetCollection } from '@happyvertical/smrt-assets';
import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  field,
  SmrtObject,
  smrt,
  ValidationError,
} from '@happyvertical/smrt-core';
import type { Fact, FactContentRelationship } from '@happyvertical/smrt-facts';
import type { Image } from '@happyvertical/smrt-images';
import { ImageCollection } from '@happyvertical/smrt-images';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AssetAssociable, MetadataAccessor } from './asset-associable';
import { isPlainMetadataRecord } from './asset-associable';
import { ContentAssetCollection } from './content-assets';
import {
  buildContentGovernanceAssignmentKey,
  buildContentReviewPrompt,
  type ContentGovernanceState,
  type ContentReviewProfileEvaluation,
  type CreateContentVersionOptions,
  getAcceptedContentReviewStatuses,
  getContentReviewKind,
  getContentReviewPolicy,
  getContentReviewProfileKeys,
  getContentReviewRequirements,
  type IssueContentCorrectionOptions,
  parseContentReviewResponse,
  type ResolvedContentGovernance,
  type RunContentReviewOptions,
  resolveConfiguredContentGovernance,
  resolveEffectiveContentGovernance,
} from './content-governance';
import {
  promptMessageOptions,
  smrtContentApplyCorrectionPrompt,
  smrtContentReviewPrompt,
} from './content-prompts';
import { ContentReferences } from './content-references';
import type { ContentReview } from './content-review';
import { normalizeContentTransparency } from './content-transparency';
import { isMissingTableError } from './database-utils';
import {
  serializeContent,
  serializeContentCorrection,
  serializeContentReview,
  serializeContentVersion,
  serializeFact,
  serializeFactLink,
} from './serialization';
import type { ThumbnailOptions } from './thumbnail-generator';
import { ThumbnailGenerator } from './thumbnail-generator';

const USED_FACT_RELATIONSHIPS = new Set<FactContentRelationship>([
  'supports',
  'referenced_in',
  'contradicts',
]);

function normalizeFingerprintValue(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeFingerprintValue(entry));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [
          key,
          normalizeFingerprintValue(entryValue),
        ]),
    );
  }

  return value ?? null;
}

function hashFingerprint(input: string): string {
  let hash = 5381;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }

  return `fp-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function createFingerprint(value: unknown): string {
  return hashFingerprint(JSON.stringify(normalizeFingerprintValue(value)));
}

function getPublicPrompt(metadata: Record<string, any>): string | null {
  return (
    metadata?.transparency?.generation?.publicPrompt ||
    metadata?.generation?.publicPrompt ||
    metadata?.publicPrompt ||
    null
  );
}

/**
 * Options for Content initialization
 */
export interface ContentOptions extends SmrtObjectOptions {
  /**
   * Content type classification
   */
  type?: string | null;

  /**
   * Content variant for namespaced classification within types
   * Format: generator:domain:specific-type
   * Example: "praeco:meeting:upcoming"
   */
  variant?: string | null;

  /**
   * Reference to file storage key
   */
  fileKey?: string | null;

  /**
   * Author of the content
   */
  author?: string | null;

  /**
   * Content title
   */
  title?: string | null;

  /**
   * Short description or summary
   */
  description?: string | null;

  /**
   * Main content body text
   */
  body?: string | null;

  /**
   * Date when content was published
   */
  publish_date?: Date | null;

  /**
   * URL source of the content
   */
  url?: string | null;

  /**
   * Original source identifier
   */
  source?: string | null;

  /**
   * Publication status
   */
  status?: 'published' | 'draft' | 'review' | 'archived' | 'deleted' | null;

  /**
   * Content state flag
   */
  state?: 'deprecated' | 'active' | 'highlighted' | null;

  /**
   * Original URL of the content
   */
  original_url?: string | null;

  /**
   * Content language
   */
  language?: string | null;

  /**
   * Content tags
   */
  tags?: string[];

  /**
   * Hierarchical category path for URL routing
   * Format: 'parent/child' (e.g., 'politics/local')
   * Each content belongs to exactly ONE category
   */
  category?: string | null;

  /**
   * Additional metadata
   */
  metadata?: Record<string, any>;

  /**
   * ID of the thumbnail asset for this content
   */
  thumbnailAssetId?: string | null;

  /**
   * Transient reference IDs used by editors and API payloads.
   * These are synchronized into ContentReference links during save.
   */
  referenceIds?: string[];

  /**
   * Transient asset IDs used by editors and API payloads.
   */
  assetIds?: string[];

  /**
   * Tenant ID for multi-tenant isolation
   */
  tenantId?: string | null;
}

/**
 * Structured content object with metadata and body text
 *
 * Content represents any text-based content with metadata such as
 * title, author, description, and publishing information. It supports
 * referencing related content objects.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'getFactsState',
      'syncFactsState',
      'getGovernanceStateAction',
      'listReviews',
      'runReviewAction',
      'listReviewProfilesAction',
      'evaluateReviewProfileAction',
      'getPublishedTransparencyAction',
      'previewTransparencyAction',
      'listCorrections',
      'issueCorrectionAction',
      'listVersions',
      'mutateVersionAction',
    ],
    routes: {
      getFactsState: { method: 'GET', path: 'facts' },
      syncFactsState: { method: 'PUT', path: 'facts' },
      getGovernanceStateAction: { method: 'GET', path: 'governance' },
      listReviews: { method: 'GET', path: 'reviews' },
      runReviewAction: { method: 'POST', path: 'reviews' },
      listReviewProfilesAction: { method: 'GET', path: 'review-profiles' },
      evaluateReviewProfileAction: {
        method: 'GET',
        path: 'review-profiles/[profileKey]',
      },
      getPublishedTransparencyAction: {
        method: 'GET',
        path: 'transparency',
      },
      previewTransparencyAction: {
        method: 'GET',
        path: 'transparency/preview',
      },
      listCorrections: { method: 'GET', path: 'corrections' },
      issueCorrectionAction: { method: 'POST', path: 'corrections' },
      listVersions: { method: 'GET', path: 'versions' },
      mutateVersionAction: { method: 'POST', path: 'versions' },
    },
    serializers: {
      item: {
        importPath: '$lib/server/content-api-serializers',
        exportName: 'serializeContent',
      },
    },
  },
  mcp: {
    include: ['list', 'get', 'create', 'update'], // AI tools for content management
  },
  cli: true, // Enable CLI commands for content management
})
export class Content
  extends SmrtObject
  implements AssetAssociable, MetadataAccessor
{
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global content
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Array of referenced content objects
   */
  protected references: Content[] = [];

  /**
   * Content type classification
   */
  public type: string | null = null;

  /**
   * Content variant for namespaced classification within types
   * Format: generator:domain:specific-type
   * Example: "praeco:meeting:upcoming"
   */
  public variant: string | null = null;

  /**
   * Reference to file storage key
   */
  public fileKey: string | null = null;

  /**
   * Author of the content
   */
  public author: string | null = null;

  /**
   * Human-readable name for SMRT framework compatibility
   */
  @field({ required: true })
  public name: string = '';

  /**
   * Content title
   */
  public title = '';

  /**
   * Short description or summary
   */
  public description: string | null = null;

  /**
   * Main content body text
   */
  public body = '';

  /**
   * Date when content was published
   */
  public publish_date: Date | null = null;

  /**
   * URL source of the content
   */
  public url: string | null = null;

  /**
   * Original source identifier
   */
  public source: string | null = null;

  /**
   * Original URL of the content
   */
  public original_url: string | null = null;

  /**
   * Content language
   */
  public language: string | null = null;

  /**
   * Content tags
   */
  public tags: string[] = [];

  /**
   * Hierarchical category path for URL routing
   * Format: 'parent/child' (e.g., 'politics/local')
   * Each content belongs to exactly ONE category
   */
  public category: string | null = null;

  /**
   * Publication status
   */
  public status: 'published' | 'draft' | 'review' | 'archived' | 'deleted' =
    'draft';

  /**
   * Content state flag
   */
  public state: 'deprecated' | 'active' | 'highlighted' = 'active';

  /**
   * Additional JSON metadata for flexible schema extension
   */
  public metadata: Record<string, any> = {};

  /**
   * ID of the thumbnail asset for this content
   */
  public thumbnailAssetId: string | null = null;

  /**
   * Creates a new Content instance
   */
  constructor(options: ContentOptions = {}) {
    super(options);
    this.type = options.type || null;
    this.variant = options.variant || null;
    this.fileKey = options.fileKey || null;
    this.author = options.author || null;
    if (options.name) this.name = options.name;
    this.title = options.title || '';
    this.description = options.description || null;
    this.body = options.body || '';
    this.publish_date = options.publish_date || null;
    this.source = options.source || null;
    this.original_url = options.original_url || null;
    this.language = options.language || null;
    this.status = options.status || 'draft';
    this.tags = options.tags || [];
    this.category = options.category || null;
    this.state = options.state || 'active';
    this.metadata = options.metadata || {};
    this.thumbnailAssetId = options.thumbnailAssetId ?? null;
    if (Array.isArray(options.referenceIds)) {
      (this as any).referenceIds = [...options.referenceIds];
    }
    if (Array.isArray(options.assetIds)) {
      (this as any).assetIds = [...options.assetIds];
    }
  }

  /**
   * Initializes this content object
   *
   * @returns Promise that resolves to this instance
   */
  async initialize(): Promise<this> {
    await super.initialize();
    return this;
  }

  protected override async validateBeforeSave(): Promise<void> {
    if (!this.name && this.title) {
      this.name = this.title;
    }

    if (!this.title && this.name) {
      this.title = this.name;
    }

    await super.validateBeforeSave();

    if (this.status !== 'published') {
      return;
    }

    const governance = await this.resolvePublicationGovernance();
    const profileKey = governance?.publicationProfileKey;

    if (
      !governance?.isGoverned ||
      !governance.enforcePublishReadiness ||
      !profileKey
    ) {
      return;
    }

    const evaluation = await this.evaluateReviewProfile(profileKey);
    const blockingRequirements = evaluation.requirements.filter(
      (requirement) => requirement.blocking && !requirement.satisfied,
    );

    if (blockingRequirements.length === 0) {
      return;
    }

    const details = blockingRequirements.map((requirement) => {
      if (requirement.missing) {
        return `${requirement.label} has not been run yet`;
      }

      if (requirement.stale) {
        return `${requirement.label} is stale and must be rerun`;
      }

      if (requirement.latestStatus) {
        return `${requirement.label} returned ${requirement.latestStatus}`;
      }

      return `${requirement.label} is not satisfied`;
    });

    throw new ValidationError(
      `Cannot publish content until the "${profileKey}" review profile is satisfied. ${details.join('; ')}`,
      'VALIDATION_PUBLISH_READINESS',
      {
        profileKey,
        blockingRequirements: blockingRequirements.map((requirement) => ({
          policyKey: requirement.policyKey,
          label: requirement.label,
          missing: requirement.missing,
          stale: requirement.stale,
          latestStatus: requirement.latestStatus,
        })),
      },
    );
  }

  override async save() {
    const shouldConsiderPublicationSnapshot = this.status === 'published';

    let governance: ResolvedContentGovernance | null = null;
    let previous: Content | null = null;
    let previousPublicationFingerprint: string | null = null;

    if (shouldConsiderPublicationSnapshot) {
      governance = await this.resolvePublicationGovernance();

      if (governance?.isGoverned && governance.transparencyEnabled) {
        previous = await this.getPersistedContent();
        previousPublicationFingerprint =
          await this.getLatestPublicationSnapshotFingerprint();
      }
    }

    await super.save();
    await this.syncPendingReferenceIds();
    await this.syncPendingAssetIds();

    if (
      !shouldConsiderPublicationSnapshot ||
      !governance?.isGoverned ||
      !governance.transparencyEnabled
    ) {
      return this;
    }

    const nextPublicationFingerprint =
      await this.buildPublicationSnapshotFingerprint(governance);

    if (
      nextPublicationFingerprint &&
      nextPublicationFingerprint !== previousPublicationFingerprint
    ) {
      await this.createVersion({
        kind: 'publication',
        summary:
          previous?.status === 'published'
            ? 'Published content updated.'
            : 'Content published.',
        metadata: {
          publicationSnapshotFingerprint: nextPublicationFingerprint,
          publicationProfileKey: governance.publicationProfileKey,
          transparency: await this.buildTransparencySnapshot({
            snapshotKind: 'published',
            governance,
          }),
        },
      });
    }

    return this;
  }

  private async getReferenceCollection() {
    return ContentReferences.create({ db: this.db });
  }

  private async getFactCollection() {
    const { FactCollection } = await import('@happyvertical/smrt-facts');
    return FactCollection.create(this.options);
  }

  private async getFactContentCollection() {
    const { FactContentCollection } = await import('@happyvertical/smrt-facts');
    return FactContentCollection.create(this.options);
  }

  private async getFactSourceCollection() {
    const { FactSourceCollection } = await import('@happyvertical/smrt-facts');
    return FactSourceCollection.create(this.options);
  }

  private async getContentVersionCollection() {
    const { ContentVersionCollection } = await import('./content-versions');
    return ContentVersionCollection.create(this.options);
  }

  private async getContentReviewCollection() {
    const { ContentReviewCollection } = await import('./content-reviews');
    return ContentReviewCollection.create(this.options);
  }

  private async getContentCorrectionCollection() {
    const { ContentCorrectionCollection } = await import(
      './content-corrections'
    );
    return ContentCorrectionCollection.create(this.options);
  }

  private async getContentsCollection() {
    const { Contents } = await import('./contents');
    return Contents.create({ db: this.db });
  }

  private getConfiguredGovernance(): ResolvedContentGovernance {
    return resolveConfiguredContentGovernance({
      contentType: this.type,
      contentVariant: this.variant,
    });
  }

  public async resolveGovernance(): Promise<ResolvedContentGovernance> {
    return resolveEffectiveContentGovernance({
      contentType: this.type,
      contentVariant: this.variant,
      db: this.db,
    });
  }

  private async hasPersistedGovernanceAssignments(): Promise<boolean> {
    if (!this.db || typeof this.db.query !== 'function') {
      return false;
    }

    try {
      const exactKey = buildContentGovernanceAssignmentKey(
        this.type || '',
        this.variant || '',
      );
      const typeOnlyKey = buildContentGovernanceAssignmentKey(this.type || '');
      const keys =
        exactKey === typeOnlyKey ? [exactKey] : [exactKey, typeOnlyKey];
      const placeholders = keys.map(() => '?').join(', ');
      const result = await this.db.query(
        `SELECT 1 AS matched FROM content_governance_assignments WHERE key IN (${placeholders}) LIMIT 1`,
        keys,
      );
      const rows = Array.isArray(result) ? result : (result?.rows ?? []);
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  private async resolvePublicationGovernance(): Promise<ResolvedContentGovernance | null> {
    const configuredGovernance = this.getConfiguredGovernance();

    if (configuredGovernance.isGoverned) {
      return this.resolveGovernance();
    }

    if (!(await this.hasPersistedGovernanceAssignments())) {
      return null;
    }

    const governance = await this.resolveGovernance();
    return governance.isGoverned ? governance : null;
  }

  private async requireGovernance(
    feature = 'governance workflow',
  ): Promise<ResolvedContentGovernance> {
    const governance = await this.resolveGovernance();

    if (!governance.isGoverned) {
      throw new Error(
        `Governance is not enabled for content type "${this.type || 'content'}"${this.variant ? ` variant "${this.variant}"` : ''}, so ${feature} is unavailable.`,
      );
    }

    return governance;
  }

  private async requireFactLinking(
    feature = 'fact linking',
  ): Promise<ResolvedContentGovernance> {
    const governance = await this.requireGovernance(feature);

    if (!governance.factLinkingEnabled) {
      throw new Error(
        `Fact linking is not enabled for content type "${this.type || 'content'}"${this.variant ? ` variant "${this.variant}"` : ''}.`,
      );
    }

    return governance;
  }

  private async getPersistedContent(): Promise<Content | null> {
    if (!this.id) {
      return null;
    }

    const contents = await this.getContentsCollection();
    return (await contents.get({ id: this.id as string })) as Content | null;
  }

  private async buildReviewFingerprint(policyKey: string): Promise<string> {
    const governance = await this.resolveGovernance();
    const kind = getContentReviewKind(policyKey, governance.reviewPolicies);
    const policy = getContentReviewPolicy(policyKey, governance.reviewPolicies);
    const [references, facts, factLinks] = await Promise.all([
      this.getReferences(),
      kind === 'facts' && governance.factLinkingEnabled
        ? this.getFacts({
            latestOnly: true,
            includeSuperseded: false,
          })
        : Promise.resolve([]),
      kind === 'facts' && governance.factLinkingEnabled
        ? this.getFactLinks()
        : Promise.resolve([]),
    ]);

    return createFingerprint({
      scope: 'content-review',
      policyKey,
      kind,
      policyInstructions: policy?.instructions || '',
      content: {
        id: this.id || null,
        type: this.type,
        variant: this.variant,
        title: this.title,
        description: this.description,
        body: this.body,
        author: this.author,
        state: this.state,
        publishDate: this.publish_date,
        language: this.language,
        category: this.category,
        tags: this.tags,
        metadata: this.metadata,
      },
      referenceIds: references
        .map((reference) => reference.id)
        .filter(Boolean)
        .sort(),
      facts: facts.map((fact: any) => ({
        id: fact.id || null,
        parentId: fact.parentId || null,
        status: fact.status || null,
        textRefined: fact.textRefined || '',
        sourceCount: fact.sourceCount ?? 0,
        confidence: fact.confidence ?? null,
        metadata:
          typeof fact?.getMetadata === 'function' ? fact.getMetadata() : {},
      })),
      factLinks: factLinks.map((link: any) => ({
        factId: link.factId || null,
        relationship: link.relationship || null,
        metadata:
          typeof link?.getMetadata === 'function' ? link.getMetadata() : {},
      })),
    });
  }

  private async buildTransparencySnapshot(
    options: {
      snapshotKind?: 'preview' | 'published';
      governance?: ResolvedContentGovernance;
    } = {},
  ) {
    const snapshotKind = options.snapshotKind || 'preview';
    const governance = options.governance || (await this.resolveGovernance());

    if (!governance.isGoverned || !governance.transparencyEnabled) {
      return null;
    }

    const [
      references,
      facts,
      factLinks,
      reviews,
      corrections,
      versions,
      reviewProfiles,
    ] = await Promise.all([
      this.getReferences(),
      governance.factLinkingEnabled
        ? this.getFacts({
            latestOnly: true,
            includeSuperseded: false,
          })
        : Promise.resolve([]),
      governance.factLinkingEnabled ? this.getFactLinks() : Promise.resolve([]),
      this.listReviews(),
      this.listCorrections(),
      this.listVersions(),
      this.listReviewProfilesAction(),
    ]);

    const factSources = await this.getFactSourceCollection();
    const factSourcesByFactId = new Map<string, any[]>();

    for (const fact of facts) {
      const factId = fact.id as string | undefined;
      if (!factId) {
        continue;
      }

      const sources = await factSources.getForFact(factId);
      factSourcesByFactId.set(factId, sources);
    }

    const usedFactIds = new Set(
      factLinks
        .filter((link: any) =>
          USED_FACT_RELATIONSHIPS.has(
            (link.relationship || 'related') as FactContentRelationship,
          ),
        )
        .map((link: any) => link.factId)
        .filter(Boolean),
    );

    const linkedFacts = facts.map((fact: any) => {
      const factId = fact.id as string | undefined;
      const link = factLinks.find((entry: any) => entry.factId === factId);
      const sources = (factId ? factSourcesByFactId.get(factId) : []) || [];

      return {
        ...serializeFact(fact),
        relationship: link?.relationship || null,
        linkMetadata:
          typeof link?.getMetadata === 'function' ? link.getMetadata() : {},
        usedInArticle: factId ? usedFactIds.has(factId) : false,
        sources: sources.map((source: any) => ({
          id: source.id || null,
          sourceType: source.sourceType || null,
          sourceUrl: source.sourceUrl || null,
          sourceTitle: source.sourceTitle || null,
          credibility: source.credibility ?? null,
          extractedAt: source.extractedAt || null,
          metadata:
            typeof source?.getMetadata === 'function'
              ? source.getMetadata()
              : {},
        })),
      };
    });

    const referenceGroups = await Promise.all(
      references.map(async (reference) => {
        const sourceUrls = [
          reference.url,
          reference.original_url,
          reference.source,
        ].filter(Boolean) as string[];

        const extractedFacts = new Map<string, any>();
        for (const sourceUrl of sourceUrls) {
          const matches = await factSources.list({
            where: { sourceUrl },
            orderBy: 'created_at ASC',
          });

          for (const match of matches) {
            if (!match.factId || extractedFacts.has(match.factId)) {
              continue;
            }

            const fact = await match.getFact();
            if (fact?.id) {
              extractedFacts.set(fact.id as string, fact);
            }
          }
        }

        const extractedFactRecords = [...extractedFacts.values()].map(
          (fact) => {
            const factId = fact.id as string | undefined;
            return {
              ...serializeFact(fact),
              usedInArticle: factId ? usedFactIds.has(factId) : false,
            };
          },
        );

        return {
          id: reference.id || null,
          title: reference.title || reference.name || reference.url || null,
          url: reference.url || null,
          originalUrl: reference.original_url || null,
          type: reference.type || null,
          source: reference.source || null,
          usedFactIds: extractedFactRecords
            .filter((fact: any) => fact.id && usedFactIds.has(fact.id))
            .map((fact: any) => fact.id),
          extractedFacts: extractedFactRecords,
        };
      }),
    );

    const publicGeneration = (this.metadata?.transparency?.generation ??
      {}) as Record<string, any>;
    const generationMetadata = (this.metadata?.generation ?? {}) as Record<
      string,
      any
    >;
    const serializedCorrections = corrections
      .filter((correction: any) => correction.status === 'published')
      .map((correction: any) => {
        const correctionMetadata =
          typeof correction?.getMetadata === 'function'
            ? correction.getMetadata()
            : (correction.metadata as Record<string, any>) || {};

        return {
          ...serializeContentCorrection(correction),
          provenance: {
            autoGeneratedDraft: Boolean(correctionMetadata.autoGeneratedDraft),
            draftVersionId: correctionMetadata.draftVersionId || null,
            draftVersionNumber: correctionMetadata.draftVersionNumber || null,
            sourceCorrectionVersionId:
              correctionMetadata.sourceCorrectionVersionId || null,
            sourceCorrectionVersionNumber:
              correctionMetadata.sourceCorrectionVersionNumber || null,
          },
        };
      });
    const serializedVersionHistory = versions.map((version: any) => {
      const versionMetadata =
        typeof version?.getMetadata === 'function'
          ? version.getMetadata()
          : (version.metadata as Record<string, any>) || {};

      return {
        id: version.id || null,
        version: version.version ?? null,
        kind: version.kind || null,
        summary: version.summary || '',
        createdAt: version.createdAt || null,
        provenance: {
          policyKey: versionMetadata.policyKey || null,
          reviewFingerprint:
            versionMetadata.reviewFingerprint ||
            versionMetadata.contentFingerprint ||
            null,
          factId: versionMetadata.factId || null,
          replacementFactId: versionMetadata.replacementFactId || null,
          sourceCorrectionVersionId:
            versionMetadata.sourceCorrectionVersionId || null,
          sourceCorrectionVersionNumber:
            versionMetadata.sourceCorrectionVersionNumber || null,
          correctionDraft: versionMetadata.correctionDraft || null,
          publicationSnapshotFingerprint:
            versionMetadata.publicationSnapshotFingerprint || null,
        },
      };
    });

    return normalizeContentTransparency(
      {
        generatedAt: new Date().toISOString(),
        snapshotKind,
        contentId: (this.id as string) || null,
        currentContentStatus: this.status || null,
        publicationProfileKey: governance.publicationProfileKey || undefined,
        generation: {
          aiAssisted:
            publicGeneration.aiAssisted ??
            generationMetadata.aiAssisted ??
            Boolean(getPublicPrompt(this.metadata)),
          publicPrompt: getPublicPrompt(this.metadata),
          model: publicGeneration.model || generationMetadata.model || null,
        },
        factsUsed: linkedFacts.filter((fact) => fact.usedInArticle),
        linkedFacts,
        otherExtractedFacts: referenceGroups.flatMap((reference) =>
          reference.extractedFacts.filter((fact: any) => !fact.usedInArticle),
        ),
        references: referenceGroups,
        reviews,
        reviewProfiles,
        corrections: serializedCorrections,
        versionHistory: serializedVersionHistory,
      },
      {
        snapshotKind,
        contentId: (this.id as string) || null,
        currentContentStatus: this.status || null,
        publicationProfileKey: governance.publicationProfileKey || undefined,
      },
    );
  }

  private async buildPublicationSnapshotFingerprint(
    governance: ResolvedContentGovernance,
  ): Promise<string | null> {
    const transparency = await this.buildTransparencySnapshot({
      snapshotKind: 'published',
      governance,
    });

    if (!transparency) {
      return null;
    }

    const { generatedAt, ...stableSnapshot } = transparency;
    return createFingerprint(stableSnapshot);
  }

  private async getLatestPublicationSnapshotFingerprint(): Promise<
    string | null
  > {
    const versions = await this.getVersions();
    const latestPublicationVersion = [...versions]
      .reverse()
      .find((version) => version.kind === 'publication');

    if (!latestPublicationVersion) {
      return null;
    }

    return (
      latestPublicationVersion.getMetadata().publicationSnapshotFingerprint ||
      null
    );
  }

  private async buildCorrectionDraftSnapshot(
    options: IssueContentCorrectionOptions,
    replacementFactId: string,
  ): Promise<{
    snapshot: Record<string, any>;
    metadata: Record<string, any>;
  }> {
    const correctedText =
      options.correctedText || options.correctedFactText || '';
    const incorrectText = options.incorrectText || '';
    let body = this.body;
    let generationMethod = 'metadata';

    if (incorrectText && correctedText && body.includes(incorrectText)) {
      body = body.replace(incorrectText, correctedText);
      generationMethod = 'replace';
    } else if (correctedText) {
      const ai = this.ai as {
        message?: (
          prompt: string,
          options?: Record<string, unknown>,
        ) => Promise<string>;
      };
      if (ai?.message) {
        const resolvedPrompt = await resolvePrompt(
          smrtContentApplyCorrectionPrompt.key,
          {
            db: this.options.db,
            tenantId: this.tenantId,
            variables: {
              body: this.body,
              correctedText,
              incorrectText: incorrectText || 'Not provided',
              summary: options.summary || '',
            },
          },
        );

        try {
          const proposedBody = (
            await ai.message(
              resolvedPrompt.text,
              promptMessageOptions(resolvedPrompt.ai),
            )
          ).trim();
          if (proposedBody) {
            body = proposedBody;
            generationMethod = 'ai';
          }
        } catch {
          generationMethod = 'metadata';
        }
      }
    }

    return {
      snapshot: {
        title: this.title,
        description: this.description,
        body,
        status: 'draft',
        metadata: {
          ...(this.metadata || {}),
          governance: {
            ...((this.metadata?.governance || {}) as Record<string, any>),
            correctionDraft: {
              summary: options.summary,
              incorrectText,
              correctedText,
              factId: options.factId || null,
              replacementFactId: replacementFactId || null,
              autoGenerated: true,
              generationMethod,
            },
          },
        },
      },
      metadata: {
        summary: options.summary,
        incorrectText,
        correctedText,
        factId: options.factId || null,
        replacementFactId: replacementFactId || null,
        autoGenerated: true,
        generationMethod,
      },
    };
  }

  private async getAssetCollection() {
    return AssetCollection.create({ db: this.db });
  }

  private async getContentAssetCollection() {
    return ContentAssetCollection.create({ db: this.db });
  }

  private async getContentAssetLinks(
    relationship?: string,
  ): Promise<Array<{ assetId: string; sortOrder: number }>> {
    if (!this.id) {
      return [];
    }

    try {
      const contentAssets = await this.getContentAssetCollection();
      const links = await contentAssets.getForContent(this.id, relationship);

      return links
        .filter((link) => link.assetId)
        .map((link) => ({
          assetId: link.assetId,
          sortOrder: link.sortOrder ?? 0,
        }));
    } catch (error) {
      if (isMissingTableError(error, 'content_assets')) {
        return [];
      }

      throw error;
    }
  }

  private async resolveAssetsForLinks(
    links: Array<{ assetId: string; sortOrder: number }>,
  ): Promise<Asset[]> {
    if (links.length === 0) {
      return [];
    }

    const assetIds = [...new Set(links.map((link) => link.assetId))];
    const assets = await this.getAssetCollection();
    const resolved = await assets.listByIds(assetIds);
    const assetsById = new Map(
      resolved
        .filter((asset) => asset.id)
        .map((asset) => [asset.id as string, asset]),
    );

    return links
      .map((link) => assetsById.get(link.assetId))
      .filter(Boolean) as Asset[];
  }

  private async resolveReferenceTarget(content: Content | string) {
    if (typeof content !== 'string') {
      return content;
    }

    const contents = await this.getContentsCollection();

    return (await contents.getOrUpsert(
      {
        url: content,
        tenantId: this.tenantId,
      },
      {
        name: content,
        title: content,
        type: 'reference',
        tenantId: this.tenantId,
      },
    )) as Content;
  }

  /**
   * Loads referenced content objects
   *
   * @returns Promise that resolves when references are loaded
   */
  public async loadReferences() {
    this.references = await this.getReferences();
  }

  private getPendingReferenceIds(): string[] | null {
    const pendingReferenceIds = (this as any).referenceIds;

    if (!Array.isArray(pendingReferenceIds)) {
      return null;
    }

    return [
      ...new Set(
        pendingReferenceIds.filter(
          (referenceId): referenceId is string =>
            typeof referenceId === 'string' &&
            referenceId.length > 0 &&
            referenceId !== this.id,
        ),
      ),
    ];
  }

  private getPendingAssetIds(): string[] | null {
    const pendingAssetIds = (this as any).assetIds;

    if (!Array.isArray(pendingAssetIds)) {
      return null;
    }

    return [
      ...new Set(
        pendingAssetIds.filter(
          (assetId): assetId is string =>
            typeof assetId === 'string' && assetId.length > 0,
        ),
      ),
    ];
  }

  private async syncPendingReferenceIds(): Promise<void> {
    if (!this.id) {
      return;
    }

    const pendingReferenceIds = this.getPendingReferenceIds();
    if (pendingReferenceIds === null) {
      return;
    }

    const currentReferences = await this.getReferences();
    const currentReferenceIds = currentReferences
      .map((reference) => reference.id)
      .filter((referenceId): referenceId is string => Boolean(referenceId));
    const currentReferenceIdSet = new Set(currentReferenceIds);
    const pendingReferenceIdSet = new Set(pendingReferenceIds);

    for (const referenceId of currentReferenceIds) {
      if (!pendingReferenceIdSet.has(referenceId)) {
        await this.removeReference(referenceId);
      }
    }

    const referenceIdsToAdd = pendingReferenceIds.filter(
      (referenceId) => !currentReferenceIdSet.has(referenceId),
    );

    if (referenceIdsToAdd.length === 0) {
      this.references = await this.getReferences();
      return;
    }

    const contents = await this.getContentsCollection();
    const resolvedReferences = await contents.listByIds(referenceIdsToAdd);
    const referencesById = new Map(
      resolvedReferences
        .filter((reference) => reference.id)
        .map((reference) => [reference.id as string, reference]),
    );

    for (const referenceId of referenceIdsToAdd) {
      const reference = referencesById.get(referenceId);
      if (reference) {
        await this.addReference(reference);
      }
    }

    this.references = await this.getReferences();
  }

  private async syncPendingAssetIds(): Promise<void> {
    if (!this.id) {
      return;
    }

    const pendingAssetIds = this.getPendingAssetIds();
    if (pendingAssetIds === null) {
      return;
    }

    const currentAssets = await this.getAssets();
    const currentAssetIds = currentAssets
      .map((asset) => asset.id)
      .filter((assetId): assetId is string => Boolean(assetId));
    const currentAssetIdSet = new Set(currentAssetIds);
    const pendingAssetIdSet = new Set(pendingAssetIds);

    for (const assetId of currentAssetIds) {
      if (!pendingAssetIdSet.has(assetId)) {
        await this.removeAsset(assetId);
      }
    }

    const assetIdsToAdd = pendingAssetIds.filter(
      (assetId) => !currentAssetIdSet.has(assetId),
    );

    if (assetIdsToAdd.length === 0) {
      return;
    }

    const assets = await this.getAssetCollection();
    const resolvedAssets = await assets.listByIds(assetIdsToAdd);
    const assetsById = new Map(
      resolvedAssets
        .filter((asset) => asset.id)
        .map((asset) => [asset.id as string, asset]),
    );

    for (const assetId of assetIdsToAdd) {
      const asset = assetsById.get(assetId);
      if (asset) {
        await this.addAsset(asset);
      }
    }
  }

  /**
   * Adds a reference to another content object
   *
   * @param content - Content object or URL to reference
   * @returns Promise that resolves when the reference is added
   */
  public async addReference(content: Content | string) {
    if (!this.id) {
      throw new Error('Cannot add reference to unsaved content');
    }

    const target = await this.resolveReferenceTarget(content);

    if (!target.id) {
      throw new Error('Cannot add reference to unsaved content');
    }
    if (this.id === target.id) {
      return;
    }

    const references = await this.getReferenceCollection();
    await references.link(this.id, target.id, this.tenantId);
    this.references = await this.getReferences();
  }

  /**
   * Removes a reference to another content object
   *
   * @param targetId - ID of the referenced content to remove
   */
  public async removeReference(targetId: string) {
    if (!this.id) {
      return;
    }

    const references = await this.getReferenceCollection();
    await references.unlink(this.id, targetId);
    this.references = this.references.filter(
      (reference) => reference.id !== targetId,
    );
  }

  /**
   * Gets all referenced content objects
   *
   * @returns Promise resolving to an array of referenced Content objects
   */
  public async getReferences() {
    if (!this.id) {
      return [];
    }

    const references = await this.getReferenceCollection();
    const linkedReferences = await references.getForSource(this.id);
    const targetIds = linkedReferences.map((reference) => reference.targetId);

    if (targetIds.length === 0) {
      this.references = [];
      return this.references;
    }

    const contents = await this.getContentsCollection();
    const resolved = await contents.listByIds(targetIds);
    const referencesById = new Map(
      resolved
        .filter((content) => content.id)
        .map((content) => [content.id as string, content]),
    );

    this.references = targetIds
      .map((targetId) => referencesById.get(targetId))
      .filter(Boolean) as Content[];
    return this.references;
  }

  public isGoverned(): boolean {
    return this.getConfiguredGovernance().isGoverned;
  }

  public async getFactLinks(
    options: { relationship?: FactContentRelationship } = {},
  ) {
    const governance = await this.resolveGovernance();
    if (!governance.isGoverned || !governance.factLinkingEnabled || !this.id) {
      return [];
    }

    if (!this.id) {
      return [];
    }

    const links = await this.getFactContentCollection();
    return options.relationship
      ? links.getForContentByRelationship(
          this.id as string,
          options.relationship,
        )
      : links.getForContent(this.id as string);
  }

  public async getFacts(
    options: {
      relationship?: FactContentRelationship;
      includeSuperseded?: boolean;
      latestOnly?: boolean;
    } = {},
  ): Promise<Fact[]> {
    const governance = await this.resolveGovernance();
    if (!governance.isGoverned || !governance.factLinkingEnabled || !this.id) {
      return [];
    }

    if (!this.id) {
      return [];
    }

    const facts = await this.getFactCollection();
    return facts.getForContent(this.id as string, options);
  }

  public async addFact(
    fact: Fact | string,
    relationship?: FactContentRelationship,
    metadata?: Record<string, any>,
  ) {
    const governance = await this.requireFactLinking('fact association');

    if (!this.id) {
      throw new Error('Cannot associate an unsaved content item with a fact');
    }

    const factId = typeof fact === 'string' ? fact : (fact.id as string);
    if (!factId) {
      throw new Error('Fact ID is required to create a content-fact link');
    }

    const links = await this.getFactContentCollection();
    return links.link(
      factId,
      this.id as string,
      relationship || governance.defaultFactRelationship,
      metadata,
    );
  }

  public async removeFact(
    factId: string,
    relationship?: FactContentRelationship,
  ): Promise<void> {
    const governance = await this.resolveGovernance();
    if (!governance.isGoverned || !governance.factLinkingEnabled) {
      return;
    }

    if (!this.id) {
      return;
    }

    const links = await this.getFactContentCollection();
    if (relationship) {
      await links.unlinkByRelationship(factId, this.id as string, relationship);
      return;
    }

    await links.unlink(factId, this.id as string);
  }

  public async syncFacts(
    factIds: string[],
    relationship?: FactContentRelationship,
  ): Promise<{ added: string[]; kept: string[]; removed: string[] }> {
    const governance = await this.requireFactLinking('fact sync');

    if (!this.id) {
      throw new Error('Cannot sync facts for unsaved content');
    }

    const uniqueFactIds = [...new Set(factIds.filter(Boolean))];
    const links = await this.getFactContentCollection();
    const resolvedRelationship =
      relationship || governance.defaultFactRelationship;
    const existing = await links.getForContentByRelationship(
      this.id as string,
      resolvedRelationship,
    );

    const existingIds = new Set(existing.map((link) => link.factId));
    const desiredIds = new Set(uniqueFactIds);

    const kept = uniqueFactIds.filter((factId) => existingIds.has(factId));
    const added = uniqueFactIds.filter((factId) => !existingIds.has(factId));
    const removed = existing
      .map((link) => link.factId)
      .filter((factId) => !desiredIds.has(factId));

    for (const factId of added) {
      await links.link(factId, this.id as string, resolvedRelationship);
    }

    for (const factId of removed) {
      await links.unlinkByRelationship(
        factId,
        this.id as string,
        resolvedRelationship,
      );
    }

    return { added, kept, removed };
  }

  public async browseFacts(
    query = '',
    options: {
      limit?: number;
      offset?: number;
      minSimilarity?: number;
      includeSuperseded?: boolean;
      latestOnly?: boolean;
    } = {},
  ): Promise<Fact[]> {
    await this.requireFactLinking('fact catalog browsing');
    const facts = await this.getFactCollection();
    return facts.browseCatalog(query, {
      ...options,
      tenantId: this.tenantId,
    });
  }

  public async getFactsState(
    options: { relationship?: FactContentRelationship } = {},
  ) {
    const governance = await this.resolveGovernance();
    if (!governance.isGoverned || !governance.factLinkingEnabled) {
      return {
        factIds: [],
        facts: [],
        factLinks: [],
      };
    }

    const relationship = options.relationship;
    const [facts, factLinks] = await Promise.all([
      this.getFacts({
        relationship,
        latestOnly: true,
        includeSuperseded: false,
      }),
      this.getFactLinks(relationship ? { relationship } : {}),
    ]);

    return {
      factIds: facts.map((fact: any) => fact.id).filter(Boolean),
      facts: facts.map(serializeFact),
      factLinks: factLinks.map(serializeFactLink),
    };
  }

  public async syncFactsState(
    options: {
      factIds?: string[];
      relationship?: FactContentRelationship;
    } = {},
  ) {
    const governance = await this.requireFactLinking('fact sync');
    const relationship =
      options.relationship || governance.defaultFactRelationship;
    const sync = await this.syncFacts(options.factIds || [], relationship);
    const state = await this.getFactsState({ relationship });
    return {
      ...state,
      sync,
    };
  }

  public async createVersion(options: CreateContentVersionOptions = {}) {
    const versions = await this.getContentVersionCollection();
    return versions.createSnapshot(this, options);
  }

  public async getVersions() {
    if (!this.id) {
      return [];
    }

    const versions = await this.getContentVersionCollection();
    return versions.listForContent(this.id as string);
  }

  public async restoreFromVersion(versionNumber: number) {
    const versions = await this.getContentVersionCollection();
    return versions.restoreIntoContent(this, versionNumber);
  }

  public async getReviews(kind?: RunContentReviewOptions['kind']) {
    if (!this.id) {
      return [];
    }

    const reviews = await this.getContentReviewCollection();
    return reviews.listForContent(this.id as string, kind);
  }

  public async listReviews(
    options: { kind?: RunContentReviewOptions['kind'] } = {},
  ) {
    const reviews = await this.getReviews(options.kind);
    return reviews.map(serializeContentReview);
  }

  public async getReviewRequirements(
    profileKey: string,
    governance?: ResolvedContentGovernance,
  ) {
    const resolvedGovernance = governance || (await this.resolveGovernance());
    return getContentReviewRequirements(
      profileKey,
      resolvedGovernance.availableProfiles,
    );
  }

  public async getGovernanceState(): Promise<ContentGovernanceState> {
    const governance = await this.resolveGovernance();

    if (!governance.isGoverned) {
      return {
        ...governance,
        reviewProfiles: [],
      };
    }

    return {
      ...governance,
      reviewProfiles: await this.listReviewProfilesAction(),
    };
  }

  public async getGovernanceStateAction() {
    return this.getGovernanceState();
  }

  public async listReviewProfilesAction() {
    const governance = await this.resolveGovernance();
    if (!governance.isGoverned) {
      return [];
    }

    return Promise.all(
      getContentReviewProfileKeys(governance.availableProfiles).map(
        (profileKey) => this.evaluateReviewProfile(profileKey),
      ),
    );
  }

  public async evaluateReviewProfile(
    profileKey: string,
  ): Promise<ContentReviewProfileEvaluation> {
    const governance = await this.resolveGovernance();
    const requirements = await this.getReviewRequirements(
      profileKey,
      governance,
    );

    if (requirements.length === 0) {
      return {
        profileKey,
        ready: true,
        complete: true,
        requirements: [],
      };
    }

    const reviews = await this.getContentReviewCollection();
    const reviewFingerprintCache = new Map<string, string>();
    const evaluatedRequirements = await Promise.all(
      requirements.map(async (requirement) => {
        if (!reviewFingerprintCache.has(requirement.policyKey)) {
          reviewFingerprintCache.set(
            requirement.policyKey,
            await this.buildReviewFingerprint(requirement.policyKey),
          );
        }

        const latestReview =
          this.id && requirement.policyKey
            ? await reviews.getLatestForPolicyKey(
                this.id as string,
                requirement.policyKey,
              )
            : null;
        const acceptedStatuses = getAcceptedContentReviewStatuses(requirement);
        const latestStatus = latestReview?.status ?? null;
        const latestMetadata =
          typeof latestReview?.getMetadata === 'function'
            ? latestReview.getMetadata()
            : {};
        const currentFingerprint =
          reviewFingerprintCache.get(requirement.policyKey) || null;
        const reviewedFingerprint =
          latestMetadata?.reviewFingerprint ||
          latestMetadata?.contentFingerprint ||
          null;
        const missing = !latestReview;
        const stale =
          !missing &&
          !!reviewedFingerprint &&
          reviewedFingerprint !== currentFingerprint;
        const executed =
          latestStatus !== null && latestStatus !== 'pending' && !stale;
        const satisfied =
          !stale &&
          latestStatus !== null &&
          acceptedStatuses.includes(latestStatus);

        return {
          kind: getContentReviewKind(
            requirement.policyKey,
            governance.reviewPolicies,
          ),
          policyKey: requirement.policyKey,
          label:
            requirement.label ||
            getContentReviewPolicy(
              requirement.policyKey,
              governance.reviewPolicies,
            )?.label ||
            requirement.policyKey,
          blocking: requirement.blocking === true,
          acceptedStatuses,
          missing,
          stale,
          executed,
          satisfied,
          latestReviewId: (latestReview?.id as string) || null,
          latestStatus,
          latestSummary: latestReview?.summary || null,
        };
      }),
    );

    return {
      profileKey,
      ready: evaluatedRequirements
        .filter((requirement) => requirement.blocking)
        .every((requirement) => requirement.satisfied),
      complete: evaluatedRequirements.every(
        (requirement) => requirement.executed,
      ),
      requirements: evaluatedRequirements,
    };
  }

  public async evaluateReviewProfileAction(
    options: { profileKey?: string } = {},
  ) {
    if (!options.profileKey) {
      throw new Error('profileKey is required');
    }

    return this.evaluateReviewProfile(options.profileKey);
  }

  public async isReadyForReviewProfile(profileKey: string): Promise<boolean> {
    const evaluation = await this.evaluateReviewProfile(profileKey);
    return evaluation.ready;
  }

  public async getPublishedTransparency() {
    if (!this.id) {
      return null;
    }

    const versions = await this.getContentVersionCollection();
    const latestPublicationVersion =
      await versions.getLatestPublishedForContent(this.id as string);

    return latestPublicationVersion?.getTransparency() || null;
  }

  public async getPublishedTransparencyAction() {
    return this.getPublishedTransparency();
  }

  public async previewTransparency() {
    const governance = await this.resolveGovernance();
    if (!governance.isGoverned || !governance.transparencyEnabled) {
      return null;
    }

    return this.buildTransparencySnapshot({
      snapshotKind: 'preview',
      governance,
    });
  }

  public async previewTransparencyAction() {
    return this.previewTransparency();
  }

  public async runReview(options: RunContentReviewOptions = {}) {
    const governance = await this.requireGovernance('review execution');

    if (!this.id) {
      throw new Error('Cannot review unsaved content');
    }

    const policyKey = options.policyKey || options.kind || 'custom';
    const policy = getContentReviewPolicy(policyKey, governance.reviewPolicies);
    const kind =
      options.kind ||
      getContentReviewKind(policyKey, governance.reviewPolicies);
    const facts =
      options.facts !== undefined
        ? options.facts
        : governance.factLinkingEnabled &&
            (kind === 'facts' || Boolean(options.factIds?.length))
          ? await this.getFacts({
              latestOnly: true,
              includeSuperseded: false,
            })
          : [];
    const filteredFacts =
      options.factIds && options.factIds.length > 0
        ? facts.filter((fact) => options.factIds?.includes(fact.id as string))
        : facts;
    const reviewPrompt = buildContentReviewPrompt({
      kind,
      content: this,
      facts: filteredFacts,
      policy,
      customInstructions: options.instructions,
    });
    const resolvedPrompt = await resolvePrompt(smrtContentReviewPrompt.key, {
      db: this.options.db,
      tenantId: this.tenantId,
      variables: {
        contentBody: this.body,
        contentDescription: this.description ?? '',
        contentId: this.id ?? '',
        contentTitle: this.title,
        kind,
        policyKey: policy?.key || kind,
        reviewPrompt,
      },
    });
    const reviewFingerprint = await this.buildReviewFingerprint(policyKey);
    const ai = this.ai as {
      message?: (
        prompt: string,
        options?: Record<string, unknown>,
      ) => Promise<string>;
    };
    if (!ai?.message) {
      throw new Error('AI client is not configured for content reviews');
    }

    const rawResponse = await ai.message(
      resolvedPrompt.text,
      promptMessageOptions(resolvedPrompt.ai),
    );
    const result = parseContentReviewResponse(rawResponse);
    const version =
      options.createVersion === false
        ? null
        : await this.createVersion({
            kind: 'review',
            summary: result.summary,
            metadata: {
              kind,
              policyKey,
              reviewFingerprint,
            },
          });

    const reviews = await this.getContentReviewCollection();
    return reviews.createFromResult({
      contentId: this.id as string,
      contentVersionId: version?.id as string | undefined,
      kind,
      policyKey,
      reviewer: options.reviewer || 'system',
      result,
      metadata: {
        ...(options.metadata || {}),
        prompt: resolvedPrompt.text,
        rawResponse,
        reviewFingerprint,
        factIds: filteredFacts.map((fact) => fact.id),
      },
      tenantId: this.tenantId,
    });
  }

  public async runReviewAction(options: RunContentReviewOptions = {}) {
    let review: ContentReview;

    if (options.kind === 'facts') {
      review = await this.reviewFacts(options);
    } else if (options.kind === 'safety') {
      review = await this.reviewSafety(options);
    } else {
      review = await this.runReview(options);
    }

    return serializeContentReview(review);
  }

  public async reviewFacts(
    options: Omit<RunContentReviewOptions, 'kind'> = {},
  ) {
    return this.runReview({
      ...options,
      kind: 'facts',
      policyKey: options.policyKey || 'facts',
    });
  }

  public async reviewSafety(
    options: Omit<RunContentReviewOptions, 'kind'> = {},
  ) {
    const governance = await this.requireGovernance('safety review');
    const safetyPolicy = getContentReviewPolicy(
      options.policyKey || 'safety',
      governance.reviewPolicies,
    );
    const baseInstructions = safetyPolicy?.instructions || '';

    return this.runReview({
      ...options,
      kind: 'safety',
      policyKey: options.policyKey || 'safety',
      instructions:
        options.instructions && baseInstructions
          ? `${baseInstructions}\n\nAdditional app-level guidance:\n${options.instructions}`
          : options.instructions || baseInstructions,
    });
  }

  public async getCorrections() {
    if (!this.id) {
      return [];
    }

    const corrections = await this.getContentCorrectionCollection();
    return corrections.listForContent(this.id as string);
  }

  public async listCorrections() {
    const corrections = await this.getCorrections();
    return corrections.map(serializeContentCorrection);
  }

  public async issueCorrection(options: IssueContentCorrectionOptions) {
    const governance = await this.requireGovernance('corrections');

    if (!this.id) {
      throw new Error('Cannot issue a correction for unsaved content');
    }

    let replacementFactId = '';
    if (
      governance.factLinkingEnabled &&
      options.factId &&
      options.correctedFactText
    ) {
      const facts = await this.getFactCollection();
      const existing = await facts.get({ id: options.factId });
      if (!existing) {
        throw new Error(`Fact not found for correction: ${options.factId}`);
      }

      // Create the correction branch directly so editorial corrections do not
      // block on synchronous embedding generation inside facts.branch().
      const replacement = await facts.create({
        textRefined: options.correctedFactText,
        textRaw: options.correctedFactText,
        type: existing.getType(),
        domain: existing.domain,
        status: 'active',
        tenantId: existing.tenantId ?? this.tenantId ?? null,
        parentId: options.factId,
        evolutionType: 'correction',
      } as any);
      existing.status = 'superseded';
      await existing.save();
      replacementFactId = replacement.id as string;
      await this.addFact(replacementFactId);
    }

    const version =
      options.createVersion === false
        ? null
        : await this.createVersion({
            kind: 'correction',
            summary: options.summary,
            metadata: {
              factId: options.factId || null,
              replacementFactId: replacementFactId || null,
            },
          });
    const correctionDraft =
      options.createVersion === false
        ? null
        : await this.buildCorrectionDraftSnapshot(options, replacementFactId);
    const draftVersion =
      options.createVersion === false || !correctionDraft
        ? null
        : await this.createVersion({
            kind: 'draft',
            summary: `Auto-created correction draft: ${options.summary}`,
            snapshot: correctionDraft.snapshot,
            metadata: {
              ...correctionDraft.metadata,
              sourceCorrectionVersionId: (version?.id as string) || null,
              sourceCorrectionVersionNumber: version?.version ?? null,
            },
          });

    const corrections = await this.getContentCorrectionCollection();
    const shouldPublish = options.publish ?? this.status === 'published';
    return corrections.issue({
      contentId: this.id as string,
      contentVersionId: (version?.id as string) || '',
      factId: options.factId || '',
      replacementFactId,
      correctionType: options.correctionType || 'fact',
      status: shouldPublish ? 'published' : 'draft',
      summary: options.summary,
      incorrectText: options.incorrectText || '',
      correctedText: options.correctedText || options.correctedFactText || '',
      publicNote: options.publicNote || '',
      metadata: {
        ...(options.metadata || {}),
        autoGeneratedDraft: Boolean(draftVersion),
        draftVersionId: (draftVersion?.id as string) || null,
        draftVersionNumber: draftVersion?.version ?? null,
        sourceCorrectionVersionId: (version?.id as string) || null,
        sourceCorrectionVersionNumber: version?.version ?? null,
        correctionProfileKey: governance.correctionProfileKey || null,
      },
      tenantId: this.tenantId,
      publishedAt: shouldPublish ? new Date() : null,
    });
  }

  public async issueCorrectionAction(options: IssueContentCorrectionOptions) {
    const correction = await this.issueCorrection(options);
    return serializeContentCorrection(correction);
  }

  public async listVersions() {
    const versions = await this.getVersions();
    return versions.map(serializeContentVersion);
  }

  public async mutateVersionAction(
    options: CreateContentVersionOptions & {
      action?: string;
      versionNumber?: number | string;
    } = {},
  ) {
    if (options.action === 'restore') {
      const versionNumber = Number(options.versionNumber);
      if (!Number.isFinite(versionNumber)) {
        throw new Error('versionNumber is required to restore a version');
      }

      const restored = await this.restoreFromVersion(versionNumber);
      return serializeContent(restored);
    }

    const version = await this.createVersion(options);
    return serializeContentVersion(version);
  }

  /**
   * Note: toJSON() is inherited from SmrtObject
   *
   * The parent implementation handles:
   * - STI discriminator (_meta_type) for polymorphic queries
   * - Meta field extraction (_meta_data) for child-specific fields
   * - Automatic serialization of all fields from manifest
   *
   * DO NOT override toJSON() unless you call super.toJSON() first.
   * See issue #377 for details on why this override was removed.
   */

  // ============================================
  // Category Helper Methods
  // ============================================

  /**
   * Get category segments as array
   * @example 'politics/local' -> ['politics', 'local']
   */
  getCategorySegments(): string[] {
    if (!this.category) return [];
    return this.category.split('/').filter(Boolean);
  }

  /**
   * Get parent category path
   * @example 'politics/local/town' -> 'politics/local'
   * @example 'politics' -> null
   */
  getParentCategory(): string | null {
    const segments = this.getCategorySegments();
    if (segments.length <= 1) return null;
    return segments.slice(0, -1).join('/');
  }

  /**
   * Get root (top-level) category
   * @example 'politics/local/town' -> 'politics'
   */
  getRootCategory(): string | null {
    const segments = this.getCategorySegments();
    return segments[0] || null;
  }

  /**
   * Get all ancestor category paths (for breadcrumbs)
   * @example 'politics/local' -> ['politics', 'politics/local']
   */
  getAncestorPaths(): string[] {
    const segments = this.getCategorySegments();
    return segments.map((_, i) => segments.slice(0, i + 1).join('/'));
  }

  /**
   * Check if content belongs to a category (optionally including subcategories)
   * @param categoryPath - Category to check
   * @param includeChildren - If true, matches 'politics' for content in 'politics/local'
   */
  isInCategory(categoryPath: string, includeChildren = true): boolean {
    if (!this.category) return false;
    if (includeChildren) {
      return (
        this.category === categoryPath ||
        this.category.startsWith(`${categoryPath}/`)
      );
    }
    return this.category === categoryPath;
  }

  // ============================================
  // Asset Relationship Methods
  // ============================================

  /**
   * Get all assets associated with this content
   * @param relationship - Optional filter by relationship type (e.g., 'thumbnail', 'attachment')
   * @returns Promise resolving to array of assets
   */
  async getAssets(relationship?: string): Promise<Asset[]> {
    if (!this.id) {
      return [];
    }

    return this.resolveAssetsForLinks(
      await this.getContentAssetLinks(relationship),
    );
  }

  /**
   * Add an asset to this content with a relationship type
   * @param asset - The asset to associate
   * @param relationship - Relationship type (e.g., 'thumbnail', 'attachment', 'inline')
   * @param sortOrder - Optional sort order for display
   */
  async addAsset(
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    if (!this.id || !asset.id) {
      throw new Error('Cannot associate unsaved content or asset');
    }

    // Validate relationship - must start with letter/underscore, contain only alphanumeric and underscores
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(relationship)) {
      throw new Error(
        `Invalid relationship type "${relationship}"; must start with a letter or underscore and contain only letters, digits, and underscores`,
      );
    }

    // Validate sortOrder is a reasonable integer
    if (
      !Number.isInteger(sortOrder) ||
      sortOrder < 0 ||
      sortOrder > 2147483647
    ) {
      throw new Error(
        `Invalid sortOrder "${sortOrder}"; must be a non-negative integer`,
      );
    }

    const contentAssets = await this.getContentAssetCollection();
    await contentAssets.attach(
      this.id,
      asset.id,
      relationship,
      sortOrder,
      this.tenantId,
    );
  }

  /**
   * Remove an asset from this content
   * @param assetId - ID of the asset to remove
   * @param relationship - Optional specific relationship to remove (removes all if not specified)
   */
  async removeAsset(assetId: string, relationship?: string): Promise<void> {
    if (!this.id) {
      return;
    }

    try {
      const contentAssets = await this.getContentAssetCollection();
      await contentAssets.detach(this.id, assetId, relationship);
    } catch (error) {
      if (!isMissingTableError(error, 'content_assets')) {
        throw error;
      }
    }
  }

  // ============================================
  // Metadata Accessors (MetadataAccessor contract)
  // ============================================

  /**
   * Get the full metadata record. Always returns a plain object — never
   * `null`, never an array — so callers can safely read nested keys without
   * defensive checks.
   *
   * Pure read with no side-effect on `this.metadata`: if the field is
   * currently `null` (e.g. fresh from the DB) or non-record-shaped, an
   * empty object is returned but the field is **not** mutated. This avoids
   * accidentally marking the object dirty during a read, which would
   * otherwise cause SmrtObject's save lifecycle to write `{}` back over a
   * NULL column on the next save. Callers that want to normalise the
   * stored field should use {@link Content.setMetadata}.
   */
  getMetadata(): Record<string, any> {
    return isPlainMetadataRecord(this.metadata) ? this.metadata : {};
  }

  /**
   * Replace the full metadata record. Passing `null`/`undefined` (or any
   * non-record value such as an array) clears it to an empty object so
   * downstream readers can rely on the field always being a plain object.
   */
  setMetadata(metadata: Record<string, any> | null | undefined): void {
    this.metadata = isPlainMetadataRecord(metadata) ? { ...metadata } : {};
  }

  /**
   * Shallow-merge a patch over the current metadata. Returns the resulting
   * record so callers can chain reads without re-reading the field. Unlike
   * {@link Content.getMetadata}, this method does intentionally write back
   * to `this.metadata` because the merge is a write.
   */
  updateMetadata(patch: Partial<Record<string, any>>): Record<string, any> {
    const next = { ...this.getMetadata(), ...(patch ?? {}) };
    this.metadata = next;
    return next;
  }

  // ============================================
  // Thumbnail Convenience Methods
  // ============================================

  /**
   * Get the thumbnail image for this content
   * @returns Promise resolving to the thumbnail Image or null
   */
  async getThumbnail(): Promise<Image | null> {
    if (!this.thumbnailAssetId) {
      return null;
    }

    const images = await (ImageCollection as any).create({
      db: (this as any).options?.db,
    });

    return images.get({ id: this.thumbnailAssetId });
  }

  /**
   * Set the thumbnail image for this content
   * @param image - The image to set as thumbnail
   */
  async setThumbnail(image: Image): Promise<void> {
    // Add as asset with 'thumbnail' relationship
    await this.addAsset(image, 'thumbnail', 0);

    // Update thumbnailAssetId
    this.thumbnailAssetId = image.id ?? null;
    await this.save();
  }

  /**
   * Generate a thumbnail for this content using the specified strategy
   *
   * @param options - Thumbnail generation options including strategy
   * @returns Promise resolving to the generated Image
   *
   * @example Headline card thumbnail
   * ```typescript
   * const thumbnail = await content.generateThumbnail({
   *   strategy: 'headline-card',
   *   brandColor: '#1a56db',
   *   logoUrl: 'https://example.com/logo.png'
   * });
   * ```
   *
   * @example Static map thumbnail (requires metadata.latitude/longitude)
   * ```typescript
   * const thumbnail = await content.generateThumbnail({
   *   strategy: 'static-map',
   *   mapProvider: 'mapbox'
   * });
   * ```
   *
   * @example AI-generated thumbnail
   * ```typescript
   * const thumbnail = await content.generateThumbnail({
   *   strategy: 'ai-generate'
   * });
   * ```
   */
  async generateThumbnail(options: ThumbnailOptions): Promise<Image> {
    const generator = new ThumbnailGenerator(this, (this as any).options);
    const image = await generator.generate(options);
    await this.setThumbnail(image);
    return image;
  }
}
