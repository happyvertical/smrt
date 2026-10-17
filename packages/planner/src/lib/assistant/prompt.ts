import type { LibraryCookbook } from '../library/types.ts';
import type { Recipe } from '../recipes/types.ts';
import type { AppSettings } from '../settings/app-settings.ts';
import { describeTheme, type ThemeSetting } from '../theme/theme.ts';
import type { Match } from './match.ts';

/** The slice of a cookbook the model needs to pick one. */
export type CookbookBrief = Pick<LibraryCookbook, 'id' | 'name' | 'summary'> &
  Partial<Pick<LibraryCookbook, 'keywords'>>;

/** Most matched items given full lines; the rest stay in the compact list. */
const MAX_FOCUSED_RECIPES = 5;
const MAX_FOCUSED_COOKBOOKS = 2;

/**
 * Worked examples: small models copy the shape of a good answer far better
 * than they follow rules. Each one is used only when the ids it names are in
 * this prompt, so an example never points the model at something missing.
 * The replies are deliberately different from each other so none becomes a
 * stock phrase.
 */
interface PromptExample {
  says: string;
  answer: Record<string, unknown>;
  recipes?: string[];
  cookbook?: string;
  settings?: boolean;
  theme?: boolean;
  /** The report source the example names. */
  report?: string;
}

const EXAMPLES: readonly PromptExample[] = [
  {
    says: 'I run a bakery',
    cookbook: 'bakery',
    answer: {
      reply: 'The Bakery cookbook covers that.',
      add: [],
      remove: [],
      cookbook: 'bakery',
    },
  },
  {
    says: 'I need to send invoices',
    recipes: ['commerce.invoicing'],
    answer: {
      reply: 'Added invoicing for billing customers.',
      add: ['commerce.invoicing'],
      remove: [],
    },
  },
  {
    says: "we don't need the pipeline",
    recipes: ['sales.pipeline'],
    answer: {
      reply: 'Removed leads and pipeline.',
      add: [],
      remove: ['sales.pipeline'],
    },
  },
  {
    says: "we're in Canada, 13% tax",
    settings: true,
    answer: {
      reply: 'Set to Canadian dollars and 13% tax.',
      add: [],
      remove: [],
      settings: { currency: 'CAD', taxRate: 13 },
    },
  },
  {
    says: 'make it warmer',
    theme: true,
    answer: {
      reply: 'Gave it a warm amber brand colour.',
      add: [],
      remove: [],
      theme: { primary: '#d97706' },
    },
  },
  {
    says: 'give me a summary of all sales last month',
    report: 'invoices',
    answer: {
      reply: 'Here is a summary of last month.',
      add: [],
      remove: [],
      report: { source: 'invoices', period: 'last_month' },
    },
  },
  {
    says: 'hello',
    answer: { reply: 'Hi. What kind of business is it?', add: [], remove: [] },
  },
];

function examples(
  recipeIds: ReadonlySet<string>,
  cookbookIds: ReadonlySet<string>,
  withSettings: boolean,
  withTheme: boolean,
  reportIds: ReadonlySet<string> = new Set(),
): string[] {
  return EXAMPLES.filter(
    (e) =>
      (e.recipes ?? []).every((id) => recipeIds.has(id)) &&
      (!e.cookbook || cookbookIds.has(e.cookbook)) &&
      (!e.settings || withSettings) &&
      (!e.theme || withTheme) &&
      (!e.report || reportIds.has(e.report)),
  ).map((e) => `"${e.says}" -> ${JSON.stringify(e.answer)}`);
}

/** The recipe a request for a report or a summary of the app's data needs. */
export const REPORTS_RECIPE = 'reports.runtime';

/** A runtime report source as the prompt names it. */
export interface ReportSourceBrief {
  id: string;
  label: string;
}

