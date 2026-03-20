export interface ContentTransparencyGeneration {
  aiAssisted: boolean;
  publicPrompt: string | null;
  model: string | null;
}

export interface ContentTransparencySource {
  id: string | null;
  sourceType: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  credibility: number | null;
  extractedAt: string | null;
  metadata: Record<string, any>;
}

export interface ContentTransparencyFact {
  id: string | null;
  textRaw?: string | null;
  textRefined?: string | null;
  status?: string | null;
  domain?: string | null;
  confidence?: number | null;
  sourceCount?: number | null;
  metadata?: Record<string, any>;
  relationship?: string | null;
  linkMetadata?: Record<string, any>;
  usedInArticle?: boolean;
  sources?: ContentTransparencySource[];
}

export interface ContentTransparencyReference {
  id: string | null;
  title: string | null;
  url: string | null;
  originalUrl: string | null;
  type: string | null;
  source: string | null;
  usedFactIds: string[];
  extractedFacts: ContentTransparencyFact[];
}

export interface ContentTransparencyPublicationVersion {
  id: string | null;
  version: number | null;
  kind: string | null;
  summary: string;
  createdAt: string | null;
}

export interface ContentTransparencyVersionHistoryItem {
  id: string | null;
  version: number | null;
  kind: string | null;
  summary: string;
  createdAt: string | null;
  provenance: Record<string, any>;
}

export interface ContentTransparencyData {
  generatedAt: string | null;
  snapshotKind: 'preview' | 'published';
  contentId: string | null;
  currentContentStatus: string | null;
  publicationProfileKey: string;
  publicationVersion: ContentTransparencyPublicationVersion | null;
  generation: ContentTransparencyGeneration;
  factsUsed: ContentTransparencyFact[];
  linkedFacts: ContentTransparencyFact[];
  otherExtractedFacts: ContentTransparencyFact[];
  references: ContentTransparencyReference[];
  reviews: Record<string, any>[];
  reviewProfiles: Record<string, any>[];
  corrections: Record<string, any>[];
  versionHistory: ContentTransparencyVersionHistoryItem[];
}

function asObject(
  value: unknown,
  fallback: Record<string, any> = {},
): Record<string, any> {
  return value && typeof value === 'object' ? { ...(value as any) } : fallback;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function normalizeGeneration(value: unknown): ContentTransparencyGeneration {
  const generation = asObject(value);
  return {
    aiAssisted: Boolean(generation.aiAssisted),
    publicPrompt: asString(generation.publicPrompt),
    model: asString(generation.model),
  };
}

function normalizeFact(value: unknown): ContentTransparencyFact {
  const fact = asObject(value);
  return {
    ...fact,
    id: asString(fact.id),
    relationship: asString(fact.relationship),
    linkMetadata: asObject(fact.linkMetadata),
    usedInArticle: Boolean(fact.usedInArticle),
    sources: asArray<unknown>(fact.sources).map(normalizeSource),
  };
}

function normalizeSource(value: unknown): ContentTransparencySource {
  const source = asObject(value);
  return {
    id: asString(source.id),
    sourceType: asString(source.sourceType),
    sourceUrl: asString(source.sourceUrl),
    sourceTitle: asString(source.sourceTitle),
    credibility: asNumber(source.credibility),
    extractedAt: asString(source.extractedAt),
    metadata: asObject(source.metadata),
  };
}

function normalizeReference(value: unknown): ContentTransparencyReference {
  const reference = asObject(value);
  return {
    id: asString(reference.id),
    title: asString(reference.title),
    url: asString(reference.url),
    originalUrl: asString(reference.originalUrl),
    type: asString(reference.type),
    source: asString(reference.source),
    usedFactIds: asArray<string>(reference.usedFactIds).filter(Boolean),
    extractedFacts: asArray<unknown>(reference.extractedFacts).map(
      normalizeFact,
    ),
  };
}

function normalizePublicationVersion(
  value: unknown,
): ContentTransparencyPublicationVersion | null {
  const publicationVersion = asObject(value);
  if (!publicationVersion.id && publicationVersion.version === undefined) {
    return null;
  }

  return {
    id: asString(publicationVersion.id),
    version: asNumber(publicationVersion.version),
    kind: asString(publicationVersion.kind),
    summary:
      typeof publicationVersion.summary === 'string'
        ? publicationVersion.summary
        : '',
    createdAt: asString(publicationVersion.createdAt),
  };
}

function normalizeVersionHistoryItem(
  value: unknown,
): ContentTransparencyVersionHistoryItem {
  const version = asObject(value);
  return {
    id: asString(version.id),
    version: asNumber(version.version),
    kind: asString(version.kind),
    summary: typeof version.summary === 'string' ? version.summary : '',
    createdAt: asString(version.createdAt),
    provenance: asObject(version.provenance),
  };
}

function dedupeFacts(facts: ContentTransparencyFact[]) {
  const byKey = new Map<string, ContentTransparencyFact>();

  for (const fact of facts) {
    const key =
      fact.id ||
      fact.textRefined ||
      fact.textRaw ||
      JSON.stringify(fact.metadata || {});
    if (!key) {
      continue;
    }

    byKey.set(key, fact);
  }

  return [...byKey.values()];
}

export function normalizeContentTransparency(
  value: unknown,
  defaults: Partial<ContentTransparencyData> = {},
): ContentTransparencyData {
  const snapshot = asObject(value);
  const references = asArray<unknown>(snapshot.references).map(
    normalizeReference,
  );
  const linkedFacts = asArray<unknown>(snapshot.linkedFacts).map(normalizeFact);
  const factsUsed =
    asArray<unknown>(snapshot.factsUsed).length > 0
      ? asArray<unknown>(snapshot.factsUsed).map(normalizeFact)
      : linkedFacts.filter((fact) => fact.usedInArticle);
  const otherExtractedFacts =
    asArray<unknown>(snapshot.otherExtractedFacts).length > 0
      ? asArray<unknown>(snapshot.otherExtractedFacts).map(normalizeFact)
      : dedupeFacts(
          references.flatMap((reference) =>
            reference.extractedFacts.filter((fact) => !fact.usedInArticle),
          ),
        );

  return {
    generatedAt: asString(snapshot.generatedAt) ?? defaults.generatedAt ?? null,
    snapshotKind:
      snapshot.snapshotKind === 'published'
        ? 'published'
        : defaults.snapshotKind || 'preview',
    contentId: asString(snapshot.contentId) ?? defaults.contentId ?? null,
    currentContentStatus:
      asString(snapshot.currentContentStatus) ??
      defaults.currentContentStatus ??
      null,
    publicationProfileKey:
      asString(snapshot.publicationProfileKey) ??
      asString(snapshot.publicationReviewProfileKey) ??
      defaults.publicationProfileKey ??
      'publication',
    publicationVersion:
      normalizePublicationVersion(snapshot.publicationVersion) ??
      defaults.publicationVersion ??
      null,
    generation: normalizeGeneration(
      snapshot.generation ?? defaults.generation ?? {},
    ),
    factsUsed,
    linkedFacts,
    otherExtractedFacts,
    references,
    reviews: asArray<Record<string, any>>(snapshot.reviews),
    reviewProfiles: asArray<Record<string, any>>(snapshot.reviewProfiles),
    corrections: asArray<Record<string, any>>(snapshot.corrections),
    versionHistory: asArray<unknown>(snapshot.versionHistory).map(
      normalizeVersionHistoryItem,
    ),
  };
}
