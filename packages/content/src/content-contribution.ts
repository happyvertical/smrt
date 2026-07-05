import {
  AssetCollection,
  AssetStatusCollection,
  AssetTypeCollection,
} from '@happyvertical/smrt-assets';
import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ContentContributionAttachment } from './content-contribution-attachment';
import {
  type ContentContributionChannel,
  type ContentContributionIntakeDecision,
  type ContentContributionStatus,
  type ContentContributionTypeDefinition,
  resolveEffectiveContentContributionType,
} from './content-contribution-config';
import type { ContentContributionRevision } from './content-contribution-revision';
import type { ContentContributor } from './content-contributor';

export interface ContentContributionAttachmentInput {
  filename: string;
  mimeType?: string | null;
  size?: number | null;
  fileKey?: string | null;
  sourceUri?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AppendContentContributionRevisionOptions {
  title?: string | null;
  description?: string | null;
  body?: string | null;
  channel?: ContentContributionChannel;
  sourceMessageId?: string | null;
  sourceThreadKey?: string | null;
  attachments?: ContentContributionAttachmentInput[];
  metadata?: Record<string, unknown>;
}

export interface ApproveContentContributionOptions {
  editorNote?: string | null;
  promote?: boolean;
  targetStatus?: 'draft' | 'review';
}

export interface RejectContentContributionOptions {
  editorNote?: string | null;
}

export interface RequestChangesContentContributionOptions {
  editorNote?: string | null;
}

export interface WithdrawContentContributionOptions {
  reason?: string | null;
}

export interface PromoteContentContributionOptions {
  editorNote?: string | null;
  targetStatus?: 'draft' | 'review';
}

export interface ContentContributionOptions extends SmrtObjectOptions {
  contributorId?: string;
  contributionTypeKey?: string;
  status?: ContentContributionStatus;
  intakeDecision?: ContentContributionIntakeDecision;
  channel?: ContentContributionChannel;
  title?: string | null;
  description?: string | null;
  body?: string | null;
  contributorEmail?: string | null;
  contributorName?: string | null;
  threadKey?: string | null;
  sourceMessageId?: string | null;
  editorNotes?: string | null;
  promotedContentId?: string | null;
  revisionCount?: number;
  approvedAt?: Date | null;
  promotedAt?: Date | null;
  rejectedAt?: Date | null;
  withdrawnAt?: Date | null;
  requestedChangesAt?: Date | null;
  metadata?: Record<string, unknown> | string;
  tenantId?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

function parseMetadata(raw: unknown): Record<string, unknown> {
  if (!raw) {
    return {};
  }

  if (typeof raw === 'object') {
    return { ...(raw as Record<string, unknown>) };
  }

  if (typeof raw !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function inferAssetTypeSlug(mimeType: string): string {
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  return 'document';
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_contributions',
  conflictColumns: ['id'],
  api: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'delete',
      'appendRevisionAction',
      'requestChangesAction',
      'approveAction',
      'rejectAction',
      'withdrawAction',
      'promoteAction',
    ],
    routes: {
      appendRevisionAction: { method: 'POST', path: 'revisions' },
      requestChangesAction: { method: 'POST', path: 'request-changes' },
      approveAction: { method: 'POST', path: 'approve' },
      rejectAction: { method: 'POST', path: 'reject' },
      withdrawAction: { method: 'POST', path: 'withdraw' },
      promoteAction: { method: 'POST', path: 'promote' },
    },
  },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class ContentContribution extends SmrtObject {
  @foreignKey('ContentContributor', { required: true })
  contributorId = '';

  @field({ required: true })
  contributionTypeKey = '';

  status: ContentContributionStatus = 'submitted';
  intakeDecision: ContentContributionIntakeDecision = 'accepted';
  channel: ContentContributionChannel = 'web';
  title = '';
  description = '';
  body = '';
  contributorEmail = '';
  contributorName = '';
  threadKey = '';

  @crossPackageRef('@happyvertical/smrt-messages:Message')
  sourceMessageId = '';

  editorNotes = '';

  @foreignKey('Content')
  promotedContentId = '';
  revisionCount = 0;
  approvedAt: Date | null = null;
  promotedAt: Date | null = null;
  rejectedAt: Date | null = null;
  withdrawnAt: Date | null = null;
  requestedChangesAt: Date | null = null;
  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentContributionOptions = {}) {
    super(options);
    if (options.contributorId !== undefined)
      this.contributorId = options.contributorId;
    if (options.contributionTypeKey !== undefined)
      this.contributionTypeKey = options.contributionTypeKey;
    if (options.status !== undefined) this.status = options.status;
    if (options.intakeDecision !== undefined)
      this.intakeDecision = options.intakeDecision;
    if (options.channel !== undefined) this.channel = options.channel;
    if (options.title !== undefined) this.title = options.title || '';
    if (options.description !== undefined)
      this.description = options.description || '';
    if (options.body !== undefined) this.body = options.body || '';
    if (options.contributorEmail !== undefined)
      this.contributorEmail = options.contributorEmail || '';
    if (options.contributorName !== undefined)
      this.contributorName = options.contributorName || '';
    if (options.threadKey !== undefined)
      this.threadKey = options.threadKey || '';
    if (options.sourceMessageId !== undefined)
      this.sourceMessageId = options.sourceMessageId || '';
    if (options.editorNotes !== undefined)
      this.editorNotes = options.editorNotes || '';
    if (options.promotedContentId !== undefined)
      this.promotedContentId = options.promotedContentId || '';
    if (options.revisionCount !== undefined)
      this.revisionCount = options.revisionCount;
    if (options.approvedAt !== undefined) this.approvedAt = options.approvedAt;
    if (options.promotedAt !== undefined) this.promotedAt = options.promotedAt;
    if (options.rejectedAt !== undefined) this.rejectedAt = options.rejectedAt;
    if (options.withdrawnAt !== undefined)
      this.withdrawnAt = options.withdrawnAt;
    if (options.requestedChangesAt !== undefined)
      this.requestedChangesAt = options.requestedChangesAt;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;
    if (options.metadata !== undefined) {
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    }
  }

  getMetadata(): Record<string, unknown> {
    return parseMetadata(this.metadata);
  }

  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata || {});
  }

