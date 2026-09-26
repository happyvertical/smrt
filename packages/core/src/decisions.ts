/**
 * Provider-neutral decision contracts consumed by {@link SmrtObject.evaluate}.
 *
 * The SDK owns the wire protocol and provider translation. These small
 * structural contracts keep the optional SDK capability out of the ordinary
 * object cold path while still making the SMRT result and configuration public.
 */

import type {
  DecisionAnswer,
  DecisionOptions,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionValue,
} from '@happyvertical/ai';
import type { AiTokenUsage } from '@happyvertical/smrt-types';

export type {
  DecisionAnswer,
  DecisionOptions,
  DecisionQuestion,
  DecisionRequest,
  DecisionResult,
  DecisionValue,
};

export interface DecisionConfig {
  type: 'typesafe';
  apiKey?: string;
  baseUrl?: string;
  defaultModel?: string;
  threshold?: number;
  uncertaintyFallback?: {
    band: number;
  };
}

/**
 * Deliberately minimal runtime seam for the optional SDK capability. SMRT does
 * not mirror the SDK's decision protocol or validation; it only detects the
 * capability and projects the predicate result it consumes.
 */
export interface DecisionClient {
  getCapabilities: () => Promise<{
    decisions?: boolean;
  }>;
  /**
   * Keep injected clients source-compatible with the pre-routing seam.
   * `executeDecision()` narrows and validates the result before consumers use
   * it as an SDK `DecisionResult`.
   */
  decide: (request: unknown, options?: unknown) => Promise<unknown>;
}

function asDecisionRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertDecisionProbability(value: unknown, name: string): void {
  assertFiniteUnitInterval(value, name);
}

function assertDecisionDistribution(
  value: unknown,
  expectedKeys: readonly string[],
  name: string,
): void {
  const distribution = asDecisionRecord(value);
  if (
    !distribution ||
    Object.keys(distribution).length !== expectedKeys.length
  ) {
    throw new Error(`${name} must cover exactly the requested values.`);
  }
  let total = 0;
  for (const key of expectedKeys) {
    if (!Object.hasOwn(distribution, key)) {
      throw new Error(`${name} must cover exactly the requested values.`);
    }
    assertDecisionProbability(distribution[key], `${name}.${key}`);
    total += distribution[key] as number;
  }
  if (Math.abs(total - 1) > 1e-6) {
    throw new Error(`${name} must sum to 1.`);
  }
}

function sameDecisionValue(left: DecisionValue, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameDecisionValue(value, right[index]))
    );
  }
  if (left && typeof left === 'object') {
    const rightRecord = asDecisionRecord(right);
    if (!rightRecord) return false;
    const leftEntries = Object.entries(left);
    return (
      leftEntries.length === Object.keys(rightRecord).length &&
      leftEntries.every(
        ([key, value]) =>
          Object.hasOwn(rightRecord, key) &&
          sameDecisionValue(value, rightRecord[key]),
      )
    );
  }
  return false;
}

/**
 * Calls the SDK decision capability and validates the provider-neutral result.
 *
 * This is deliberately a small runtime boundary: question and response shapes
 * are the SDK contracts, imported as types, rather than copied wire protocol.
 * It is also used for injected clients, which do not receive SDK validation.
 */
