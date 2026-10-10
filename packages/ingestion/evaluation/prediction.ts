import { ATTACH, CREATE } from '../reference/handlers.js';
import type {
  GeneratedSuggestion,
  GenerationOutput,
} from '../src/proposal-dto.js';
import { type CaseIdentityMap, logicalIdentity } from './identity-map.js';

export interface ScoredOffer {
  kind: 'draft' | 'attachment' | 'unknown';
  handler: string;
  fields: Record<string, unknown>;
  target?: string;
}
/** No labels/oracle enter this projection. Preserve all offers, including those
 * requiring further review; eligibility for authenticated execution is separate.
 */
export function projectGeneration(
  id: string,
  generation: GenerationOutput,
  mapping: CaseIdentityMap,
  modelInvoked: boolean,
  explicitModelAbstention = false,
) {
  if (generation.outcome === 'provider_error')
    return {
      id,
      status: 'provider_failure',
      modelInvoked,
      actions: [],
      abstained: false,
    };
  if (generation.omittedSuggestions > 0)
    return {
      id,
      status: 'malformed',
      modelInvoked,
      actions: [],
      abstained: false,
    };
  const actions = generation.suggestions.map((suggestion) =>
    projectSuggestion(suggestion, mapping),
  );
  const abstained =
    modelInvoked &&
    explicitModelAbstention &&
    actions.length === 0 &&
    ['no_action', 'unknown', 'ambiguous'].includes(generation.outcome);
  // Empty unresolved proposals are not a successful no-action disposition.
  if (!actions.length && !abstained)
    return {
      id,
      status: 'malformed',
      modelInvoked,
      actions: [],
      abstained: false,
    };
  return {
    id,
    status: 'completed',
    modelInvoked,
    actions,
    abstained,
    providerCompletion:
      generation.warnings?.includes('generation_completion_unknown') === false
        ? 'declared_complete'
        : 'unknown',
    warnings: generation.warnings ?? [],
    automaticActionEligible: false,
  };
}

export function projectSuggestion(
  suggestion: GeneratedSuggestion,
  mapping: CaseIdentityMap,
): ScoredOffer {
  const fields = structuredClone(suggestion.args);
  if (suggestion.handlerId === CREATE)
    return { kind: 'draft', handler: suggestion.handlerId, fields };
  if (suggestion.handlerId === ATTACH) {
    if (
      typeof fields.contentId !== 'string' ||
      typeof fields.evidenceId !== 'string'
    )
      return { kind: 'attachment', handler: suggestion.handlerId, fields };
    // Unknown IDs remain explicit unmatched values. Do not convert a whole
    // incorrect offer into abstention or suppress its false-positive count.
    const inverse = (value: string) => {
      try {
        return logicalIdentity(mapping, value);
      } catch {
        return `unmapped:${value}`;
      }
    };
    fields.contentId = inverse(fields.contentId);
    fields.evidenceId = inverse(fields.evidenceId);
    return {
      kind: 'attachment',
      handler: suggestion.handlerId,
      fields,
      target: String(fields.contentId),
    };
  }
  return { kind: 'unknown', handler: suggestion.handlerId, fields };
}
