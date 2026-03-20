import {
  type Asset,
  AssetAssociationCollection,
  AssetCollection,
} from '@happyvertical/smrt-assets';
import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import type { Fact, FactContentRelationship } from '@happyvertical/smrt-facts';
import type { Image } from '@happyvertical/smrt-images';
import { ImageCollection } from '@happyvertical/smrt-images';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  buildContentReviewPrompt,
  type ContentReviewProfileEvaluation,
  type CreateContentVersionOptions,
  getAcceptedContentReviewStatuses,
  getContentGovernanceConfig,
  getContentReviewPolicy,
  getContentReviewRequirements,
  type IssueContentCorrectionOptions,
  isFactualContentEnabled,
  parseContentReviewResponse,
  type RunContentReviewOptions,
} from './content-governance';
import { ContentReferences } from './content-references';
import type { ContentReview } from './content-review';
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
      'listReviews',
      'runReviewAction',
      'evaluateReviewProfileAction',
      'listCorrections',
      'issueCorrectionAction',
      'listVersions',
      'mutateVersionAction',
    ],
    routes: {
      getFactsState: { method: 'GET', path: 'facts' },
      syncFactsState: { method: 'PUT', path: 'facts' },
      listReviews: { method: 'GET', path: 'reviews' },
      runReviewAction: { method: 'POST', path: 'reviews' },
      evaluateReviewProfileAction: {
        method: 'GET',
        path: 'review-profiles',
      },
      listCorrections: { method: 'GET', path: 'corrections' },
      issueCorrectionAction: { method: 'POST', path: 'corrections' },
      listVersions: { method: 'GET', path: 'versions' },
      mutateVersionAction: { method: 'POST', path: 'versions' },
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
    const evaluatedRequirements = await Promise.all(
      requirements.map(async (requirement) => {
        const latestReview =
          this.id && requirement.policyKey
            ? await reviews.getLatestForPolicyKey(
                this.id as string,
                requirement.policyKey,
              )
            : null;
        const acceptedStatuses = getAcceptedContentReviewStatuses(requirement);
        const latestStatus = latestReview?.status ?? null;
        const missing = !latestReview;
        const executed = latestStatus !== null && latestStatus !== 'pending';
        const satisfied =
          latestStatus !== null && acceptedStatuses.includes(latestStatus);

        return {
          policyKey: requirement.policyKey,
          label:
            requirement.label ||
            getContentReviewPolicy(requirement.policyKey)?.label ||
            requirement.policyKey,
          blocking: requirement.blocking === true,
          acceptedStatuses,
          missing,
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

  public async runReview(options: RunContentReviewOptions = {}) {
    if (!this.id) {
      throw new Error('Cannot review unsaved content');
    }

    const kind = options.kind || 'custom';
    const policyKey = options.policyKey || kind;
    const policy = getContentReviewPolicy(policyKey);
    const facts =
      options.facts && options.facts.length > 0
        ? options.facts
        : await this.getFacts({
            latestOnly: true,
            includeSuperseded: false,
          });
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
      metadata: options.metadata || {},
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
