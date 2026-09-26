/**
 * Provider-neutral decision contracts consumed by {@link SmrtObject.evaluate}.
 *
 * The SDK owns the wire protocol and provider translation. These small
 * structural contracts keep the optional SDK capability out of the ordinary
 * object cold path while still making the SMRT result and configuration public.
 */

import type { AiTokenUsage } from '@happyvertical/smrt-types';

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
  decide: (request: unknown, options?: unknown) => Promise<unknown>;
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