export async function executeDecision(
  client: DecisionClient,
  request: DecisionRequest,
  options?: DecisionOptions,
): Promise<DecisionResult> {
  const capabilities = await client.getCapabilities();
  if (capabilities?.decisions !== true || typeof client.decide !== 'function') {
    throw new Error(
      'The configured decision client does not support typed decisions.',
    );
  }

  const rawResult = await client.decide(request, options);
  const result = asDecisionRecord(rawResult);
  if (
    !result ||
    typeof result.model !== 'string' ||
    result.model.length === 0
  ) {
    throw new Error('Decision provider returned an invalid model.');
  }
  const provenance = asDecisionRecord(result.provenance);
  if (
    !provenance ||
    typeof provenance.provider !== 'string' ||
    provenance.provider.length === 0 ||
    typeof provenance.model !== 'string' ||
    provenance.model.length === 0 ||
    provenance.model !== result.model
  ) {
    throw new Error('Decision provider returned invalid provenance.');
  }

  const answers = asDecisionRecord(result.answers);
  const questionIds = Object.keys(request.questions);
  if (
    !answers ||
    Object.keys(answers).length !== questionIds.length ||
    questionIds.some((id) => !Object.hasOwn(answers, id))
  ) {
    throw new Error('Decision provider returned no answers.');
  }
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = asDecisionRecord(answers[id]);
    if (!answer || answer.type !== question.type) {
      throw new Error(
        `Decision provider returned an invalid ${question.type} result for ${id}.`,
      );
    }
    if (question.type === 'predicate') {
      assertDecisionProbability(answer.probability, 'Decision probability');
      continue;
    }
    if (question.type === 'choice') {
      const keys = Object.keys(question.criteria);
      if (
        typeof answer.choice !== 'string' ||
        !Object.hasOwn(question.criteria, answer.choice)
      ) {
        throw new Error(
          `Decision answer ${id}.choice is not a requested option.`,
        );
      }
      assertDecisionDistribution(
        answer.probabilities,
        keys,
        `Decision answer ${id}.probabilities`,
      );
      assertDecisionProbability(
        answer.confidence,
        `Decision answer ${id}.confidence`,
      );
      continue;
    }
    if (
      typeof answer.score !== 'number' ||
      !Number.isFinite(answer.score) ||
      answer.score < 0 ||
      answer.score > question.criteria.length - 1
    ) {
      throw new Error(
        `Decision answer ${id}.score is outside the requested rubric.`,
      );
    }
    const levelKeys = question.criteria.map((_, index) => String(index));
    assertDecisionDistribution(
      answer.probabilities,
      levelKeys,
      `Decision answer ${id}.probabilities`,
    );
    assertDecisionProbability(
      answer.confidence,
      `Decision answer ${id}.confidence`,
    );
    const answerLevels = Array.isArray(answer.levels)
      ? answer.levels
      : undefined;
    if (
      !answerLevels ||
      answerLevels.length !== question.criteria.length ||
      !question.criteria.every((level, index) =>
        sameDecisionValue(level, answerLevels[index]),
      )
    ) {
      throw new Error(
        `Decision answer ${id}.levels does not match the requested rubric.`,
      );
    }
  }

  return rawResult as DecisionResult;
}

export interface EvaluationResult {
  /** The final predicate answer after the configured threshold/fallback policy. */
  result: boolean;
  /** Available only from a typed decision response. */
  probability?: number;
  /** Provider/model identity, when the underlying route makes it available. */
  provenance?: {
    provider: string;
    model: string;
  };
  /** Provider-reported token usage, when available. */
  usage?: AiTokenUsage;
  /** The route selected for this evaluation. */
  route: 'decision' | 'generative';
  /** Present only for an explicitly configured uncertainty tie-break. */
  fallback?: 'generative';
  /**
   * The decision assessment that triggered an explicit generative tie-break.
   * It is separate from the final route's metadata so callers do not mistake
   * a decision-provider probability for a generative-provider probability.
   */
  initialDecision?: {
    probability: number;
    provenance: {
      provider: string;
      model: string;
    };
    usage?: AiTokenUsage;
  };
}

export interface EvaluateOptions {
  /** Omit object state from either provider route. */
  includeData?: boolean;
  /** Maximum characters of public object state included in either route. */
  maxDataLength?: number;
  /** Per-call inclusive predicate threshold. */
  threshold?: number;
  /** Per-call opt-in uncertainty policy; `false` disables a configured fallback. */
  uncertaintyFallback?:
    | {
        band: number;
      }
    | false;
  /** Per-call decision model override. */
  model?: string;
  /** Model for an explicit generative fallback or tool route. */
  generativeModel?: string;
  /** Abort an in-flight provider request. */
  signal?: AbortSignal;
  /** Provider request deadline in milliseconds. */
  timeout?: number;
}

export function assertFiniteUnitInterval(
  value: unknown,
  name: string,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`${name} must be a finite number in [0, 1].`);
  }
}
