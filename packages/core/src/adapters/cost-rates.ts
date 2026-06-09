import { createLogger } from '@happyvertical/logger';
import type { AiTokenUsage } from '@happyvertical/smrt-types';

const logger = createLogger({ level: 'info' });

const missingRateWarnings = new Set<string>();

/**
 * Cost rates are expressed in USD per 1K tokens.
 *
 * These defaults are intentionally small and best-effort. Applications can
 * override them via configuration when they need stricter billing accuracy.
 * Snapshot captured on 2026-03-12 from provider pricing pages.
 */
export const DEFAULT_AI_COST_RATES: Record<
  string,
  { input: number; output: number }
> = {
  'openai:gpt-4o': { input: 0.0025, output: 0.01 },
  'openai:gpt-4o-mini': { input: 0.00015, output: 0.0006 },
  'anthropic:claude-sonnet-4.5': { input: 0.003, output: 0.015 },
  'anthropic:claude-haiku-4.5': { input: 0.001, output: 0.005 },
  'anthropic:claude-3-5-sonnet-latest': { input: 0.003, output: 0.015 },
  'anthropic:claude-3-5-haiku-latest': { input: 0.0008, output: 0.004 },
  'google:gemini-2.5-flash': { input: 0.0003, output: 0.0025 },
};

/**
 * Estimate the cost of a single AI usage event.
 */
export function estimateAiUsageCost(
  provider: string,
  model: string,
  usage?: AiTokenUsage,
  customRates?: Record<string, { input: number; output: number }>,
): number | undefined {
  if (!usage) return undefined;

  const rates = {
    ...DEFAULT_AI_COST_RATES,
    ...(customRates ?? {}),
  };

  const exactKey = `${provider}:${model}`;
  const fallbackKey = model;
  const rate = rates[exactKey] ?? rates[fallbackKey];

  if (!rate) {
    const warningKey = exactKey;
    if (!missingRateWarnings.has(warningKey)) {
      missingRateWarnings.add(warningKey);
      logger.warn(
        `[smrt] No AI usage cost rate configured for ${warningKey}. ` +
          `Cost estimation will be skipped for this model.`,
      );
    }
    return undefined;
  }

  const promptTokens = usage.promptTokens ?? 0;
  const completionTokens = usage.completionTokens ?? 0;

  return (
    (promptTokens / 1000) * rate.input + (completionTokens / 1000) * rate.output
  );
}
