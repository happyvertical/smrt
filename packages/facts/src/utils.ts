/**
 * Utility functions for @happyvertical/smrt-facts
 */

/**
 * Calculate confidence score for a fact based on multiple signals.
 *
 * Formula (v1, simple weighted):
 *   base = 0.5
 *   + min(sourceCount/10, 0.3)          source volume boost
 *   + avgSourceCredibility * 0.2         credibility boost
 *   + max(0, 0.1 - days*0.01)           recency boost (decays over 10 days)
 *   + corroborationScore * 0.1           agreement boost
 *   = clamped to [0, 1]
 */
export function calculateConfidence(params: {
  sourceCount: number;
  avgSourceCredibility?: number;
  daysSinceLastSource?: number;
  corroborationScore?: number;
}): number {
  const {
    sourceCount,
    avgSourceCredibility = 0.5,
    daysSinceLastSource = 0,
    corroborationScore = 0,
  } = params;

  const base = 0.5;
  const sourceBoost = Math.min(sourceCount / 10, 0.3);
  const credibilityBoost = avgSourceCredibility * 0.2;
  const recencyBoost = Math.max(0, 0.1 - daysSinceLastSource * 0.01);
  const corroborationBoost = corroborationScore * 0.1;

  const raw =
    base + sourceBoost + credibilityBoost + recencyBoost + corroborationBoost;
  return Math.max(0, Math.min(1, raw));
}

/**
 * Normalize text for comparison and storage.
 * Trims whitespace, collapses multiple spaces, and lowercases.
 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}