  protected override transformJSON(json: Record<string, unknown>) {
    return {
      ...json,
      description: this.description || null,
      body: this.body || null,
      contributorEmail: this.contributorEmail || null,
      contributorName: this.contributorName || null,
      threadKey: this.threadKey || null,
      sourceMessageId: this.sourceMessageId || null,
      editorNotes: this.editorNotes || null,
      promotedContentId: this.promotedContentId || null,
      metadata: this.getMetadata(),
    };
  }

  private async getRevisionCollection() {
    const { ContentContributionRevisionCollection } = await import(
      './content-contribution-revisions'
    );
    return ContentContributionRevisionCollection.create(this.options);
  }

  private async getAttachmentCollection() {
    const { ContentContributionAttachmentCollection } = await import(
      './content-contribution-attachments'
    );
    return ContentContributionAttachmentCollection.create(this.options);
  }

  private async getContributorCollection() {
    const { ContentContributorCollection } = await import(
      './content-contributors'
    );
    return ContentContributorCollection.create(this.options);
  }

  private async getContentsCollection() {
    const { Contents } = await import('./contents');
    return Contents.create({ db: this.db });
  }

  private async getAssetCollection() {
    return AssetCollection.create(this.options);
  }

  private async getAssetStatusCollection() {
    return AssetStatusCollection.create(this.options);
  }

  private async getAssetTypeCollection() {
    return AssetTypeCollection.create(this.options);
  }

  async getContributor(): Promise<ContentContributor | null> {
    if (!this.contributorId) {
      return null;
    }

    const contributors = await this.getContributorCollection();
    return contributors.get({ id: this.contributorId });
  }

  async getRevisions(): Promise<ContentContributionRevision[]> {
    if (!this.id) {
      return [];
    }

    const revisions = await this.getRevisionCollection();
    return revisions.listForContribution(this.id);
  }

  async getLatestRevision(): Promise<ContentContributionRevision | null> {
    if (!this.id) {
      return null;
    }

    const revisions = await this.getRevisionCollection();
    return revisions.getLatestForContribution(this.id);
  }

  async getAttachments(): Promise<ContentContributionAttachment[]> {
    if (!this.id) {
      return [];
    }

    const attachments = await this.getAttachmentCollection();
    return attachments.listForContribution(this.id);
  }

  async resolveContributionType(): Promise<ContentContributionTypeDefinition | null> {
    return resolveEffectiveContentContributionType(this.contributionTypeKey, {
      db: this.db,
      tenantId: this.tenantId ?? null,
    });
  }

  private ensureEditable(): void {
    if (
      this.revisionCount > 0 &&
      ['rejected', 'withdrawn', 'promoted'].includes(this.status)
    ) {
      throw new Error(
        `Contribution "${this.id || 'new'}" cannot be edited once it is ${this.status}.`,
      );
    }
  }

