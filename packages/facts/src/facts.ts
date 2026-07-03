/**
 * FactCollection - Collection manager for Fact objects
 *
 * Provides query methods for facts by status, type, domain, and tenant.
 * Implements reconcile(), branch(), evolution tree, and confidence methods.
 */

import { SmrtCollection, type SmrtCreateInput } from '@happyvertical/smrt-core';
import {
  type PromptConfigOverrideInput,
  type ResolvedPromptAI,
  resolvePrompt,
} from '@happyvertical/smrt-prompts';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { Fact } from './fact';
import { FactSourceCollection } from './fact-sources';
import { FactSubjectCollection } from './fact-subjects';
import {
  smrtFactsAssessClaimSupportPrompt,
  smrtFactsExtractArticleClaimsPrompt,
  smrtFactsExtractCandidatesPrompt,
  smrtFactsReconcilePrompt,
} from './prompts';
import type {
  EntityBriefing,
  EvolutionType,
  FactClaimSupportAssessment,
  FactClaimSupportCandidate,
  FactClaimSupportOptions,
  FactClaimSupportStatus,
  FactContentRelationship,
  FactExtractionCandidate,
  FactExtractionOptions,
  FactOptions,
  FactStatus,
  FactType,
  ReconcileOptions,
  ReconcileResult,
} from './types';
import { calculateConfidence } from './utils';

const DEFAULT_EXTRACTION_FACT_TYPES: FactType[] = [
  'assertion',
  'event',
  'relationship',
  'measurement',
  'definition',
  'observation',
];

function normalizeWhitespace(value: string | null | undefined): string {
  return value?.trim().replace(/\s+/g, ' ') || '';
}

function extractJSONPayload(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const source = fenced?.[1] || raw;
  const candidates = [
    { start: source.indexOf('{'), end: source.lastIndexOf('}') },
    { start: source.indexOf('['), end: source.lastIndexOf(']') },
  ].filter(
    (candidate) => candidate.start !== -1 && candidate.end > candidate.start,
  );

  candidates.sort((left, right) => left.start - right.start);
  if (candidates[0]) {
    return source.slice(candidates[0].start, candidates[0].end + 1);
  }

  throw new Error('AI fact extraction response did not contain JSON');
}

function normalizeFactType(value: unknown): FactType {
  const allowed: FactType[] = [
    'assertion',
    'observation',
    'measurement',
    'definition',
    'relationship',
    'event',
    'opinion',
    'prediction',
  ];
  return allowed.includes(value as FactType)
    ? (value as FactType)
    : 'assertion';
}

function normalizeConfidence(value: unknown): number | undefined {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return undefined;
  }

  return Math.max(0, Math.min(1, value));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseFactExtractionResponse(raw: string): FactExtractionCandidate[] {
  const parsed: unknown = JSON.parse(extractJSONPayload(raw));
  const entries: unknown[] = Array.isArray(parsed)
    ? parsed
    : isPlainRecord(parsed) && Array.isArray(parsed.facts)
      ? parsed.facts
      : isPlainRecord(parsed) && parsed.statement
        ? [parsed]
        : [];

  return entries
    .map((entry: unknown): FactExtractionCandidate | null => {
      const record = isPlainRecord(entry) ? entry : {};
      const statement = normalizeWhitespace(asOptionalString(record.statement));
      if (!statement) {
        return null;
      }

      const metadata = record.metadata;
      return {
        statement,
        type: normalizeFactType(record.type),
        sourceExcerpt:
          normalizeWhitespace(asOptionalString(record.sourceExcerpt)) ||
          undefined,
        confidence: normalizeConfidence(record.confidence),
        metadata: isPlainRecord(metadata) ? metadata : undefined,
      };
    })
    .filter(
      (
        entry: FactExtractionCandidate | null,
      ): entry is FactExtractionCandidate => entry !== null,
    );
}

function normalizeSupportStatus(value: unknown): FactClaimSupportStatus {
  const allowed: FactClaimSupportStatus[] = [
    'supported',
    'unsupported',
    'contradicted',
    'needs_review',
  ];
  return allowed.includes(value as FactClaimSupportStatus)
    ? (value as FactClaimSupportStatus)
    : 'needs_review';
}

