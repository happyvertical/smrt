import { SmrtError } from '@happyvertical/smrt-core/smrt-error';
import type {
  InferenceConfigIssue,
  InferenceSubstitution,
  InferenceSubstitutionReason,
} from './types.js';

/** An `inference` config block that cannot bind (`INFERENCE_CONFIG_INVALID`). */
export class InferenceConfigError extends SmrtError {
  readonly issues: InferenceConfigIssue[];

  constructor(issues: InferenceConfigIssue[]) {
    super(
      `Invalid inference config: ${issues.map((issue) => issue.message).join('; ')}`,
      'INFERENCE_CONFIG_INVALID',
      'configuration',
      { issues },
    );
    this.issues = issues;
  }
}

/**
 * A chain call that never produced a complete answer
 * (`INFERENCE_EXHAUSTED`): every candidate failed, or one streamed text and
 * then failed without `allowPartial`. `cause` is the last provider error.
 */
export class InferenceExhaustedError extends SmrtError {
  /** The failure that ended the walk. */
  readonly reason: InferenceSubstitutionReason;
  /** The full fallback trail, ending with `to: null`. */
  readonly substitutions: InferenceSubstitution[];
  /** Text already streamed to the caller, for a `partial` ending. */
  readonly partialText?: string;

  constructor(input: {
    reason: InferenceSubstitutionReason;
    substitutions: InferenceSubstitution[];
    tierRequested: string;
    partialText?: string;
    cause?: unknown;
  }) {
    const last = input.substitutions.at(-1);
    super(
      input.reason === 'partial'
        ? `Inference candidate ${last?.from ?? 'unknown'} failed after streaming; no other candidate may extend its reply.`
        : `No inference candidate answered tier "${input.tierRequested}" (last failure: ${input.reason}).`,
      'INFERENCE_EXHAUSTED',
      'ai',
      {
        reason: input.reason,
        tierRequested: input.tierRequested,
        substitutions: input.substitutions,
      },
      input.cause instanceof Error ? input.cause : undefined,
    );
    this.reason = input.reason;
    this.substitutions = input.substitutions;
    if (input.partialText !== undefined) this.partialText = input.partialText;
  }
}

/** The result shape {@link InferenceFusionError} carries (fusion.ts). */
interface FailedFusionRun {
  runId: string;
  fusionKey: string;
  seats: Array<{
    name: string;
    status: string;
    failure?: { reason: string; message: string };
  }>;
}

/**
 * A fusion run that produced no answer (`INFERENCE_FUSION_FAILED`, #4753):
 * every seat that ran died, or the run stopped on an unexpected error. The
 * run is recorded as `failed`; `result` holds every seat's outcome.
 */
export class InferenceFusionError extends SmrtError {
  readonly result: FailedFusionRun;

  constructor(result: FailedFusionRun, cause?: unknown) {
    const failures = result.seats
      .filter((seat) => seat.failure)
      .map((seat) => `${seat.name}: ${seat.failure?.reason}`);
    super(
      `Fusion "${result.fusionKey}" produced no answer (run ${result.runId}${
        failures.length > 0 ? `; ${failures.join(', ')}` : ''
      }).`,
      'INFERENCE_FUSION_FAILED',
      'ai',
      { runId: result.runId, fusionKey: result.fusionKey, failures },
      cause instanceof Error ? cause : undefined,
    );
    this.result = result;
  }
}
