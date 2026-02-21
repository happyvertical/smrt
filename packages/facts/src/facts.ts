/**
 * FactCollection - Collection manager for Fact objects
 *
 * Provides query methods for facts by status, type, domain, and tenant.
 * Implements reconcile(), branch(), evolution tree, and confidence methods.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Fact } from './fact';
import { FactSourceCollection } from './fact-sources';
import { FactSubjectCollection } from './fact-subjects';
import type {
  EntityBriefing,
  EvolutionType,
  FactOptions,
  FactStatus,
  FactType,
  ReconcileOptions,
  ReconcileResult,
} from './types';
import { calculateConfidence } from './utils';

export class FactCollection extends SmrtCollection<Fact> {
  static readonly _itemClass = Fact;

  // =========================================================================
  // Simple Query Methods
  // =========================================================================

  /**
   * Get all active facts
   */
  async getActive(): Promise<Fact[]> {
    return this.list({ where: { status: 'active' } });
  }

  /**
   * Get all pending facts
   */
  async getPending(): Promise<Fact[]> {
    return this.list({ where: { status: 'pending' } });
  }

  /**
   * Get facts by type
   */
  async getByType(type: FactType): Promise<Fact[]> {
    return this.list({ where: { type } });
  }

  /**
   * Get facts by domain
   */
  async getByDomain(domain: string): Promise<Fact[]> {
    return this.list({ where: { domain } });
  }

  /**
   * Get facts by status
   */
  async getByStatus(status: FactStatus): Promise<Fact[]> {
    return this.list({ where: { status } });
  }

  /**
   * Get child facts for a parent
   */
  async getChildren(parentId: string): Promise<Fact[]> {
    return this.list({ where: { parentId } });
  }

  // =========================================================================
  // Tenant Helper Methods
  // =========================================================================

  /**
   * Find all facts belonging to a specific tenant
   */
  async findByTenant(tenantId: string): Promise<Fact[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global (tenant-less) facts
   */
  async findGlobal(): Promise<Fact[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find facts for a tenant including global facts
   */
  async findWithGlobals(tenantId: string): Promise<Fact[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }

  // =========================================================================
  // Reconcile & Evolution (Phase 1b)
  // =========================================================================

  /**
   * Reconcile raw input against existing facts using semantic search + AI.
   * Determines whether to create, merge, or branch.
   *
   * Algorithm:
   * 1. semanticSearch(rawInput) against existing facts
   * 2. Decision:
   *    - No match above conflictThreshold (0.60) -> CREATE new fact
   *    - Top match >= similarityThreshold (0.85) -> MERGE (add source, bump sourceCount)
   *    - Ambiguous zone (0.60-0.85) -> AI disambiguation via this.ai.message()
   *      - AI says "merge" -> MERGE
   *      - AI says "branch" -> BRANCH (new fact as child, parent marked superseded)
   * 3. Record FactSource if source metadata provided
   * 4. Return { action, fact, source?, similarity?, matchedFact? }
   */
  async reconcile(options: ReconcileOptions): Promise<ReconcileResult> {
    const {
      rawInput,
      similarityThreshold = 0.85,
      conflictThreshold = 0.6,
      type = 'assertion',
      domain = '',
      source,
    } = options;

    // 1. Semantic search against existing facts
    let matches: Array<Fact & { _similarity: number }> = [];
    try {
      matches = await this.semanticSearch(rawInput, {
        limit: 5,
        minSimilarity: conflictThreshold,
      });
    } catch {
      // If semantic search fails (e.g., no embeddings exist yet), treat as no match
    }

    let action: 'created' | 'merged' | 'branched';
    let fact: Fact;
    let matchedFact: Fact | undefined;
    let similarity: number | undefined;

    if (matches.length === 0 || matches[0]._similarity < conflictThreshold) {
      // No match above conflict threshold -> CREATE new fact
      fact = await this.create({
        textRefined: rawInput,
        textRaw: rawInput,
        type,
        domain,
        status: 'active',
        sourceCount: source ? 1 : 0,
        confidence: 0.5,
      });

      // Generate embeddings for the new fact
      try {
        await fact.generateEmbeddings();
      } catch {
        // Embedding generation may fail if no provider configured
      }

      action = 'created';
      // TODO: emit 'fact.discovered' via DispatchBus
    } else {
      const topMatch = matches[0];
      similarity = topMatch._similarity;
      matchedFact = topMatch;

      if (similarity >= similarityThreshold) {
        // High similarity -> MERGE (add source, bump sourceCount)
        topMatch.sourceCount += 1;
        topMatch.textRaw = rawInput;
        await topMatch.save();
        fact = topMatch;
        action = 'merged';
        // TODO: emit 'fact.discovered' via DispatchBus
      } else {
        // Ambiguous zone -> AI disambiguation
        const aiDecision = await this._disambiguateWithAI(rawInput, topMatch);

        if (aiDecision === 'merge') {
          topMatch.sourceCount += 1;
          topMatch.textRaw = rawInput;
          await topMatch.save();
          fact = topMatch;
          action = 'merged';
          // TODO: emit 'fact.discovered' via DispatchBus
        } else {
          // Branch: create child fact, mark parent as superseded
          fact = await this.branch(
            topMatch.id as string,
            {
              textRefined: rawInput,
              textRaw: rawInput,
              type,
              domain,
              status: 'active',
              sourceCount: source ? 1 : 0,
            },
            'correction',
          );
          action = 'branched';
          // TODO: emit 'fact.discovered' via DispatchBus
        }
      }
    }

    // 3. Record FactSource if source metadata provided
    let sourceRecord: import('./fact-source').FactSource | undefined;
    if (source) {
      const sourceCollection = await FactSourceCollection.create(this.options);
      sourceRecord = await sourceCollection.create({
        factId: fact.id as string,
        sourceType: source.sourceType || '',
        sourceUrl: source.sourceUrl || '',
        sourceTitle: source.sourceTitle || '',
        credibility: source.credibility ?? 0.5,
      });
    }

    return {
      action,
      fact,
      source: sourceRecord,
      similarity,
      matchedFact,
    };
  }

  /**
   * Use AI to determine whether new input should be merged with
   * or branched from an existing fact.
   */
  private async _disambiguateWithAI(
    newInput: string,
    existingFact: Fact,
  ): Promise<'merge' | 'branch'> {
    const prompt = `You are a fact reconciliation system. Compare the following two pieces of information and decide whether they should be merged (they say essentially the same thing) or branched (the new input contradicts or significantly differs from the existing fact).

Existing fact: "${existingFact.textRefined}"
New input: "${newInput}"

Respond with exactly one word: "merge" or "branch".`;

    try {
      const response = await this.ai.message(prompt);
      const normalized = response.trim().toLowerCase();
      if (normalized.includes('branch')) {
        return 'branch';
      }
      return 'merge';
    } catch {
      // If AI fails, default to branch (safer)
      return 'branch';
    }
  }

  /**
   * Create a branched fact from an existing parent.
   * For 'correction' and 'contradiction' evolution types,
   * the parent is marked as superseded.
   */
  async branch(
    parentId: string,
    data: Partial<FactOptions>,
    evolutionType: EvolutionType = 'extension',
  ): Promise<Fact> {
    // Load parent fact
    const parent = await this.get({ id: parentId });
    if (!parent) {
      throw new Error(`Parent fact not found: ${parentId}`);
    }

    // Pre-process metadata if it's an object
    const createData: Record<string, any> = { ...data };
    if (
      createData.metadata !== undefined &&
      typeof createData.metadata !== 'string'
    ) {
      createData.metadata = JSON.stringify(createData.metadata);
    }

    // Create child fact with parentId and evolutionType
    const child = await this.create({
      ...createData,
      parentId,
      evolutionType,
      status: data.status || 'active',
    } as any);

    // Generate embeddings for the child fact
    try {
      await child.generateEmbeddings();
    } catch {
      // Embedding generation may fail if no provider configured
    }

    // Mark parent as superseded if correction or contradiction
    if (evolutionType === 'correction' || evolutionType === 'contradiction') {
      parent.status = 'superseded';
      await parent.save();
    }

    return child;
  }

  /**
   * Walk up via parentId to the root fact, returning root -> current array.
   */
  async getEvolutionChain(factId: string): Promise<Fact[]> {
    const chain: Fact[] = [];
    let currentId: string = factId;

    // Walk up the chain via parentId
    while (currentId) {
      const fact = await this.get({ id: currentId });
      if (!fact) {
        break;
      }
      chain.unshift(fact); // prepend to get root->current order
      currentId = fact.parentId;
    }

    return chain;
  }

  /**
   * Walk down children to find the latest (highest confidence) leaf.
   * At each level, picks the child with the highest confidence score.
   */
  async getLatestInChain(factId: string): Promise<Fact> {
    let current = await this.get({ id: factId });
    if (!current) {
      throw new Error(`Fact not found: ${factId}`);
    }

    while (true) {
      const children = await this.getChildren(current.id as string);
      if (children.length === 0) {
        break;
      }

      // Pick child with highest confidence
      let best = children[0];
      for (let i = 1; i < children.length; i++) {
        if (children[i].confidence > best.confidence) {
          best = children[i];
        }
      }
      current = best;
    }

    return current;
  }

  /**
   * Find root of chain via getEvolutionChain, then collect all descendants recursively.
   * Returns the full tree as a flat array.
   */
  async getEvolutionTree(factId: string): Promise<Fact[]> {
    // Find root
    const chain = await this.getEvolutionChain(factId);
    if (chain.length === 0) {
      return [];
    }

    const root = chain[0];
    const tree: Fact[] = [];

    // BFS to collect all descendants
    const queue: Fact[] = [root];
    while (queue.length > 0) {
      const node = queue.shift()!;
      tree.push(node);
      const children = await this.getChildren(node.id as string);
      queue.push(...children);
    }

    return tree;
  }

  // =========================================================================
  // Confidence Scoring (Phase 1d)
  // =========================================================================

  /**
   * Recalculate confidence score for a fact based on its sources.
   * Uses calculateConfidence from utils.ts with data from FactSourceCollection.
   */
  async recalculateConfidence(factId: string): Promise<number> {
    const fact = await this.get({ id: factId });
    if (!fact) {
      throw new Error(`Fact not found: ${factId}`);
    }

    const sourceCollection = await FactSourceCollection.create(this.options);
    const sources = await sourceCollection.getForFact(factId);

    const sourceCount = sources.length;
    const avgCredibility =
      sourceCount > 0
        ? sources.reduce((sum, s) => sum + s.credibility, 0) / sourceCount
        : 0.5;

    // Calculate days since most recent source
    let daysSinceLastSource = 0;
    if (sourceCount > 0) {
      const now = new Date();
      const latestSource = sources.reduce((latest, s) => {
        const sDate =
          s.extractedAt instanceof Date
            ? s.extractedAt
            : new Date(s.extractedAt);
        const latestDate =
          latest.extractedAt instanceof Date
            ? latest.extractedAt
            : new Date(latest.extractedAt);
        return sDate > latestDate ? s : latest;
      }, sources[0]);
      const latestDate =
        latestSource.extractedAt instanceof Date
          ? latestSource.extractedAt
          : new Date(latestSource.extractedAt);
      daysSinceLastSource =
        (now.getTime() - latestDate.getTime()) / (1000 * 60 * 60 * 24);
    }

    // Get corroboration score from metadata if available
    const metadata = fact.getMetadata();
    const corroborationScore = metadata.corroborationScore ?? 0;

    const confidence = calculateConfidence({
      sourceCount,
      avgSourceCredibility: avgCredibility,
      daysSinceLastSource,
      corroborationScore,
    });

    // Update fact confidence and source count
    fact.confidence = confidence;
    fact.sourceCount = sourceCount;
    await fact.save();

    return confidence;
  }

  // =========================================================================
  // Entity Briefing
  // =========================================================================

  /**
   * Get a briefing of all facts related to a given entity.
   * Finds all FactSubject links for the entity, loads corresponding facts,
   * and returns summary statistics.
   */
  async getEntityBriefing(
    entityType: string,
    entityId: string,
  ): Promise<EntityBriefing> {
    const subjectCollection = await FactSubjectCollection.create(this.options);
    const subjects = await subjectCollection.getForEntity(entityType, entityId);

    const facts: Fact[] = [];
    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    for (const subject of subjects) {
      const fact = await this.get({ id: subject.factId });
      if (fact) {
        facts.push(fact);
        byType[fact.type] = (byType[fact.type] || 0) + 1;
        byStatus[fact.status] = (byStatus[fact.status] || 0) + 1;
      }
    }

    return {
      entityType,
      entityId,
      facts,
      totalCount: facts.length,
      byType,
      byStatus,
    };
  }
}