function parseClaimSupportResponse(raw: string): FactClaimSupportAssessment {
  const parsed = JSON.parse(extractJSONPayload(raw));
  const matchedFactIds = Array.isArray(parsed?.matchedFactIds)
    ? parsed.matchedFactIds.filter(
        (id: unknown): id is string => typeof id === 'string' && id.length > 0,
      )
    : [];
  const matchedEvidenceIds = Array.isArray(parsed?.matchedEvidenceIds)
    ? parsed.matchedEvidenceIds.filter(
        (id: unknown): id is string => typeof id === 'string' && id.length > 0,
      )
    : [];

  return {
    status: normalizeSupportStatus(parsed?.status),
    matchedFactIds,
    matchedEvidenceIds,
    rationale: normalizeWhitespace(parsed?.rationale) || '',
    confidence: normalizeConfidence(parsed?.confidence),
  };
}

function promptMessageOptions(ai: ResolvedPromptAI) {
  return {
    ...(ai.params || {}),
    ...(ai.model ? { model: ai.model } : {}),
    ...(typeof ai.temperature === 'number'
      ? { temperature: ai.temperature }
      : {}),
    ...(typeof ai.maxTokens === 'number' ? { maxTokens: ai.maxTokens } : {}),
  };
}

/**
 * Minimal structural shape of an AI client that can answer text prompts.
 */
interface MessageCapableAi {
  message: (
    prompt: string,
    options?: Record<string, unknown>,
  ) => Promise<string>;
}

/**
 * Narrow an opaque options-supplied AI client to one exposing `message()`.
 * Returns null when the client does not provide a callable `message`.
 */
