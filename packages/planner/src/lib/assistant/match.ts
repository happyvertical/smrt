import type { LibraryCookbook } from '../library/types.ts';
import type { Recipe } from '../recipes/types.ts';

/**
 * Keyword matching: what the person typed, mapped to the cookbooks and recipes
 * it probably means. Deterministic, local and fast. The model still decides
 * what to do; matches only focus its prompt and back up a cookbook offer.
 */

export type MatchKind = 'recipe' | 'cookbook' | 'theme';
export type Confidence = 'strong' | 'weak';

export interface Match {
  kind: MatchKind;
  id: string;
  score: number;
  confidence: Confidence;
  /** The terms found in the text, as written in the index. */
  terms: string[];
}

type Tier = 'name' | 'synonym' | 'keyword';

interface Term {
  /** Normalised, space-separated words. */
  text: string;
  tier: Tier;
  /** Weak terms count towards the score but never make a match strong. */
  weak: boolean;
  words: number;
}

interface Entry {
  kind: MatchKind;
  id: string;
  terms: Term[];
}

export interface MatchIndex {
  entries: Entry[];
}

const TIER_WEIGHT: Record<Tier, number> = { name: 10, synonym: 6, keyword: 4 };
/** A phrase says more than one of its words does. */
const PHRASE_FACTOR = 1.5;

/** Too common to point at anything, in labels and ids. */
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'to',
  'in',
  'on',
  'or',
  'general',
  'simple',
]);

/**
 * Words that fit more than one trade or recipe. They add to a score but a
 * match made only of them stays weak, so they never trigger a cookbook offer.
 */
const WEAK_WORDS = [
  'car',
  'vehicle',
  'metal',
  'steel',
  'gates',
  'studio',
  'classes',
  'members',
  'shop',
  'order',
  'item',
  'material',
  'customer',
  'sales',
  'stock',
  'schedule',
  'terms',
];

/** Fold the way the text is folded, so index and message always agree. */
function foldWord(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.endsWith('sses')) return word.slice(0, -2);
  if (/(us|ss|is)$/.test(word)) return word;
  if (word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** Lowercase, strip accents and punctuation, fold plurals and possessives. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map(foldWord)
    .join(' ');
}

const WEAK = new Set(WEAK_WORDS.map(normalize));

/**
 * Extra words for the recipes, where the synonyms in the catalog are thin.
 * Keyed by recipe id; a recipe without an entry still matches its label,
 * id and synonyms.
 */
export const RECIPE_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  'commerce.customers': ['customer', 'client', 'contacts', 'patrons'],
  'commerce.purchases': [
    'purchase',
    'buy supplies',
    'reorder',
    'order from suppliers',
  ],
  'commerce.sales': ['sell', 'sale', 'sales order', 'point of sale'],
  'commerce.vendors': ['vendor', 'supplier', 'who we buy from'],
  'inventory.stock': [
    'inventory',
    'track stock',
    'stock levels',
    'warehouse',
    'count stock',
  ],
  'products.simple': ['product', 'price list', 'menu', 'things we sell'],
  'products.clothing': ['clothes', 'shirts', 'fashion', 'sizes and colours'],
  'products.ingredients': [
    'ingredient',
    'recipe',
    'raw material',
    'flour',
    'components',
  ],
  'commerce.estimates': [
    'estimate',
    'quote',
    'quotes for customers',
    'price quote',
    'bid',
  ],
  'commerce.wholesale': ['wholesale', 'bulk', 'trade customers', 'resellers'],
  'commerce.invoicing': [
    'invoice',
    'send invoices',
    'bill customers',
    'get paid',
    'receipts',
  ],
  'commerce.fulfillment': ['ship', 'shipping', 'courier', 'parcels', 'deliver'],
  'commerce.agreements': ['contract', 'agreement', 'sign contracts'],
  'commerce.leases': ['lease', 'rent out', 'equipment hire'],
  'commerce.licenses': ['licence', 'licence sales', 'software licenses'],
  'ledgers.bookkeeping': [
    'books',
    'keep the books',
    'bookkeeper',
    'accountant',
    'expenses',
  ],
  'projects.tracker': ['project', 'task', 'to do list', 'bug', 'ticket'],
  'events.calendar': [
    'appointment',
    'schedule appointments',
    'event',
    'meeting',
    'reservation',
  ],
  'sales.pipeline': [
    'lead',
    'pipeline',
    'prospect',
    'follow up',
    'sales funnel',
  ],
};

