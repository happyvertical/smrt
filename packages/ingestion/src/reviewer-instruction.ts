/** Shared server-side projection of the persisted reviewer instruction record. */
import { intakeBindingDigest as digest } from './execution.js';
import type { ReviewerInstruction } from './review-dto.js';

/** Reviewer instruction text ceiling; the prompt input budget still applies. */
export const REVIEWER_INSTRUCTION_MAX_LENGTH = 4000;

/**
 * Instruction text is empty, whitespace-only or longer than the ceiling. Hosts
 * surface it inline as a validation result, never as an access denial.
 */
export class ReviewerInstructionInvalidError extends Error {
  constructor() {
    super('Invalid reviewer instruction');
    this.name = 'ReviewerInstructionInvalidError';
  }
}

/**
 * The anchor generation is superseded or a reinterpretation is still in flight.
 * Hosts surface it as a refresh-and-retry signal, never as an access denial.
 */
export class ReviewerInstructionStaleError extends Error {
  constructor() {
    super('Stale reviewer instruction');
    this.name = 'ReviewerInstructionStaleError';
  }
}

/** Verify the record's own digest and project its browser-safe shape. */
export function reviewerInstructionView(value: unknown): ReviewerInstruction {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Reviewer instruction integrity');
  const { digest: stored, ...body } = parsed as Record<string, unknown>;
  if (
    body.kind !== 'reviewer_instruction' ||
    typeof stored !== 'string' ||
    typeof body.id !== 'string' ||
    typeof body.text !== 'string' ||
    typeof body.actorId !== 'string' ||
    typeof body.recordedAt !== 'string' ||
    (body.supersedesId !== null && typeof body.supersedesId !== 'string') ||
    digest(body) !== stored
  )
    throw new Error('Reviewer instruction integrity');
  return {
    id: body.id,
    text: body.text,
    actorId: body.actorId,
    recordedAt: body.recordedAt,
    supersedesId: body.supersedesId,
    digest: stored,
  };
}
