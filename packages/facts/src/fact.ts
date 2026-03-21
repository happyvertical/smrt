/**
 * Fact model - Atomic knowledge unit with provenance tracking
 *
 * Core entity for distributed memory. Facts represent individual pieces
 * of knowledge with semantic embeddings for similarity search, evolution
 * tracking via parentId, and confidence scoring.
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  EvolutionType,
  FactMetadata,
  FactOptions,
  FactStatus,
  FactType,
} from './types';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  embeddings: {
    fields: ['textRefined'],
    autoGenerate: true,
    combinedField: {
      name: 'full_context',
      template: '{textRefined}\n\nType: {type}\nDomain: {domain}',
    },
  },
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
})
export class Fact extends SmrtObject {
  @field({ required: true })
  textRefined: string = '';

  @field()
  textRaw: string = '';

  @field({ required: true })
  type: string = 'assertion';

  @field({ required: true })
  status: string = 'pending';

  @field()
  domain: string = '';

  @field()
  parentId: string = '';

  @field()
  evolutionType: string = 'original';

  @field()
  sourceCount: number = 0;

  @field()
  confidence: number = 0.0;

  @field()
  metadata: string = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field()
  createdAt: Date = new Date();
  @field()
  updatedAt: Date = new Date();

  constructor(options: FactOptions = {}) {
    super(options);
    if (options.textRefined) this.textRefined = options.textRefined;
    if (options.textRaw !== undefined) this.textRaw = options.textRaw;
    if (options.type !== undefined) this.type = options.type;
    if (options.status !== undefined) this.status = options.status;
    if (options.domain !== undefined) this.domain = options.domain;
    if (options.parentId !== undefined) this.parentId = options.parentId;
    if (options.evolutionType !== undefined)
      this.evolutionType = options.evolutionType;
    if (options.sourceCount !== undefined)
      this.sourceCount = options.sourceCount;
    if (options.confidence !== undefined) this.confidence = options.confidence;

    if (options.metadata !== undefined) {
      if (typeof options.metadata === 'string') {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }
  }

  getMetadata(): FactMetadata {
    const raw = this.metadata;
    if (!raw) return {};
    if (typeof raw === 'object') return raw as unknown as FactMetadata;
    try {
      return JSON.parse(String(raw));
    } catch {
      return {};
    }
  }

  setMetadata(data: FactMetadata): void {
    this.metadata = JSON.stringify(data);
  }

  updateMetadata(updates: Partial<FactMetadata>): void {
    const current = this.getMetadata();
    const merged = { ...current, ...updates };
    this.metadata = JSON.stringify(merged);
  }

  getType(): FactType {
    return this.type as FactType;
  }

  getStatus(): FactStatus {
    return this.status as FactStatus;
  }

  getEvolutionType(): EvolutionType {
    return this.evolutionType as EvolutionType;
  }

  isActive(): boolean {
    return this.status === 'active';
  }

  isSuperseded(): boolean {
    return this.status === 'superseded';
  }

  hasParent(): boolean {
    return this.parentId !== '';
  }

  /**
   * Get the parent fact in the evolution chain
   */
  async getParent(): Promise<Fact | null> {
    if (!this.parentId) return null;

    const { FactCollection } = await import('./facts');
    const collection = await (FactCollection as any).create(this.options);
    return await collection.get({ id: this.parentId });
  }

  /**
   * Get child facts (facts that evolved from this one)
   */
  async getChildren(): Promise<Fact[]> {
    const { FactCollection } = await import('./facts');
    const collection = await (FactCollection as any).create(this.options);
    return await collection.list({ where: { parentId: this.id } });
  }

  /**
   * Get all sources for this fact
   */
  async getSources(): Promise<import('./fact-source').FactSource[]> {
    const { FactSourceCollection } = await import('./fact-sources');
    const collection = await (FactSourceCollection as any).create(this.options);
    return await collection.getForFact(this.id as string);
  }

  /**
   * Get all subjects linked to this fact
   */
  async getSubjects(): Promise<import('./fact-subject').FactSubject[]> {
    const { FactSubjectCollection } = await import('./fact-subjects');
    const collection = await (FactSubjectCollection as any).create(
      this.options,
    );
    return await collection.getForFact(this.id as string);
  }
}
