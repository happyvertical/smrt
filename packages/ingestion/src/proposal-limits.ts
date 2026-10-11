import type { ProposalConfiguration } from './proposal-contracts.js';

/** Validate deployment limits before any item is interpreted. */
export function assertProposalLimits(
  limits: ProposalConfiguration['limits'],
): void {
  if (
    !limits ||
    [
      'maxHandlers',
      'maxCandidates',
      'maxSuggestions',
      'maxInputBytes',
      'maxOutputBytes',
      'maxQueryLength',
      'timeoutMs',
    ].some(
      (key) =>
        !Number.isSafeInteger(limits[key as keyof typeof limits]) ||
        limits[key as keyof typeof limits] <= 0,
    ) ||
    limits.maxHandlers > 20 ||
    limits.maxCandidates > 20 ||
    limits.maxSuggestions > 20 ||
    limits.timeoutMs > 2_147_483_647
  )
    throw new Error('Invalid proposal limits');
}