function makeTerm(raw: string, tier: Tier): Term | null {
  const text = normalize(raw);
  if (!text) return null;
  const words = text.split(' ');
  if (words.length === 1 && STOPWORDS.has(text)) return null;
  const weak = tier !== 'name' && words.every((w) => WEAK.has(w));
  return { text, tier, weak, words: words.length };
}

function collect(entry: Entry, raw: string, tier: Tier): void {
  const term = makeTerm(raw, tier);
  if (!term) return;
  const existing = entry.terms.find((t) => t.text === term.text);
  if (existing) {
    if (TIER_WEIGHT[term.tier] > TIER_WEIGHT[existing.tier]) {
      existing.tier = term.tier;
      existing.weak = term.weak;
    }
    return;
  }
  entry.terms.push(term);
}

function wordsOf(raw: string): string[] {
  return normalize(raw)
    .split(' ')
    .filter((w) => w && !STOPWORDS.has(w));
}

/** Words that mean the person is talking about how the app looks. */
export const THEME_KEYWORDS: readonly string[] = [
  'theme',
  'colour',
  'color',
  'colour scheme',
  'dark mode',
  'light mode',
  'brand',
  'branding',
  'style',
  'warmer',
  'cooler',
  'font',
];

/** Build the index for a set of recipes and cookbooks (and theming, when asked). */
export function buildMatchIndex(
  recipes: readonly Pick<Recipe, 'id' | 'label' | 'synonyms'>[],
  cookbooks: readonly (Pick<LibraryCookbook, 'id' | 'name'> &
    Partial<Pick<LibraryCookbook, 'keywords'>>)[] = [],
  options: { theme?: boolean } = {},
): MatchIndex {
  const entries: Entry[] = [];
  for (const recipe of recipes) {
    const entry: Entry = { kind: 'recipe', id: recipe.id, terms: [] };
    collect(entry, recipe.label, 'name');
    // The last id segment (`pipeline` of `sales.pipeline`), not the package.
    const last = recipe.id.split('.').pop() ?? '';
    collect(entry, last.replace(/[-_]/g, ' '), 'name');
    for (const word of wordsOf(recipe.label)) collect(entry, word, 'synonym');
    for (const synonym of recipe.synonyms) collect(entry, synonym, 'synonym');
    for (const extra of RECIPE_KEYWORDS[recipe.id] ?? []) {
      collect(entry, extra, 'keyword');
    }
    entries.push(entry);
  }
  for (const cookbook of cookbooks) {
    const entry: Entry = { kind: 'cookbook', id: cookbook.id, terms: [] };
    collect(entry, cookbook.name, 'name');
    collect(entry, cookbook.id.replace(/[-_]/g, ' '), 'name');
    for (const keyword of cookbook.keywords ?? []) {
      collect(entry, keyword, 'keyword');
    }
    entries.push(entry);
  }
  if (options.theme) {
    const entry: Entry = { kind: 'theme', id: 'theme', terms: [] };
    for (const word of THEME_KEYWORDS) collect(entry, word, 'keyword');
    entries.push(entry);
  }
  return { entries };
}

/** Distinct match terms an item has; the coverage tests count these. */
export function termsOf(index: MatchIndex, kind: MatchKind, id: string) {
  return (
    index.entries.find((e) => e.kind === kind && e.id === id)?.terms ?? []
  ).map((t) => t.text);
}

/** Ranked matches for a message, best first. Empty when nothing matches. */
export function matchText(index: MatchIndex, text: string): Match[] {
  const haystack = ` ${normalize(text)} `;
  const out: Match[] = [];
  for (const entry of index.entries) {
    let score = 0;
    let strong = false;
    const found: string[] = [];
    for (const term of entry.terms) {
      if (!haystack.includes(` ${term.text} `)) continue;
      found.push(term.text);
      score +=
        TIER_WEIGHT[term.tier] *
        (term.words > 1 ? PHRASE_FACTOR : 1) *
        (term.weak ? 0.5 : 1);
      if (!term.weak) strong ||= true;
    }
    if (!found.length) continue;
    out.push({
      kind: entry.kind,
      id: entry.id,
      score,
      confidence: strong ? 'strong' : 'weak',
      terms: found,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
