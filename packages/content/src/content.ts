import {
  type Asset,
  AssetAssociationCollection,
  AssetCollection,
} from '@happyvertical/smrt-assets';
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
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  buildContentReviewPrompt,
  type ContentGovernanceState,
  type ContentReviewProfileEvaluation,
  type CreateContentVersionOptions,
  getAcceptedContentReviewStatuses,
  getContentGovernanceConfig,
  getContentPublicationReviewProfileKey,
  getContentReviewKind,
  getContentReviewPolicies,
  getContentReviewPolicy,
  getContentReviewProfileKeys,
  getContentReviewRequirements,
  type IssueContentCorrectionOptions,
  isContentPublishReadinessEnforced,
  isFactualContentEnabled,
  parseContentReviewResponse,
  type RunContentReviewOptions,
} from './content-governance';
import { ContentReferences } from './content-references';
import type { ContentReview } from './content-review';
import { normalizeContentTransparency } from './content-transparency';
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
export class Content extends SmrtObject {
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
    await super.validateBeforeSave();

    if (
      this.status !== 'published' ||
      !isContentPublishReadinessEnforced(this)
    ) {
      return;
    }

    const profileKey = getContentPublicationReviewProfileKey();
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
    const previous = await this.getPersistedContent();
    const previousPublicationFingerprint =
      await this.getLatestPublicationSnapshotFingerprint();
    const nextPublicationFingerprint =
      this.status === 'published'
        ? await this.buildPublicationSnapshotFingerprint()
        : null;

    await super.save();

