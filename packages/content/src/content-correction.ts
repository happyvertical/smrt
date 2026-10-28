import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  ContentCorrectionStatus,
  ContentCorrectionType,
} from './content-governance';

export interface ContentCorrectionOptions extends SmrtObjectOptions {
  contentId?: string;
  contentVersionId?: string;
  factId?: string;
  replacementFactId?: string;
  correctionType?: ContentCorrectionType;
  status?: ContentCorrectionStatus;
  summary?: string;
  incorrectText?: string;
  correctedText?: string;
  publicNote?: string;
  metadata?: string | Record<string, unknown>;
  tenantId?: string | null;
  publishedAt?: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_corrections',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: { skipApiCheck: true },
})
export class ContentCorrection extends SmrtObject {
  @foreignKey('Content', { required: true, onDelete: 'CASCADE' })
  @field({ description: 'The piece being corrected.' })
  contentId = '';

  @foreignKey('ContentVersion', { onDelete: 'CASCADE' })
  contentVersionId = '';

  @crossPackageRef('@happyvertical/smrt-facts:Fact')
  factId = '';

  @crossPackageRef('@happyvertical/smrt-facts:Fact')
  replacementFactId = '';
  @field({
    description:
      'What kind of mistake it fixes: a fact, a safety concern, wording or something else.',
  })
  correctionType: ContentCorrectionType = 'fact';

  @field({
    description:
      'Where the correction stands: a draft, published or retracted.',
  })
  status: ContentCorrectionStatus = 'draft';

  @field({
    description: 'A short note on what was wrong and how it was fixed.',
  })
  summary = '';

  @field({ description: 'The wording that was wrong.' })
  incorrectText = '';

  @field({ description: 'The wording that replaces it.' })
  correctedText = '';

  @field({ description: 'The note readers see about this correction.' })
  publicNote = '';
  metadata = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ description: 'When the correction was made public.' })
  publishedAt: Date | null = null;
  createdAt = new Date();
  updatedAt = new Date();

  constructor(options: ContentCorrectionOptions = {}) {
    super(options);
    if (options.contentId) this.contentId = options.contentId;
    if (options.contentVersionId !== undefined)
      this.contentVersionId = options.contentVersionId;
    if (options.factId !== undefined) this.factId = options.factId;
    if (options.replacementFactId !== undefined)
      this.replacementFactId = options.replacementFactId;
    if (options.correctionType !== undefined)
      this.correctionType = options.correctionType;
    if (options.status !== undefined) this.status = options.status;
    if (options.summary !== undefined) this.summary = options.summary;
    if (options.incorrectText !== undefined)
      this.incorrectText = options.incorrectText;
    if (options.correctedText !== undefined)
      this.correctedText = options.correctedText;
    if (options.publicNote !== undefined) this.publicNote = options.publicNote;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.publishedAt !== undefined)
      this.publishedAt = options.publishedAt;
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
    try {
      return this.metadata ? JSON.parse(this.metadata) : {};
    } catch {
      return {};
    }
  }
}