function asMessageCapableAi(ai: unknown): MessageCapableAi | null {
  return ai && typeof (ai as Partial<MessageCapableAi>).message === 'function'
    ? (ai as MessageCapableAi)
    : null;
}

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
   * Get successor facts for a given predecessor (facts that evolved
   * directly from `previousFactId`).
   */
  async getSuccessors(previousFactId: string): Promise<Fact[]> {
    return this.list({ where: { previousFactId } });
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
   * Find all global (tenant-less) facts.
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   */
  async findGlobal(): Promise<Fact[]> {
    return queryGlobal<Fact>(this);
  }

  /**
   * Find facts for a tenant including global facts.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   */
  async findWithGlobals(tenantId: string): Promise<Fact[]> {
    return queryWithGlobals<Fact>(this, tenantId, 'Fact.findWithGlobals');
  }

  /**
   * Browse active facts for editorial association.
   * Uses semantic search when a query is provided and falls back to text filtering
   * if embeddings are unavailable.
   */
  async browseCatalog(
    query = '',
    options: {
      tenantId?: string | null;
      limit?: number;
      offset?: number;
      minSimilarity?: number;
      includeSuperseded?: boolean;
      latestOnly?: boolean;
    } = {},
  ): Promise<Fact[]> {
    const {
      tenantId,
      limit = 25,
      offset = 0,
      minSimilarity = 0.55,
      includeSuperseded = false,
      latestOnly = true,
    } = options;
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.floor(limit))
      : 25;
    const safeOffset = Number.isFinite(offset)
      ? Math.max(0, Math.floor(offset))
      : 0;
    const pageEnd = safeOffset + safeLimit;
    const latestResolutionLimit = pageEnd + safeLimit;
    const resolveLatestPage = async (facts: Fact[]): Promise<Fact[]> => {
      const latestById = new Map<string, Fact>();

      for (const fact of facts.slice(0, latestResolutionLimit)) {
        const factId = fact.id as string;
        if (!factId) {
          continue;
        }

        const latest = await this.getLatestInChain(factId);
        latestById.set(latest.id as string, latest);
        if (latestById.size >= pageEnd) {
          break;
        }
      }

      return [...latestById.values()].slice(safeOffset, pageEnd);
    };

    const baseList =
      tenantId === undefined || tenantId === null
        ? await this.list({
            where: includeSuperseded ? {} : { status: 'active' },
            orderBy: 'updated_at DESC',
          })
        : await this.findWithGlobals(tenantId);

    const tenantScoped = includeSuperseded
      ? baseList
      : baseList.filter((fact) => fact.status !== 'superseded');
    const tenantScopedIds = new Set(
      tenantScoped
        .map((fact) => fact.id)
        .filter((factId): factId is string => typeof factId === 'string'),
    );

    if (!query.trim()) {
      if (!latestOnly) {
        return tenantScoped.slice(safeOffset, safeOffset + safeLimit);
      }

      return resolveLatestPage(tenantScoped);
    }

    let matches: Fact[] = [];
    try {
      matches = await this.semanticSearch(query, {
        limit: safeOffset + safeLimit,
        minSimilarity,
        where: includeSuperseded ? undefined : { status: 'active' },
      });

      if (tenantScopedIds.size > 0) {
        matches = matches.filter(
          (fact) => typeof fact.id === 'string' && tenantScopedIds.has(fact.id),
        );
      }
    } catch {
      const normalizedQuery = query.toLowerCase();
      matches = tenantScoped.filter((fact) => {
        const haystack = `${fact.textRefined} ${fact.textRaw}`.toLowerCase();
        return haystack.includes(normalizedQuery);
      });
    }

    if (!latestOnly) {
      return matches.slice(safeOffset, safeOffset + safeLimit);
    }

    return resolveLatestPage(matches);
  }

  /**
   * Get all facts linked to a content item.
   */
  async getForContent(
    contentId: string,
    options: {
      relationship?: FactContentRelationship;
      includeSuperseded?: boolean;
      latestOnly?: boolean;
    } = {},
  ): Promise<Fact[]> {
    const {
      relationship,
      includeSuperseded = false,
      latestOnly = true,
    } = options;

    const { FactContentCollection } = await import('./fact-contents');
    const links = await FactContentCollection.create(this.options);
    const relatedLinks = relationship
      ? await links.byRight(contentId, { relationship })
      : await links.byRight(contentId);

    const uniqueFactIds = [...new Set(relatedLinks.map((link) => link.factId))];
    const loadedFacts = await Promise.all(
      uniqueFactIds.map((factId) => this.get({ id: factId })),
    );

    const filtered = loadedFacts.filter((fact): fact is Fact => {
      if (!fact) return false;
      if (includeSuperseded) return true;
      return fact.status !== 'superseded';
    });

    if (!latestOnly) {
      return filtered;
    }

    const latestFacts = await Promise.all(
      filtered.map((fact) => this.getLatestInChain(fact.id as string)),
    );

    return [
      ...new Map(latestFacts.map((fact) => [fact.id as string, fact])).values(),
    ];
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
   *      - AI says "branch" -> BRANCH (new fact as successor, predecessor marked superseded)
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
      // Semantic search may fail if no embeddings exist yet — treat as no match
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
        tenantId: options.tenantId ?? null,
        status: 'active',
        sourceCount: source ? 1 : 0,
        confidence: calculateConfidence({
          sourceCount: source ? 1 : 0,
          avgSourceCredibility: source?.credibility ?? 0.5,
        }),
        _skipAutoEmbeddings: true,
      });

      // Generate embeddings for the new fact
      try {
        await fact.generateEmbeddings();
      } catch {
        // Embedding generation may fail if no provider is configured
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
        const aiDecision = await this._disambiguateWithAI(
          rawInput,
          topMatch,
          options.promptOverride,
          options.tenantId ?? undefined,
        );

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
              tenantId: options.tenantId ?? null,
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
        metadata:
          source.metadata === undefined
            ? undefined
            : typeof source.metadata === 'string'
              ? source.metadata
              : JSON.stringify(source.metadata),
        tenantId: options.tenantId ?? null,
      });
    }

    // Recalculate confidence after source recording
    if (action === 'merged' && sourceRecord) {
      try {
        await this.recalculateConfidence(fact.id as string);
        // Reload to get updated confidence
        const updated = await this.get({ id: fact.id });
        if (updated) fact = updated;
      } catch {
        // Non-fatal: confidence stays at previous value
      }
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
   * Extract atomic factual statements from unstructured source text using AI.
   *
   * This method is intentionally non-persistent: callers can review, reconcile,
   * link, or discard the returned candidates according to their app workflow.
   */
  async extractCandidatesFromText(
    text: string,
    options: FactExtractionOptions = {},
  ): Promise<FactExtractionCandidate[]> {
    const sourceText = normalizeWhitespace(text);
    if (!sourceText) {
      return [];
    }

    const {
      domain = '',
      sourceType = 'source',
      context = '',
      maxFacts = 12,
      allowedTypes = DEFAULT_EXTRACTION_FACT_TYPES,
    } = options;

    const resolvedPrompt = await resolvePrompt(
      smrtFactsExtractCandidatesPrompt.key,
      {
        db: this.options.db,
        tenantId: options.tenantId,
        override: options.promptOverride,
        variables: {
          allowedTypes: allowedTypes.join(', '),
          context: context || 'No additional context.',
          domain: domain || 'general',
          maxFacts,
          sourceText,
          sourceType,
        },
      },
    );

    const directAi = asMessageCapableAi(this.options.ai);
    const ai = directAi || (await this.getAiClient());
    if (typeof ai.message !== 'function') {
      throw new Error(
        'AI fact extraction requires an AI client with a message() method',
      );
    }

    const response = await ai.message(
      resolvedPrompt.text,
      promptMessageOptions(resolvedPrompt.ai),
    );
    return parseFactExtractionResponse(response).slice(0, maxFacts);
  }

  /**
   * Extract material factual claims made by an article.
   *
   * This is intentionally separate from source extraction: source extraction
   * finds evidence-backed facts, while claim extraction finds statements the
   * draft itself needs to justify.
   */
  async extractArticleClaims(
    text: string,
    options: FactExtractionOptions = {},
  ): Promise<FactExtractionCandidate[]> {
    const sourceText = normalizeWhitespace(text);
    if (!sourceText) {
      return [];
    }

    const {
      domain = '',
      context = '',
      maxFacts = 24,
      allowedTypes = DEFAULT_EXTRACTION_FACT_TYPES,
    } = options;

    const resolvedPrompt = await resolvePrompt(
      smrtFactsExtractArticleClaimsPrompt.key,
      {
        db: this.options.db,
        tenantId: options.tenantId,
        override: options.promptOverride,
        variables: {
          allowedTypes: allowedTypes.join(', '),
          context: context || 'No additional context.',
          domain: domain || 'general',
          maxFacts,
          sourceText,
          sourceType: options.sourceType || 'article',
        },
      },
    );

    const directAi = asMessageCapableAi(this.options.ai);
    const ai = directAi || (await this.getAiClient());
    if (typeof ai.message !== 'function') {
      throw new Error(
        'AI article claim extraction requires an AI client with a message() method',
      );
    }

    const response = await ai.message(
      resolvedPrompt.text,
      promptMessageOptions(resolvedPrompt.ai),
    );
    return parseFactExtractionResponse(response).slice(0, maxFacts);
  }

  /**
   * Classify whether a claim is supported by candidate facts/evidence.
   */
  async assessClaimSupport(
    claim: string,
    candidateFacts: FactClaimSupportCandidate[],
    options: FactClaimSupportOptions = {},
  ): Promise<FactClaimSupportAssessment> {
    const normalizedClaim = normalizeWhitespace(claim);
    if (!normalizedClaim) {
      return {
        status: 'needs_review',
        matchedFactIds: [],
        matchedEvidenceIds: [],
        rationale: 'No claim text was provided.',
      };
    }

    if (candidateFacts.length === 0) {
      return {
        status: 'unsupported',
        matchedFactIds: [],
        matchedEvidenceIds: [],
        rationale: 'No candidate facts were available for comparison.',
        confidence: 1,
      };
    }

    const resolvedPrompt = await resolvePrompt(
      smrtFactsAssessClaimSupportPrompt.key,
      {
        db: this.options.db,
        tenantId: options.tenantId,
        override: options.promptOverride,
        variables: {
          claim: normalizedClaim,
          candidateFacts: JSON.stringify(candidateFacts, null, 2),
        },
      },
    );

    const directAi = asMessageCapableAi(this.options.ai);
    const ai = directAi || (await this.getAiClient());
    if (typeof ai.message !== 'function') {
      throw new Error(
        'AI claim support assessment requires an AI client with a message() method',
      );
    }

    const response = await ai.message(
      resolvedPrompt.text,
      promptMessageOptions(resolvedPrompt.ai),
    );
    return parseClaimSupportResponse(response);
  }

  /**
   * Use AI to determine whether new input should be merged with
   * or branched from an existing fact.
   */
  private async _disambiguateWithAI(
    newInput: string,
    existingFact: Fact,
    promptOverride?: PromptConfigOverrideInput,
    tenantId?: string,
  ): Promise<'merge' | 'branch'> {
    try {
      const resolvedPrompt = await resolvePrompt(smrtFactsReconcilePrompt.key, {
        db: this.options.db,
        tenantId,
        override: promptOverride,
        variables: {
          existingFact: existingFact.textRefined,
          newInput,
        },
      });
      const response = await this.ai.message(
        resolvedPrompt.text,
        promptMessageOptions(resolvedPrompt.ai),
      );
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
   * Create a branched fact from an existing predecessor.
   *
   * For 'correction' and 'contradiction' evolution types, the
   * predecessor is marked as superseded.
   *
   * @param previousFactId ID of the predecessor fact this branches from.
   * @param data Partial fact options for the new successor.
   * @param evolutionType How the successor relates to the predecessor.
   */
  async branch(
    previousFactId: string,
    data: Partial<FactOptions>,
    evolutionType: EvolutionType = 'extension',
  ): Promise<Fact> {
    // Load predecessor fact
    const predecessor = await this.get({ id: previousFactId });
    if (!predecessor) {
      throw new Error(`Predecessor fact not found: ${previousFactId}`);
    }

    // Pre-process metadata if it's an object: the persisted column is a
    // serialized string, so normalize object metadata before create.
    const { metadata, ...rest } = data;
    const createData: SmrtCreateInput<Fact> = { ...rest };
    if (metadata !== undefined) {
      createData.metadata =
        typeof metadata === 'string' ? metadata : JSON.stringify(metadata);
    }

    // Create successor fact with previousFactId and evolutionType
    const successor = await this.create({
      ...createData,
      previousFactId,
      evolutionType,
      status: data.status || 'active',
      _skipAutoEmbeddings: true,
    });

    // Generate embeddings for the successor fact
    try {
      await successor.generateEmbeddings();
    } catch {
      // Embedding generation may fail if no provider is configured
    }

    // Mark predecessor as superseded if correction or contradiction
    if (evolutionType === 'correction' || evolutionType === 'contradiction') {
      predecessor.status = 'superseded';
      await predecessor.save();
    }

    return successor;
  }

  /**
   * Walk up the evolution chain via previousFactId, returning the
   * predecessors followed by the current fact in order.
   *
   * @returns Array ordered from root (original) → current fact.
   */
  async getEvolutionChain(factId: string): Promise<Fact[]> {
    const chain: Fact[] = [];
    const visited = new Set<string>();
    let currentId: string = factId;

    // Walk up the chain via previousFactId
    while (currentId) {
      if (visited.has(currentId)) break;
      visited.add(currentId);
      const fact = await this.get({ id: currentId });
      if (!fact) {
        break;
      }
      chain.unshift(fact); // prepend to get root->current order
      currentId = fact.previousFactId;
    }

    return chain;
  }

  /**
   * Walk down successors to find the latest (highest confidence) leaf.
   * At each level, picks the successor with the highest confidence score.
   */
  async getLatestInChain(factId: string): Promise<Fact> {
    let current = await this.get({ id: factId });
    if (!current) {
      throw new Error(`Fact not found: ${factId}`);
    }

    const visited = new Set<string>();
    while (true) {
      const currentId = current.id as string;
      if (visited.has(currentId)) break;
      visited.add(currentId);

      const successors = await this.getSuccessors(currentId);
      if (successors.length === 0) {
        break;
      }

      // Pick successor with highest confidence
      let best = successors[0];
      for (let i = 1; i < successors.length; i++) {
        if (successors[i].confidence > best.confidence) {
          best = successors[i];
        }
      }
      current = best;
    }

    return current;
  }

  /**
   * Find the root of the chain via `getEvolutionChain`, then collect every
   * successor iteratively via BFS (queue-based, with a `visited` set for
   * cycle protection). Returns the full tree as a flat array in BFS
   * order — root first, then each level of successors.
   */
  async getEvolutionTree(factId: string): Promise<Fact[]> {
    // Find root
    const chain = await this.getEvolutionChain(factId);
    if (chain.length === 0) {
      return [];
    }

    const root = chain[0];
    const tree: Fact[] = [];

    // BFS to collect all descendants with cycle protection
    const visited = new Set<string>();
    const queue: Fact[] = [root];
    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) {
        continue;
      }
      const nodeId = node.id as string;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      tree.push(node);
      const successors = await this.getSuccessors(nodeId);
      queue.push(...successors);
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
      const toDate = (val: unknown): Date => {
        if (val instanceof Date) return val;
        if (val) return new Date(val as string);
        return new Date();
      };
      const latestSource = sources.reduce((latest, s) => {
        return toDate(s.extractedAt) > toDate(latest.extractedAt) ? s : latest;
      }, sources[0]);
      const latestDate = toDate(latestSource.extractedAt);
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

    const factIds = [...new Set(subjects.map((s) => s.factId))];
    const loaded = await Promise.all(factIds.map((id) => this.get({ id })));
    for (const fact of loaded) {
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
