/**
 * Fact model - Atomic knowledge unit with provenance tracking
 *
 * Core entity for distributed memory. Facts represent individual pieces
 * of knowledge with semantic embeddings for similarity search, evolution
 * tracking via previousFactId (self-referencing chain: original →
 * correction/contradiction/refinement), and confidence scoring.
 *
 * Note: this is an evolution chain, not a structural hierarchy. Fact
 * deliberately does NOT extend SmrtHierarchical — `parentId` is reserved
 * for true structural hierarchy (Place, Event, Tag, Account, Zone). See
 * R3-C in the relationships-v2 release for the rationale behind the
 * semantic distinction.
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
    provider: 'auto',
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

  /**
   * Self-referencing pointer to the predecessor fact in an evolution chain.
   *
   * This is NOT a structural hierarchy edge — Fact does not extend
   * SmrtHierarchical. The chain represents knowledge evolution: an original
   * fact, then corrections, refinements, contradictions, or extensions of
   * that fact. See `evolutionType` for the kind of step.
   */
  @field()
  previousFactId: string = '';

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
    if (options.previousFactId !== undefined)
      this.previousFactId = options.previousFactId;
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

  /**
   * Whether this fact has a predecessor in the evolution chain.
   *
   * Returns false for the framework default (`''`) and for any nullish
   * value — defensive against rows whose `previous_fact_id` column is
   * NULL (e.g. after a migration that left root facts un-backfilled).
   */
  hasPredecessor(): boolean {
    return Boolean(this.previousFactId);
  }

  /**
   * Get the predecessor fact (the prior version in the evolution chain).
   */
  async getPredecessor(): Promise<Fact | null> {
    if (!this.previousFactId) return null;

    const { FactCollection } = await import('./facts');
    const collection = await (FactCollection as any).create(this.options);
    return await collection.get({ id: this.previousFactId });
  }

  /**
   * Get successor facts (facts that evolved directly from this one).
   */
  async getSuccessors(): Promise<Fact[]> {
    const { FactCollection } = await import('./facts');
    const collection = await (FactCollection as any).create(this.options);
    return await collection.list({ where: { previousFactId: this.id } });
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