    if (
      this.status === 'published' &&
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
          transparency: await this.buildTransparencySnapshot({
            snapshotKind: 'published',
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

  private async getPersistedContent(): Promise<Content | null> {
    if (!this.id) {
      return null;
    }

    const contents = await this.getContentsCollection();
    return (await contents.get({ id: this.id as string })) as Content | null;
  }

  private async buildReviewFingerprint(policyKey: string): Promise<string> {
    const kind = getContentReviewKind(policyKey);
    const policy = getContentReviewPolicy(policyKey);
    const [references, facts, factLinks] = await Promise.all([
      this.getReferences(),
      kind === 'facts'
        ? this.getFacts({
            latestOnly: true,
            includeSuperseded: false,
          })
        : Promise.resolve([]),
      kind === 'facts' ? this.getFactLinks() : Promise.resolve([]),
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
        status: this.status,
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
    options: { snapshotKind?: 'preview' | 'published' } = {},
  ) {
    const snapshotKind = options.snapshotKind || 'preview';
    const factual = this.isFactual();
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
      factual
        ? this.getFacts({
            latestOnly: true,
            includeSuperseded: false,
          })
        : Promise.resolve([]),
      factual ? this.getFactLinks() : Promise.resolve([]),
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
        publicationReviewProfileKey: getContentPublicationReviewProfileKey(),
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
        publicationReviewProfileKey: getContentPublicationReviewProfileKey(),
      },
    );
  }

  private async buildPublicationSnapshotFingerprint(): Promise<string> {
    const { generatedAt, ...stableSnapshot } =
      await this.buildTransparencySnapshot({
        snapshotKind: 'published',
      });
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
      const ai = this.ai as { message?: (prompt: string) => Promise<string> };
      if (ai?.message) {
        const prompt = `You are revising an article draft to apply a factual correction.

Return ONLY the fully revised body text, with no commentary.

Current body:
${this.body}

Correction summary:
${options.summary}

Incorrect text to fix:
${incorrectText || 'Not provided'}

Corrected text to incorporate:
${correctedText}
`;

        try {
          const proposedBody = (await ai.message(prompt)).trim();
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

  private async getAssetAssociationCollection() {
    return AssetAssociationCollection.create({ db: this.db });
  }

  private getAssetAssociationMetaType(): string {
    return (this as any)._meta_type || this.constructor.name;
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

  public isFactual(): boolean {
    return isFactualContentEnabled(this);
  }

  public async getFactLinks(
    options: { relationship?: FactContentRelationship } = {},
  ) {
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
    if (!this.id) {
      return [];
    }

    const facts = await this.getFactCollection();
    return facts.getForContent(this.id as string, options);
  }

  public async addFact(
    fact: Fact | string,
    relationship: FactContentRelationship = getContentGovernanceConfig()
      .defaultFactRelationship,
    metadata?: Record<string, any>,
  ) {
    if (!this.id) {
      throw new Error('Cannot associate an unsaved content item with a fact');
    }

    const factId = typeof fact === 'string' ? fact : (fact.id as string);
    if (!factId) {
      throw new Error('Fact ID is required to create a content-fact link');
    }

    const links = await this.getFactContentCollection();
    return links.link(factId, this.id as string, relationship, metadata);
  }

  public async removeFact(
    factId: string,
    relationship?: FactContentRelationship,
  ): Promise<void> {
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
    relationship: FactContentRelationship = getContentGovernanceConfig()
      .defaultFactRelationship,
  ): Promise<{ added: string[]; kept: string[]; removed: string[] }> {
    if (!this.id) {
      throw new Error('Cannot sync facts for unsaved content');
    }

    const uniqueFactIds = [...new Set(factIds.filter(Boolean))];
    const links = await this.getFactContentCollection();
    const existing = await links.getForContentByRelationship(
      this.id as string,
      relationship,
    );

    const existingIds = new Set(existing.map((link) => link.factId));
    const desiredIds = new Set(uniqueFactIds);

    const kept = uniqueFactIds.filter((factId) => existingIds.has(factId));
    const added = uniqueFactIds.filter((factId) => !existingIds.has(factId));
    const removed = existing
      .map((link) => link.factId)
      .filter((factId) => !desiredIds.has(factId));

    for (const factId of added) {
      await links.link(factId, this.id as string, relationship);
    }

    for (const factId of removed) {
      await links.unlinkByRelationship(factId, this.id as string, relationship);
    }

    return { added, kept, removed };
  }

  public async browseFacts(
    query = '',
    options: {
      limit?: number;
      minSimilarity?: number;
      includeSuperseded?: boolean;
      latestOnly?: boolean;
    } = {},
  ): Promise<Fact[]> {
    const facts = await this.getFactCollection();
    return facts.browseCatalog(query, {
      ...options,
      tenantId: this.tenantId,
    });
  }

  public async getFactsState(
    options: { relationship?: FactContentRelationship } = {},
  ) {
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
    const relationship =
      options.relationship ||
      getContentGovernanceConfig().defaultFactRelationship;
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

  public getReviewRequirements(profileKey: string) {
    return getContentReviewRequirements(this, profileKey);
  }

  public async getGovernanceState(): Promise<ContentGovernanceState> {
    const governance = getContentGovernanceConfig();

    return {
      isFactual: this.isFactual(),
      defaultFactRelationship: governance.defaultFactRelationship,
      publicationReviewProfileKey: getContentPublicationReviewProfileKey(),
      enforcePublishReadiness: isContentPublishReadinessEnforced(this),
      reviewPolicies: getContentReviewPolicies(),
      reviewProfiles: await this.listReviewProfilesAction(),
    };
  }

  public async getGovernanceStateAction() {
    return this.getGovernanceState();
  }

  public async listReviewProfilesAction() {
    return Promise.all(
      getContentReviewProfileKeys().map((profileKey) =>
        this.evaluateReviewProfile(profileKey),
      ),
    );
  }

  public async evaluateReviewProfile(
    profileKey: string,
  ): Promise<ContentReviewProfileEvaluation> {
    const requirements = this.getReviewRequirements(profileKey);

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
          kind: getContentReviewKind(requirement.policyKey),
          policyKey: requirement.policyKey,
          label:
            requirement.label ||
            getContentReviewPolicy(requirement.policyKey)?.label ||
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
    return this.buildTransparencySnapshot({
      snapshotKind: 'preview',
    });
  }

  public async previewTransparencyAction() {
    return this.previewTransparency();
  }

  public async runReview(options: RunContentReviewOptions = {}) {
    if (!this.id) {
      throw new Error('Cannot review unsaved content');
    }

    const policyKey = options.policyKey || options.kind || 'custom';
    const policy = getContentReviewPolicy(policyKey);
    const kind = options.kind || getContentReviewKind(policyKey);
    const facts =
      options.facts !== undefined
        ? options.facts
        : kind === 'facts' || Boolean(options.factIds?.length)
          ? await this.getFacts({
              latestOnly: true,
              includeSuperseded: false,
            })
          : [];
    const filteredFacts =
      options.factIds && options.factIds.length > 0
        ? facts.filter((fact) => options.factIds?.includes(fact.id as string))
        : facts;
    const prompt = buildContentReviewPrompt({
      kind,
      content: this,
      facts: filteredFacts,
      policy,
      customInstructions: options.instructions,
    });
    const reviewFingerprint = await this.buildReviewFingerprint(policyKey);
    const ai = this.ai as { message?: (prompt: string) => Promise<string> };
    if (!ai?.message) {
      throw new Error('AI client is not configured for content reviews');
    }

    const rawResponse = await ai.message(prompt);
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
        prompt,
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
    const governance = getContentGovernanceConfig();
    return this.runReview({
      ...options,
      kind: 'safety',
      policyKey: options.policyKey || 'safety',
      instructions: options.instructions
        ? `${governance.safetyPrompt}\n\nAdditional app-level guidance:\n${options.instructions}`
        : governance.safetyPrompt,
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
    if (!this.id) {
      throw new Error('Cannot issue a correction for unsaved content');
    }

    let replacementFactId = '';
    if (options.factId && options.correctedFactText) {
      const facts = await this.getFactCollection();
      const existing = await facts.get({ id: options.factId });
      if (!existing) {
        throw new Error(`Fact not found for correction: ${options.factId}`);
      }

      const replacement = await facts.branch(
        options.factId,
        {
          textRefined: options.correctedFactText,
          textRaw: options.correctedFactText,
          type: existing.getType(),
          domain: existing.domain,
          status: 'active',
          tenantId: existing.tenantId ?? this.tenantId ?? null,
        },
        'correction',
      );
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

    const associations = await this.getAssetAssociationCollection();
    const linkedAssets = relationship
      ? await associations.getForObjectByRole(
          this.getAssetAssociationMetaType(),
          this.id,
          relationship,
        )
      : await associations.getForObject(
          this.getAssetAssociationMetaType(),
          this.id,
        );
    const assetIds = linkedAssets.map((association) => association.assetId);

    if (assetIds.length === 0) {
      return [];
    }

    const assets = await this.getAssetCollection();
    const resolved = await assets.listByIds(assetIds);
    const assetsById = new Map(
      resolved
        .filter((asset) => asset.id)
        .map((asset) => [asset.id as string, asset]),
    );

    return assetIds
      .map((assetId) => assetsById.get(assetId))
      .filter(Boolean) as Asset[];
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

    const associations = await this.getAssetAssociationCollection();
    await associations.associate(
      asset.id,
      this.getAssetAssociationMetaType(),
      this.id,
      relationship,
      sortOrder,
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

    const associations = await this.getAssetAssociationCollection();
    await associations.dissociate(
      assetId,
      this.getAssetAssociationMetaType(),
      this.id,
      relationship,
    );
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
