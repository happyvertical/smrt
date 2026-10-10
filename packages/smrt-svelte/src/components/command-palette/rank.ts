/**
 * Turns provider output into the grouped, ranked rows the palette renders.
 * Pure: the controller feeds it the current local items, remote results and
 * query. No DOM, no Svelte.
 */
import { matchItem, matchText } from './match.js';
import type {
  MatchRange,
  PaletteItem,
  PaletteProvider,
  PaletteResult,
  PaletteSection,
} from './types.js';

/** Default rows per group. */
export const DEFAULT_MAX_PER_GROUP = 8;

export interface RankInput {
  /** In registration order. */
  providers: readonly PaletteProvider[];
  /** `items()` output by provider id. */
  local: Readonly<Record<string, readonly PaletteItem[]>>;
  /** `search()` output by provider id (for the current or previous query). */
  remote: Readonly<Record<string, readonly PaletteItem[]>>;
  query: string;
  maxPerGroup?: number;
}

function resultFor(
  provider: PaletteProvider,
  item: PaletteItem,
  score: number,
  titleRanges: readonly MatchRange[],
): PaletteResult {
  return {
    key: `${provider.id}:${item.id}`,
    providerId: provider.id,
    group: item.group ?? provider.label,
    item,
    score,
    titleRanges,
    selectable: !item.disabled,
  };
}

/** Providers by `order`, then registration order. */
export function orderProviders(
  providers: readonly PaletteProvider[],
): PaletteProvider[] {
  return providers
    .map((provider, index) => ({ provider, index }))
    .sort(
      (a, b) =>
        (a.provider.order ?? 0) - (b.provider.order ?? 0) || a.index - b.index,
    )
    .map(({ provider }) => provider);
}

/** Group, match and rank. A group with no rows is omitted. */
export function buildPaletteSections(input: RankInput): PaletteSection[] {
  const query = input.query.trim();
  const maxPerGroup = input.maxPerGroup ?? DEFAULT_MAX_PER_GROUP;
  const sections: Array<{
    id: string;
    label: string;
    results: PaletteResult[];
  }> = [];
  const sectionFor = (label: string) => {
    let section = sections.find((candidate) => candidate.id === label);
    if (!section) {
      section = { id: label, label, results: [] };
      sections.push(section);
    }
    return section;
  };
  const seen = new Set<string>();

  for (const provider of orderProviders(input.providers)) {
    const limit = provider.limit ?? maxPerGroup;
    const matched: PaletteResult[] = [];
    for (const item of input.local[provider.id] ?? []) {
      const match = matchItem(query, item);
      if (!match) continue;
      matched.push(
        resultFor(
          provider,
          item,
          match.score + (item.boost ?? 0),
          match.titleRanges,
        ),
      );
    }
    // Stable: equal scores keep the provider's own order.
    matched.sort((a, b) => b.score - a.score);

    const searched: PaletteResult[] = [];
    if (query.length > 0) {
      for (const item of input.remote[provider.id] ?? []) {
        searched.push(
          resultFor(
            provider,
            item,
            item.boost ?? 0,
            matchText(query, item.title)?.ranges ?? [],
          ),
        );
      }
    }

    let taken = 0;
    for (const result of [...matched, ...searched]) {
      if (taken >= limit) break;
      if (seen.has(result.key)) continue;
      seen.add(result.key);
      sectionFor(result.group).results.push(result);
      taken += 1;
    }
  }
  return sections.filter((section) => section.results.length > 0);
}

/** The rows of `sections` in display order. */
export function flattenSections(
  sections: readonly PaletteSection[],
): PaletteResult[] {
  return sections.flatMap((section) => [...section.results]);
}