  private async createRevision(
    options: AppendContentContributionRevisionOptions,
  ): Promise<ContentContributionRevision> {
    if (!this.id) {
      throw new Error('Contribution must be saved before creating revisions.');
    }

    const revisions = await this.getRevisionCollection();
    const nextRevisionNumber = Math.max(1, this.revisionCount + 1);
    const revision = await revisions.create({
      contributionId: this.id,
      revisionNumber: nextRevisionNumber,
      channel: options.channel || this.channel,
      title: options.title ?? this.title,
      description: options.description ?? this.description,
      body: options.body ?? this.body,
      sourceMessageId: options.sourceMessageId || '',
      sourceThreadKey: options.sourceThreadKey || this.threadKey || '',
      metadata: JSON.stringify(options.metadata || {}),
      tenantId: this.tenantId,
    });

    return revision;
  }

  private async createHeldAttachments(
    revisionId: string | null,
    attachments: ContentContributionAttachmentInput[],
    channel: ContentContributionChannel,
  ): Promise<ContentContributionAttachment[]> {
    if (!this.id || attachments.length === 0) {
      return [];
    }

    const records = await this.getAttachmentCollection();
    const created: ContentContributionAttachment[] = [];
    for (const attachment of attachments) {
      const item = await records.create({
        contributionId: this.id,
        revisionId: revisionId || '',
        filename: attachment.filename,
        mimeType: attachment.mimeType || 'application/octet-stream',
        size: Math.max(0, attachment.size || 0),
        fileKey: attachment.fileKey || '',
        sourceUri: attachment.sourceUri || '',
        channel,
        tenantId: this.tenantId,
        metadata: JSON.stringify(attachment.metadata || {}),
      });
      created.push(item);
    }

    return created;
  }

  async appendRevisionAction(
    options: AppendContentContributionRevisionOptions = {},
  ) {
    this.ensureEditable();

    const revision = await this.createRevision(options);
    await this.createHeldAttachments(
      revision.id || null,
      options.attachments || [],
      options.channel || this.channel,
    );

    this.title = options.title ?? this.title;
    this.description = options.description ?? this.description;
    this.body = options.body ?? this.body;
    this.channel = options.channel || this.channel;
    this.sourceMessageId = options.sourceMessageId || this.sourceMessageId;
    this.threadKey = options.sourceThreadKey || this.threadKey;
    this.revisionCount = revision.revisionNumber;

    if (this.status === 'needs_changes') {
      this.status = 'submitted';
      this.requestedChangesAt = null;
    }

    const metadata = this.getMetadata();
    metadata.lastRevisionId = revision.id || null;
    metadata.lastRevisionAt = revision.createdAt.toISOString();
    this.setMetadata(metadata);
    await this.save();

    return {
      contribution: this.toJSON(),
      revision: revision.toJSON(),
      attachments: (await this.getAttachments()).map((item) => item.toJSON()),
    };
  }

  async requestChangesAction(
    options: RequestChangesContentContributionOptions = {},
  ) {
    if (['rejected', 'withdrawn', 'promoted'].includes(this.status)) {
      throw new Error(
        `Contribution "${this.id || 'new'}" cannot request changes after ${this.status}.`,
      );
    }

    this.status = 'needs_changes';
    this.requestedChangesAt = new Date();
    this.editorNotes = options.editorNote || this.editorNotes;

    const metadata = this.getMetadata();
    const requestHistory = Array.isArray(metadata.requestChangesHistory)
      ? metadata.requestChangesHistory
      : [];
    requestHistory.push({
      note: options.editorNote || '',
      at: this.requestedChangesAt.toISOString(),
    });
    metadata.requestChangesHistory = requestHistory;
    this.setMetadata(metadata);

    await this.save();
    return this.toJSON();
  }

  async rejectAction(options: RejectContentContributionOptions = {}) {
    if (this.status === 'promoted') {
      throw new Error('Promoted contributions cannot be rejected.');
    }

    this.status = 'rejected';
    this.rejectedAt = new Date();
    this.editorNotes = options.editorNote || this.editorNotes;

    const metadata = this.getMetadata();
    metadata.rejection = {
      note: options.editorNote || '',
      at: this.rejectedAt.toISOString(),
    };
    this.setMetadata(metadata);

    await this.save();
    return this.toJSON();
  }

  async withdrawAction(options: WithdrawContentContributionOptions = {}) {
    if (this.status === 'promoted') {
      throw new Error('Promoted contributions cannot be withdrawn.');
    }

    this.status = 'withdrawn';
    this.withdrawnAt = new Date();

    const metadata = this.getMetadata();
    metadata.withdrawal = {
      reason: options.reason || '',
      at: this.withdrawnAt.toISOString(),
    };
    this.setMetadata(metadata);

    await this.save();
    return this.toJSON();
  }

