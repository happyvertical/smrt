/**
 * Recipe help: the `help` contract of happyvertical/smrt#3591 and the one
 * renderer that follows an app's options. Everything the contract needs lives
 * here and imports nothing from the planner, so the module can be swapped for
 * the core helper once #3591 is published, and `help.ts` deleted.
 *
 * Contract. A recipe entry carries `help: { markdown, fieldRefs }`. The
 * Markdown is user-facing prose with an overview and tasks. A step names a
 * field as `{field:name}` or `{field:Model.name}`, and a Markdown block (a
 * heading, a paragraph or a list item) containing a reference is tied to that
 * field. Field descriptions come from `@field({ description })` and are passed
 * in with the models.
 *
 * Rendering. {@link renderHelp} replaces each reference with the field's
 * effective label, drops the blocks tied to a field the app does not show
 * (hidden, advanced or unknown) and builds the glossary from the effective
 * label and help, falling back to the description. The output is an AST, never
 * HTML, so no raw markup from content can reach the page: the host renders the
 * nodes as ordinary elements. Only a small subset of Markdown is understood:
 * `##`/`###`/`####` headings, paragraphs, flat `-`/`*`/`1.` lists, and
 * `**bold**`, `*italic*` and `` `code` `` inline. Anything else is plain text.
 */

/** What a recipe entry carries: the Markdown and every field it refers to. */
export interface RecipeHelp {
  markdown: string;
  /** Distinct `{field:...}` targets as written (`status`, `Order.status`), sorted. */
  fieldRefs: string[];
}

// -- Parsing ----------------------------------------------------------------

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  /** Present only before resolution; {@link renderHelp} replaces it. */
  | { type: 'field'; ref: string };

export interface HelpHeading {
  type: 'heading';
  level: 2 | 3 | 4;
  inlines: Inline[];
}
export interface HelpParagraph {
  type: 'paragraph';
  inlines: Inline[];
}
export interface HelpItem {
  inlines: Inline[];
}
export interface HelpList {
  type: 'list';
  ordered: boolean;
  items: HelpItem[];
}
export type HelpBlock = HelpHeading | HelpParagraph | HelpList;

const FIELD_REF =
  /\{field:([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\}/;
const INLINE =
  /\{field:[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?\}|`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*/;

function parseInline(source: string): Inline[] {
  const out: Inline[] = [];
  let rest = source;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) break;
    if (match.index > 0) {
      out.push({ type: 'text', text: rest.slice(0, match.index) });
    }
    const token = match[0];
    const ref = FIELD_REF.exec(token);
    if (ref && ref[0] === token) {
      out.push({ type: 'field', ref: ref[1] as string });
    } else if (token.startsWith('`')) {
      out.push({ type: 'code', text: token.slice(1, -1) });
    } else if (token.startsWith('**')) {
      out.push({ type: 'strong', children: parseInline(token.slice(2, -2)) });
    } else {
      out.push({ type: 'em', children: parseInline(token.slice(1, -1)) });
    }
    rest = rest.slice(match.index + token.length);
  }
  if (rest) out.push({ type: 'text', text: rest });
  return out;
}

