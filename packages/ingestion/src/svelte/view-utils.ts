import type { EvidenceLocation } from '../extraction-types.js';
import type {
  GeneratedSuggestion,
  ProposalCatalogEntry,
} from '../proposal-dto.js';

/**
 * Initial arguments for a reviewer-chosen handler: a same-handler suggestion's
 * arguments when one exists, otherwise evidence references for a single
 * original. Nothing else is invented; the handler's preview validates them.
 */
export function draftArguments(
  entry: ProposalCatalogEntry,
  suggestions: readonly GeneratedSuggestion[],
  evidenceIds: readonly string[],
): Record<string, unknown> {
  const suggestion = suggestions.find(
    (candidate) =>
      candidate.handlerId === entry.id &&
      candidate.handlerVersion === entry.version,
  );
  // Plain JSON arguments; reactive state proxies cannot be structured-cloned.
  const args: Record<string, unknown> = suggestion
    ? (JSON.parse(JSON.stringify(suggestion.args)) as Record<string, unknown>)
    : {};
  for (const [field, reference] of Object.entries(entry.references))
    if (
      reference.kind === 'evidence' &&
      !Object.hasOwn(args, field) &&
      evidenceIds.length === 1
    )
      args[field] = evidenceIds[0];
  return args;
}
/** Required schema properties the draft does not supply yet. */
export function missingArguments(
  entry: ProposalCatalogEntry,
  args: Record<string, unknown>,
): string[] {
  const required = entry.argsSchema.required;
  return Array.isArray(required)
    ? required.filter(
        (field): field is string =>
          typeof field === 'string' && !Object.hasOwn(args, field),
      )
    : [];
}
/** Only host-authorized same-origin HTTP URLs may reach original media elements. */
export function evidenceUrl(
  value?: string,
  origin?: string,
): string | undefined {
  if (!value) return undefined;
  const base =
    origin ??
    (typeof window === 'undefined' ? undefined : window.location.origin);
  if (!base)
    return value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.includes('\\')
      ? value
      : undefined;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === base
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
export function argumentsObject(value: string): Record<string, unknown> {
  const result: unknown = JSON.parse(value);
  if (!result || typeof result !== 'object' || Array.isArray(result))
    throw new Error('Invalid arguments');
  return result as Record<string, unknown>;
}
/** Required top-level handler arguments missing from a JSON draft; unparsable drafts report none. */
export function missingRequired(
  schema: Record<string, unknown>,
  draft: string,
): string[] {
  if (!Array.isArray(schema.required)) return [];
  try {
    const values = argumentsObject(draft);
    return schema.required.filter(
      (name): name is string =>
        typeof name === 'string' && !Object.hasOwn(values, name),
    );
  } catch {
    return [];
  }
}
export function pageGroups(value: string): number[][] {
  const result: unknown = JSON.parse(value);
  if (
    !Array.isArray(result) ||
    !result.length ||
    !result.every(
      (group) =>
        Array.isArray(group) &&
        group.length &&
        group.every((page) => Number.isSafeInteger(page) && page > 0),
    )
  )
    throw new Error('Invalid groups');
  return result;
}

/** Project useful extraction content; never present internal configuration/provenance JSON. */
export function extractedContent(output: Record<string, unknown>): Array<{
  evidenceId: string;
  text: string;
  location?: EvidenceLocation;
  confidence?: number;
}> {
  const content: Array<{
    evidenceId: string;
    text: string;
    location?: EvidenceLocation;
    confidence?: number;
  }> = [];
  if (!Array.isArray(output.results)) return content;
  for (const result of output.results) {
    if (
      !result ||
      typeof result !== 'object' ||
      !result.evidence ||
      typeof result.evidence.id !== 'string' ||
      !Array.isArray(result.segments)
    )
      continue;
    for (const segment of result.segments) {
      if (
        !segment ||
        typeof segment !== 'object' ||
        typeof segment.text !== 'string'
      )
        continue;
      const value = segment.location;
      let location: EvidenceLocation | undefined;
      if (value?.kind === 'source') location = { kind: 'source' };
      if (
        value?.kind === 'page' &&
        Number.isSafeInteger(value.page) &&
        value.page > 0
      )
        location = { kind: 'page', page: value.page };
      if (
        value?.kind === 'pages' &&
        Number.isSafeInteger(value.startPage) &&
        value.startPage > 0 &&
        Number.isSafeInteger(value.endPage) &&
        value.endPage >= value.startPage
      )
        location = {
          kind: 'pages',
          startPage: value.startPage,
          endPage: value.endPage,
        };
      if (
        value?.kind === 'time' &&
        Number.isFinite(value.startMs) &&
        value.startMs >= 0 &&
        Number.isFinite(value.endMs) &&
        value.endMs >= value.startMs
      )
        location = { kind: 'time', startMs: value.startMs, endMs: value.endMs };
      const confidence =
        segment.confidence?.scale === '0-1' &&
        typeof segment.confidence.value === 'number' &&
        Number.isFinite(segment.confidence.value) &&
        segment.confidence.value >= 0 &&
        segment.confidence.value <= 1
          ? segment.confidence.value
          : undefined;
      content.push({
        evidenceId: result.evidence.id,
        text: segment.text,
        ...(location ? { location } : {}),
        ...(confidence !== undefined ? { confidence } : {}),
      });
    }
  }
  return content;
}