  async approveAction(options: ApproveContentContributionOptions = {}) {
    if (['rejected', 'withdrawn', 'promoted'].includes(this.status)) {
      throw new Error(
        `Contribution "${this.id || 'new'}" cannot be approved after ${this.status}.`,
      );
    }

    this.status = 'approved';
    this.approvedAt = new Date();
    this.editorNotes = options.editorNote || this.editorNotes;
    await this.save();

    if (options.promote === false) {
      return {
        contribution: this.toJSON(),
        content: null,
        assets: [],
      };
    }

    return this.promoteAction({
      editorNote: options.editorNote,
      targetStatus: options.targetStatus,
    });
  }

  async promoteAction(options: PromoteContentContributionOptions = {}) {
    if (this.promotedContentId) {
      const contents = await this.getContentsCollection();
      const content = await contents.get({ id: this.promotedContentId });
      return {
        contribution: this.toJSON(),
        content: content ? content.toJSON() : null,
        assets: await this.getAttachments().then((items) =>
          items
            .filter((item) => item.promotedAssetId)
            .map((item) => ({
              attachmentId: item.id,
              assetId: item.promotedAssetId,
            })),
        ),
      };
    }

    const type = await this.resolveContributionType();
    if (!type) {
      throw new Error(
        `Contribution type "${this.contributionTypeKey}" is not configured.`,
      );
    }

    const promotion = type.promotion || {};
    if (!promotion.targetContentType) {
      throw new Error(
        `Contribution type "${type.key}" is missing promotion.targetContentType.`,
      );
    }

    const contributor = await this.getContributor();
    const latestRevision = await this.getLatestRevision();
    const attachments = await this.getAttachments();

    const contents = await this.getContentsCollection();
    const content = await contents.create({
      tenantId: this.tenantId,
      type: promotion.targetContentType,
      variant: promotion.targetContentVariant || null,
      source: 'contribution',
      status: options.targetStatus || promotion.targetContentStatus || 'draft',
      title: latestRevision?.title || this.title,
      description: latestRevision?.description || this.description || null,
      body: latestRevision?.body || this.body || '',
      author:
        contributor?.name ||
        this.contributorName ||
        this.contributorEmail ||
        null,
      name:
        latestRevision?.title ||
        this.title ||
        `${type.label || type.key} contribution`,
      metadata: {
        contribution: {
          contributionId: this.id || null,
          contributorId: this.contributorId || null,
          contributorEmail: this.contributorEmail || null,
          contributorName: this.contributorName || null,
          contributionTypeKey: this.contributionTypeKey,
          revisionCount: this.revisionCount,
          sourceMessageId: this.sourceMessageId || null,
          threadKey: this.threadKey || null,
        },
      },
    });
    await content.save();

    const promotedAssets: Array<{
      attachmentId: string | null;
      assetId: string | null;
    }> = [];

    if (promotion.createAssets !== false && attachments.length > 0) {
      const [assets, statuses, typesCollection] = await Promise.all([
        this.getAssetCollection(),
        this.getAssetStatusCollection(),
        this.getAssetTypeCollection(),
      ]);

      await Promise.all([
        statuses.initializeCommonStatuses(),
        typesCollection.initializeCommonTypes(),
      ]);

      for (const [index, attachment] of attachments.entries()) {
        const asset = await assets.create({
          tenantId: this.tenantId,
          ownerProfileId: contributor?.profileId || null,
          name: attachment.filename || `Contribution attachment ${index + 1}`,
          description: `Promoted from contribution ${this.id || ''}`.trim(),
          mimeType: attachment.mimeType || 'application/octet-stream',
          sourceUri:
            attachment.sourceUri ||
            attachment.fileKey ||
            `held://content-contribution/${attachment.id || index}`,
          typeSlug: inferAssetTypeSlug(attachment.mimeType || ''),
          statusSlug: 'draft',
          sourceType: 'content-contribution',
          externalId: attachment.id || '',
        });
        await asset.save();

        await content.addAsset(
          asset,
          promotion.assetRelationship || 'attachment',
          index,
        );

        attachment.promotedAssetId = asset.id || '';
        await attachment.save();
        promotedAssets.push({
          attachmentId: attachment.id || null,
          assetId: asset.id || null,
        });
      }
    }

    this.promotedContentId = content.id || '';
    this.promotedAt = new Date();
    this.status = 'promoted';
    this.editorNotes = options.editorNote || this.editorNotes;

    const metadata = this.getMetadata();
    metadata.promotion = {
      contentId: content.id || null,
      contentStatus: content.status || null,
      promotedAt: this.promotedAt.toISOString(),
      assetIds: promotedAssets.map((item) => item.assetId).filter(Boolean),
    };
    this.setMetadata(metadata);
    await this.save();

    return {
      contribution: this.toJSON(),
      content: content.toJSON(),
      assets: promotedAssets,
    };
  }
}