/** Tax is shown as a percent, the unit the person says it in. */
export function formatTaxPercent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(4))}%`;
}

/**
 * The system prompt: what the assistant is, how little to say, the recipes it
 * may use, the cookbooks it may offer, the current settings and which recipes
 * are on now. Short on purpose, for a 1-2B model.
 *
 * With `matches` (keyword matches for the person's message, possibly none) the
 * prompt is focused: full lines (id, label, summary, synonyms) only for the
 * matched and currently-on recipes and cookbooks, a compact list of the rest,
 * and a hint line naming what looks relevant. Without it every item gets a
 * full line. The response schema lists every id either way.
 */
export function buildSystemPrompt(
  recipes: readonly Recipe[],
  current: readonly string[],
  cookbooks: readonly CookbookBrief[] = [],
  settings?: AppSettings,
  matches?: readonly Match[],
  themeInfo?: { current: ThemeSetting | undefined },
  menu: readonly { id: string; label: string }[] = [],
  reports: readonly ReportSourceBrief[] = [],
): string {
  const focused = matches !== undefined;
  const matchedRecipes = (matches ?? [])
    .filter((m) => m.kind === 'recipe')
    .slice(0, MAX_FOCUSED_RECIPES)
    .map((m) => m.id);
  const matchedCookbooks = (matches ?? [])
    .filter((m) => m.kind === 'cookbook')
    .slice(0, MAX_FOCUSED_COOKBOOKS)
    .map((m) => m.id);
  const fullRecipe = new Set([...matchedRecipes, ...current]);
  const fullCookbook = new Set(matchedCookbooks);
  const recipeLine = (recipe: Recipe) => {
    const also = recipe.synonyms.length
      ? ` Also called: ${recipe.synonyms.join(', ')}.`
      : '';
    return `- ${recipe.id}: ${recipe.label}. ${recipe.summary}${also}`;
  };
  const out = [
    'You help assemble a small business app. Reply as JSON.',
    '"reply": answer what they just said in one sentence of 12 words or fewer. No greeting; never repeat a reply.',
    '"add"/"remove": recipe ids, only what they ask to add or drop; else []. Dependencies are automatic.',
  ];
  if (cookbooks.length) {
    out.push('"cookbook": id only if their business clearly fits, else null.');
  }
  if (settings) {
    out.push(
      '"settings": only what they state: currency (ISO), taxRate (percent), paymentTerms, pricesIncludeTax (true when their prices include tax), taxRounding (line|document); else omit, and do not mention them otherwise.',
    );
  }
  if (themeInfo) {
    out.push(
      '"theme": only if they ask for a look: {"preset": material|glass|studio|smrt|happyvertical} or {"primary": "#rrggbb"}, optional "colorScheme": light|dark, "borderRadius": none|sm|md|lg|xl|full, "density": comfortable|touch, "contrast": auto|standard|more; else omit.',
    );
  }
  if (menu.length) {
    out.push(
      '"open": a menu section id only when they ask to see or go to one, else null.',
    );
  }
  if (reports.length) {
    out.push(
      '"report": only when they ask for a report, summary or totals of their records: {"source": a report source id, optional "measures": [{"fn": count|sum|avg|min|max, "field"}], "groupBy": field, "bucket": day|week|month|quarter|year, "period": today|yesterday|this_week|last_week|this_month|last_month|this_quarter|last_quarter|this_year|last_year|all_time, "filters": [{"field", "op": eq|ne|gt|gte|lt|lte|contains, "value"}]}; a summary needs only source and period. Else omit.',
    );
  }
  out.push(
    `"reply" never claims anything beyond add, remove, cookbook, settings, theme, open${reports.length ? ' and report' : ''}: the app reports what changed.`,
  );
  if (reports.length) {
    out.push(
      `A report or summary of their data is "report", never a recipe to add or a section to open: the app turns on ${REPORTS_RECIPE} (Reports), builds the report, shows a preview and saves it only when they approve.`,
    );
  } else if (recipes.some((r) => r.id === REPORTS_RECIPE)) {
    out.push(
      `A report or summary of their data needs ${REPORTS_RECIPE} (Reports): add it, and open only its section, never another. You cannot build the report itself here.`,
    );
  }
  const shown = examples(
    new Set(recipes.map((r) => r.id)),
    new Set(cookbooks.map((c) => c.id)),
    Boolean(settings),
    Boolean(themeInfo),
    new Set(reports.map((r) => r.id)),
  );
  if (shown.length) out.push('', 'Examples:', ...shown);
  const themeHint =
    !!themeInfo && (matches ?? []).some((m) => m.kind === 'theme');
  if (matchedRecipes.length || matchedCookbooks.length || themeHint) {
    const parts: string[] = [];
    if (themeHint) parts.push('theming (use "theme")');
    if (matchedCookbooks.length) {
      parts.push(`cookbook ${matchedCookbooks.join(', ')}`);
    }
    if (matchedRecipes.length) {
      parts.push(`recipes ${matchedRecipes.join(', ')}`);
    }
    out.push('', `Looks relevant: ${parts.join('; ')}.`);
  }
  const cookbookLine = (c: CookbookBrief) =>
    `- ${c.id}: ${c.name}. ${c.summary}`;
  const compact = (items: string[]) => items.join(', ');
  const fullRecipes = recipes.filter((r) => !focused || fullRecipe.has(r.id));
  const otherRecipes = focused
    ? recipes.filter((r) => !fullRecipe.has(r.id))
    : [];
  out.push('');
  if (fullRecipes.length) out.push('Recipes:', ...fullRecipes.map(recipeLine));
  if (otherRecipes.length) {
    out.push(
      `Other recipes: ${compact(otherRecipes.map((r) => `${r.id} (${r.label})`))}.`,
    );
  }
  if (cookbooks.length) {
    const fullBooks = cookbooks.filter(
      (c) => !focused || fullCookbook.has(c.id),
    );
    const otherBooks = focused
      ? cookbooks.filter((c) => !fullCookbook.has(c.id))
      : [];
    out.push('');
    if (fullBooks.length)
      out.push('Cookbooks:', ...fullBooks.map(cookbookLine));
    if (otherBooks.length) {
      out.push(
        `Other cookbooks: ${compact(otherBooks.map((c) => `${c.id} (${c.name})`))}.`,
      );
    }
  }
  out.push(
    '',
    `Currently on: ${current.length ? current.join(', ') : 'none'}.`,
  );
  if (settings) {
    const terms = settings.paymentTerms
      ? `, terms ${settings.paymentTerms}`
      : '';
    const pricing = settings.pricesIncludeTax
      ? ', prices include tax'
      : ', prices exclude tax';
    const rounding =
      settings.taxRounding === 'document' ? ', tax rounded per document' : '';
    out.push(
      `Settings: currency ${settings.currency}, tax ${formatTaxPercent(settings.taxRate)}${terms}${pricing}${rounding}.`,
    );
  }
  if (themeInfo) {
    out.push(`Theme: ${describeTheme(themeInfo.current)}.`);
  }
  if (menu.length) {
    out.push(`Menu: ${menu.map((s) => `${s.id} (${s.label})`).join(', ')}.`);
  }
  if (reports.length) {
    out.push(
      `Report sources: ${reports.map((r) => `${r.id} (${r.label})`).join(', ')}.`,
    );
  }
  return out.join('\n');
}