const HEADING = /^(#{2,4})\s+(.+?)\s*#*\s*$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

/** Parse the supported Markdown subset into blocks. */
export function parseHelp(markdown: string): HelpBlock[] {
  const blocks: HelpBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({
        type: 'paragraph',
        inlines: parseInline(paragraph.join(' ')),
      });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({
        type: 'list',
        ordered: list.ordered,
        items: list.items.map((item) => ({ inlines: parseInline(item) })),
      });
      list = null;
    }
  };

  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = HEADING.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({
        type: 'heading',
        level: (heading[1] as string).length as 2 | 3 | 4,
        inlines: parseInline(heading[2] as string),
      });
      continue;
    }
    const bullet = BULLET.exec(trimmed);
    const numbered = bullet ? null : NUMBERED.exec(trimmed);
    const marker = bullet ?? numbered;
    // A marker at the start of the line (not indented) opens a list item.
    if (marker && raw === raw.trimStart()) {
      flushParagraph();
      const ordered = numbered !== null;
      if (list && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [] };
      list.items.push(marker[1] as string);
      continue;
    }
    // An indented line continues the open list item, else the paragraph.
    if (list) {
      list.items[list.items.length - 1] += ` ${trimmed}`;
    } else {
      paragraph.push(trimmed);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

function refsOf(inlines: readonly Inline[]): string[] {
  return inlines.flatMap((node) =>
    node.type === 'field'
      ? [node.ref]
      : node.type === 'strong' || node.type === 'em'
        ? refsOf(node.children)
        : [],
  );
}

/** Every distinct field reference in the Markdown, as written, sorted. */
export function extractFieldRefs(markdown: string): string[] {
  const refs = parseHelp(markdown).flatMap((block) =>
    block.type === 'list'
      ? block.items.flatMap((item) => refsOf(item.inlines))
      : refsOf(block.inlines),
  );
  return [...new Set(refs)].sort();
}

/** Build a contract entry from Markdown, deriving `fieldRefs`. */
export function createRecipeHelp(markdown: string): RecipeHelp {
  return { markdown, fieldRefs: extractFieldRefs(markdown) };
}

// -- Resolution -------------------------------------------------------------

/** A field as the app's options leave it: smrt-fields vocabulary. */
export interface HelpField {
  name: string;
  /** Effective label. */
  label: string;
  /** Effective help; empty or absent falls back to the description. */
  help?: string | null;
  /** Only `basic` fields are shown. `hidden` and `advanced` are not. */
  visibility: 'basic' | 'advanced' | 'hidden';
}

export interface HelpModel {
  /** Qualified name, `@scope/pkg:Class`. */
  id: string;
  /** Class name, what `{field:Model.name}` uses. */
  name: string;
  /** In display order. */
  fields: readonly HelpField[];
  /** Field descriptions (`@field({ description })`), keyed by field name. */
  descriptions?: Readonly<Record<string, string>>;
  /**
   * `false` when no list or form shows the model (a recipe with no menu
   * entry): its fields still resolve in the prose, but get no glossary entry.
   */
  glossary?: boolean;
}

export interface GlossaryEntry {
  model: string;
  name: string;
  label: string;
  text: string;
}

export interface RenderedHelp {
  blocks: HelpBlock[];
  glossary: GlossaryEntry[];
}

/** Find a reference's field: `name` in the first model declaring it, or `Model.name`. */
export function findField(
  ref: string,
  models: readonly HelpModel[],
): { model: HelpModel; field: HelpField } | undefined {
  const dot = ref.indexOf('.');
  const modelName = dot === -1 ? null : ref.slice(0, dot);
  const fieldName = dot === -1 ? ref : ref.slice(dot + 1);
  for (const model of models) {
    if (modelName !== null && model.name !== modelName) continue;
    const field = model.fields.find((f) => f.name === fieldName);
    if (field) return { model, field };
  }
  return undefined;
}

/**
 * Problems that should fail a build: references to fields the recipe's models
 * do not declare, and a `fieldRefs` list that disagrees with the Markdown.
 */
export function validateHelp(
  help: RecipeHelp,
  models: readonly HelpModel[],
): string[] {
  const problems: string[] = [];
  if (!help.markdown.trim()) problems.push('help has no markdown');
  const actual = extractFieldRefs(help.markdown);
  for (const ref of actual) {
    if (!findField(ref, models)) {
      problems.push(`{field:${ref}} names a field the recipe's models lack`);
    }
  }
  if (JSON.stringify([...help.fieldRefs].sort()) !== JSON.stringify(actual)) {
    problems.push('fieldRefs does not match the references in the markdown');
  }
  return problems;
}

type ResolveOutcome = { inlines: Inline[] } | null;

/** Replace references with labels, or `null` when any is not shown. */
function resolveInlines(
  inlines: readonly Inline[],
  models: readonly HelpModel[],
): ResolveOutcome {
  const out: Inline[] = [];
  for (const node of inlines) {
    if (node.type === 'field') {
      const found = findField(node.ref, models);
      if (!found) return null;
      if (found.field.visibility !== 'basic') return null;
      out.push({ type: 'text', text: found.field.label });
    } else if (node.type === 'strong' || node.type === 'em') {
      const inner = resolveInlines(node.children, models);
      if (!inner) return null;
      out.push({ type: node.type, children: inner.inlines });
    } else {
      out.push(node);
    }
  }
  return { inlines: out };
}

interface Entry {
  source: HelpBlock;
  /** The resolved block, or `null` when it was tied to a field not shown. */
  kept: HelpBlock | null;
}

/** Does the section under the heading at `index` hold any non-heading block? */
function sectionHasBody(
  entries: readonly Entry[],
  index: number,
  survivors: boolean,
): boolean {
  const heading = entries[index]?.source as HelpHeading;
  for (let i = index + 1; i < entries.length; i++) {
    const next = entries[i] as Entry;
    if (next.source.type === 'heading') {
      if (next.source.level <= heading.level) return false;
      continue;
    }
    if (!survivors || next.kept) return true;
  }
  return false;
}

/** Resolve the Markdown against the app's options. */
export function resolveHelp(
  help: RecipeHelp,
  models: readonly HelpModel[],
): HelpBlock[] {
  const entries: Entry[] = parseHelp(help.markdown).map((source) => {
    if (source.type === 'list') {
      const items = source.items.flatMap((item) => {
        const resolved = resolveInlines(item.inlines, models);
        return resolved ? [{ inlines: resolved.inlines }] : [];
      });
      return { source, kept: items.length ? { ...source, items } : null };
    }
    const resolved = resolveInlines(source.inlines, models);
    return {
      source,
      kept: resolved ? { ...source, inlines: resolved.inlines } : null,
    };
  });
  // A heading whose section had content, all of it dropped, goes too.
  return entries.flatMap((entry, index) => {
    if (!entry.kept) return [];
    if (
      entry.source.type === 'heading' &&
      sectionHasBody(entries, index, false) &&
      !sectionHasBody(entries, index, true)
    ) {
      return [];
    }
    return [entry.kept];
  });
}

/** One entry per shown field: effective label, then effective help or description. */
export function buildGlossary(models: readonly HelpModel[]): GlossaryEntry[] {
  return models.flatMap((model) =>
    model.fields.flatMap((field) => {
      if (model.glossary === false || field.visibility !== 'basic') return [];
      const text = field.help?.trim() || model.descriptions?.[field.name] || '';
      return text
        ? [{ model: model.name, name: field.name, label: field.label, text }]
        : [];
    }),
  );
}

/** The whole renderer: resolved blocks plus the field glossary. */
export function renderHelp(
  help: RecipeHelp,
  models: readonly HelpModel[],
): RenderedHelp {
  return {
    blocks: resolveHelp(help, models),
    glossary: buildGlossary(models),
  };
}
