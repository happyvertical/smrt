/**
 * Opt-in Learning trait configuration for {@link Agent} (#1886).
 *
 * The trait is **off by default**: an agent that does not declare
 * `static learning` behaves byte-for-byte as it does today. Declaring it — with
 * a single `static learning = true` (or a config object) — wires a
 * confidence-scored recall-before / capture-after loop into the agent
 * lifecycle, backed by {@link LearningMemory} from `@happyvertical/smrt-core`.
 *
 * @module
 */

import type { LearningMemoryConfig } from '@happyvertical/smrt-core';

/**
 * Per-agent learning configuration. All fields are optional; omitted
 * thresholds fall back to {@link LearningMemory}'s defaults (the proven
 * `praeco` values: reuse floor 0.7, success 0.9, failure 0.3).
 */
export interface AgentLearningConfig {
  /** Explicit enable flag. Defaults to `true` when a config object is given. */
  enabled?: boolean;
  /**
   * Base memory scope for this agent. Defaults to `agent/<agentType>`.
   * Recall/capture are additionally isolated by the agent instance id (owner),
   * so two tenants running the same agent class never share memory.
   */
  scope?: string;
  /** Reuse floor — recall omits memories below this confidence. Default 0.7. */
  minConfidence?: number;
  /** Confidence a memory is seeded at on a first success. Default 0.9. */
  successConfidence?: number;
  /** Target a memory decays toward on failure. Default 0.3. */
  failureConfidence?: number;
  /** Reinforcement blend weight in `[0, 1]`. Default 0.5. */
  reinforcement?: number;
  /** Optional half-life (ms) for time-based confidence decay. */
  decayHalfLifeMs?: number;
}

/**
 * The `static learning` declaration accepted on an {@link Agent} subclass:
 * `false` (default, off), `true` (on with defaults), or a config object.
 */
export type AgentLearningDeclaration = AgentLearningConfig | boolean;

/** Normalised learning settings resolved from a declaration. */
export interface ResolvedAgentLearning {
  enabled: boolean;
  scope?: string;
  /** Threshold overrides to pass to `LearningMemory` (only defined keys). */
  memoryConfig: Partial<LearningMemoryConfig>;
}

/**
 * Resolve a `static learning` declaration into normalised settings.
 *
 * Only keys explicitly set on the declaration are forwarded to
 * `LearningMemory`, so unset thresholds keep the module's defaults rather than
 * clobbering them with `undefined`.
 */
export function resolveAgentLearning(
  declaration: AgentLearningDeclaration | undefined,
): ResolvedAgentLearning {
  if (declaration === undefined || declaration === false) {
    return { enabled: false, memoryConfig: {} };
  }
  if (declaration === true) {
    return { enabled: true, memoryConfig: {} };
  }

  const memoryConfig: Partial<LearningMemoryConfig> = {};
  if (declaration.minConfidence !== undefined) {
    memoryConfig.minConfidence = declaration.minConfidence;
  }
  if (declaration.successConfidence !== undefined) {
    memoryConfig.successConfidence = declaration.successConfidence;
  }
  if (declaration.failureConfidence !== undefined) {
    memoryConfig.failureConfidence = declaration.failureConfidence;
  }
  if (declaration.reinforcement !== undefined) {
    memoryConfig.reinforcement = declaration.reinforcement;
  }
  if (declaration.decayHalfLifeMs !== undefined) {
    memoryConfig.decayHalfLifeMs = declaration.decayHalfLifeMs;
  }

  return {
    enabled: declaration.enabled ?? true,
    scope: declaration.scope,
    memoryConfig,
  };
}
