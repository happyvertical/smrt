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
 * Rate-card keys to try for a call, most specific first: `provider:model`,
 * `model`, then for a gateway-routed id such as Bifrost's
 * `openai/gpt-4.1-mini` each `vendor:rest` / `rest` pair, stripping one
 * leading path segment at a time (#3077).
 */
export function aiCostRateKeys(provider: string, model: string): string[] {
  const keys = [`${provider}:${model}`, model];
  let rest = model;
  let slash = rest.indexOf('/');
  while (slash > 0 && slash < rest.length - 1) {
    const vendor = rest.slice(0, slash);
    rest = rest.slice(slash + 1);
    keys.push(`${vendor}:${rest}`, rest);
    slash = rest.indexOf('/');
  }
  return [...new Set(keys)];
}

/**
 * Estimate the cost of a single AI usage event. Gateway-prefixed model ids
 * (`vendor/model`) fall back to the vendor's rate (see {@link aiCostRateKeys}).
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
  let rate: { input: number; output: number } | undefined;
  for (const key of aiCostRateKeys(provider, model)) {
    if (Object.hasOwn(rates, key)) {
      rate = rates[key];
      break;
    }
  }

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

  return priceAiTokenUsage(usage, rate);
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * The cost of reported token usage at `rate` (per 1K tokens), or
 * `undefined` when the usage reports no tokens (#5489). Prompt and
 * completion counts are priced at their own rates; usage that reports only
 * a total is priced at the higher of the two rates, so it is never free.
 */
export function priceAiTokenUsage(
  usage: AiTokenUsage | undefined,
  rate: { input: number; output: number },
): number | undefined {
  const prompt = tokenCount(usage?.promptTokens);
  const completion = tokenCount(usage?.completionTokens);
  if (prompt !== undefined || completion !== undefined) {
    return (
      ((prompt ?? 0) / 1000) * rate.input +
      ((completion ?? 0) / 1000) * rate.output
    );
  }
  const total = tokenCount(usage?.totalTokens);
  if (total === undefined) return undefined;
  return (total / 1000) * Math.max(rate.input, rate.output);
}

/**
 * The rate-card entry for a call, per 1K tokens, or `undefined` when the
 * model has no price (an uncosted call, #5005). Same key order as
 * {@link estimateAiUsageCost}; never warns.
 */
export function lookupAiCostRate(
  provider: string,
  model: string,
  customRates?: Record<string, { input: number; output: number }>,
): { input: number; output: number } | undefined {
  const rates = { ...DEFAULT_AI_COST_RATES, ...(customRates ?? {}) };
  for (const key of aiCostRateKeys(provider, model)) {
    if (Object.hasOwn(rates, key)) return rates[key];
  }
  return undefined;
}
