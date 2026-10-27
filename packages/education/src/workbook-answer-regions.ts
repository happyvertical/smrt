import type {
  WorkbookAnswerRegions,
  WorkbookQuestion,
} from './workbook-contracts.js';
/** Normalize presentation only. Never change answers, layout or verified anchors. */
export function normalizeWorkbookAnswerRegions(
  value: unknown,
  questions: readonly WorkbookQuestion[],
  sources: readonly { assetId: string; sha256?: string; pageCount: number }[],
): {
  answerRegions?: WorkbookAnswerRegions;
  answerRegionsOmission?: 'invalid';
} {
  if (value === undefined) return {};
  const invalid = { answerRegionsOmission: 'invalid' as const };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid;
  const v = value as Record<string, unknown>;
  if (
    v.version !== 1 ||
    v.provenance !== 'observed' ||
    v.coordinateSpace !== 'display-oriented' ||
    !Array.isArray(v.regions) ||
    v.regions.length > 200
  )
    return invalid;
  const seen = new Set<string>();
  const regions: WorkbookAnswerRegions['regions'] = [];
  for (const entry of v.regions) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return invalid;
    const r = entry as Record<string, unknown>;
    const source = r.source as Record<string, unknown> | undefined;
    const q = questions.find((q) => q.id === r.questionId);
    const owned = sources.find((s) => s.assetId === source?.assetId);
    if (
      !q ||
      seen.has(q.id) ||
      !owned ||
      source?.page !== 1 ||
      typeof r.observationId !== 'string' ||
      Array.from(r.observationId).some((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code === 0 || (code >= 0xd800 && code <= 0xdfff);
      }) ||
      !r.observationId.trim() ||
      r.observationId.length > 64 ||
      !Array.isArray(r.rect) ||
      r.rect.length !== 4 ||
      r.rect.some(
        (n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1,
      ) ||
      r.rect[2] <= 0 ||
      r.rect[3] <= 0 ||
      r.rect[0] + r.rect[2] > 1 ||
      r.rect[1] + r.rect[3] > 1 ||
      !q.anchors.some(
        (a) =>
          a.assetId === owned.assetId &&
          (!owned.sha256 || a.sha256 === owned.sha256) &&
          (a.page === null || a.page === 1),
      )
    )
      return invalid;
    seen.add(q.id);
    regions.push({
      questionId: q.id,
      source: { assetId: owned.assetId, page: 1 },
      rect: [...r.rect] as [number, number, number, number],
      observationId: r.observationId,
    });
  }
  return {
    answerRegions: {
      version: 1,
      provenance: 'observed',
      coordinateSpace: 'display-oriented',
      regions,
    },
  };
}
