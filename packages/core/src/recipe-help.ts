/**
 * Recipe help (#3591): the pure, browser-safe helper that turns a recipe's
 * `help` into something a host can render, following how the app configured
 * the recipe's fields.
 *
 * Contract. A recipe entry carries `help: { markdown, fieldRefs }`. The
 * Markdown is user-facing prose: an overview and tasks. A step names a field as
 * `{field:name}` or `{field:Model.name}`, and the Markdown block that contains a
 * reference (a heading, a paragraph or a list item) is tied to that field.
 * `fieldRefs` is derived from the Markdown at build time, never written by hand.
 *
 * Rendering. {@link renderHelp} replaces each reference with the field's
 * effective label, drops the blocks tied to a field the app does not show
 * (hidden, disabled, advanced-and-not-enabled, or unknown), prunes a heading
 * whose whole section was dropped, builds the glossary from the effective label
 * and help (falling back to the `@field({ description })`), and lists the
 * recipe's generated REST, MCP and CLI surfaces last as "Connect other tools".
 *
 * The result is an AST of text nodes, never HTML: no raw markup from help
 * content can reach a page, so nothing needs sanitizing. {@link helpToMarkdown}
 * flattens the same result to Markdown for hosts that prefer their own
 * renderer. Only a small Markdown subset is understood: `##`/`###`/`####`
 * headings, paragraphs, flat `-`/`*`/`1.` lists, and `**bold**`, `*italic*` and
 * `` `code` `` inline. Anything else is plain text.
 *
 * @packageDocumentation
 */

import type {
  RecipeExposureNarrowing,
  RecipeHelp,
} from '@happyvertical/smrt-types';

export type { RecipeHelp };

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
  /**
   * `basic` fields are shown. `hidden` fields are not. `advanced` fields are
   * treated like hidden unless {@link RenderHelpOptions.showAdvanced} is set.
   */
  visibility: 'basic' | 'advanced' | 'hidden';
  /** A disabled field is never shown, whatever its visibility. */
  disabled?: boolean;
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
}

export interface GlossaryEntry {
  model: string;
  name: string;
  label: string;
  text: string;
}

/** One generated REST route, MCP tool or CLI command of a recipe model. */
export interface ConnectSurface {
  /** Class name of the model it belongs to. */
  model: string;
  kind: 'api' | 'mcp' | 'cli';
  /** The operation: a CRUD verb or a method name, e.g. `list`. */
  operation: string;
  /** Tool or command name. */
  name: string;
  /** REST route, when the surface has one. */
  path?: string;
  /** HTTP method, when the surface has one. */
  method?: string;
}

export interface RenderHelpOptions {
  /** Treat `advanced` fields as shown; by default they are dropped like hidden ones. */
  showAdvanced?: boolean;
  /** The recipe's generated surfaces, for the "Connect other tools" section. */
  surfaces?: readonly ConnectSurface[];
  /**
   * The recipe's `options.<Model>.exposure` narrowing, keyed by class name:
   * `false` withdraws a transport, `{ exclude }` withdraws named operations.
   */
  exposure?: Readonly<
    Record<
      string,
      Partial<Record<'api' | 'mcp' | 'cli', RecipeExposureNarrowing>>
    >
  >;
}

/** The developer-facing surfaces, listed last and collapsed by default. */
export interface ConnectSection {
  title: string;
  /** Hosts render this section collapsed. */
  collapsed: true;
  groups: Array<{
    kind: 'api' | 'mcp' | 'cli';
    label: string;
    entries: Array<{ model: string; text: string }>;
  }>;
}

export interface RenderedHelp {
  blocks: HelpBlock[];
  /**
   * One entry per SHOWN field that has text. A shown field with neither
   * effective help nor a description is skipped, not listed with a blank.
   */
  glossary: GlossaryEntry[];
  /** Present only when the recipe has generated surfaces left after narrowing. */
  connect?: ConnectSection;
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
 * Problems that should fail a build: no Markdown, references to fields the
 * recipe's models do not declare, and a `fieldRefs` list that disagrees with
 * the Markdown. An empty list means the help is valid.
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
    problems.push(
      `fieldRefs does not match the references in the markdown (markdown: [${actual.join(', ')}]; fieldRefs: [${[...help.fieldRefs].sort().join(', ')}]); an unbalanced backtick across lines is a common cause`,
    );
  }
  return problems;
}

function isShown(field: HelpField, options: RenderHelpOptions): boolean {
  if (field.disabled === true) return false;
  return (
    field.visibility === 'basic' ||
    (field.visibility === 'advanced' && options.showAdvanced === true)
  );
}

type ResolveOutcome = { inlines: Inline[] } | null;

/** Replace references with labels, or `null` when any is not shown. */
function resolveInlines(
  inlines: readonly Inline[],
  models: readonly HelpModel[],
  options: RenderHelpOptions,
): ResolveOutcome {
  const out: Inline[] = [];
  for (const node of inlines) {
    if (node.type === 'field') {
      const found = findField(node.ref, models);
      if (!found || !isShown(found.field, options)) return null;
      out.push({ type: 'text', text: found.field.label });
    } else if (node.type === 'strong' || node.type === 'em') {
      const inner = resolveInlines(node.children, models, options);
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

/**
 * Does the section under the heading at `index` hold any non-heading block?
 * With `survivors`, only blocks that were kept count.
 */
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
  options: RenderHelpOptions = {},
): HelpBlock[] {
  const entries: Entry[] = parseHelp(help.markdown).map((source) => {
    if (source.type === 'list') {
      const items = source.items.flatMap((item) => {
        const resolved = resolveInlines(item.inlines, models, options);
        return resolved ? [{ inlines: resolved.inlines }] : [];
      });
      return { source, kept: items.length ? { ...source, items } : null };
    }
    const resolved = resolveInlines(source.inlines, models, options);
    return {
      source,
      kept: resolved ? { ...source, inlines: resolved.inlines } : null,
    };
  });
  // A heading whose section had content, all of it dropped, goes too. A
  // heading that never had content (a pure divider) is the author's and stays.
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

/**
 * One entry per shown field: effective label, then effective help or, failing
 * that, the field's `@field({ description })`. A shown field with neither is
 * skipped rather than listed with an empty definition.
 */
export function buildGlossary(
  models: readonly HelpModel[],
  options: RenderHelpOptions = {},
): GlossaryEntry[] {
  return models.flatMap((model) =>
    model.fields.flatMap((field) => {
      if (!isShown(field, options)) return [];
      const text = field.help?.trim() || model.descriptions?.[field.name] || '';
      return text
        ? [{ model: model.name, name: field.name, label: field.label, text }]
        : [];
    }),
  );
}

const CONNECT_KINDS = [
  ['api', 'REST routes'],
  ['mcp', 'MCP tools'],
  ['cli', 'CLI commands'],
] as const;

function isWithdrawn(
  surface: ConnectSurface,
  options: RenderHelpOptions,
): boolean {
  const narrowing = options.exposure?.[surface.model]?.[surface.kind];
  if (narrowing === false) return true;
  return (
    typeof narrowing === 'object' &&
    narrowing !== null &&
    narrowing.exclude.includes(surface.operation)
  );
}

/**
 * The generated REST routes, MCP tools and CLI commands left after the
 * recipe's exposure narrowing, grouped by transport. `undefined` when none.
 */
export function buildConnectSection(
  options: RenderHelpOptions = {},
): ConnectSection | undefined {
  const surfaces = (options.surfaces ?? []).filter(
    (surface) => !isWithdrawn(surface, options),
  );
  const groups = CONNECT_KINDS.flatMap(([kind, label]) => {
    const entries = surfaces
      .filter((surface) => surface.kind === kind)
      .map((surface) => ({
        model: surface.model,
        text:
          surface.method && surface.path
            ? `${surface.method.toUpperCase()} ${surface.path}`
            : surface.name,
      }));
    return entries.length ? [{ kind, label, entries }] : [];
  });
  return groups.length
    ? { title: 'Connect other tools', collapsed: true, groups }
    : undefined;
}

/** The whole renderer: resolved blocks, the field glossary and the connect section. */
export function renderHelp(
  help: RecipeHelp,
  models: readonly HelpModel[],
  options: RenderHelpOptions = {},
): RenderedHelp {
  const connect = buildConnectSection(options);
  return {
    blocks: resolveHelp(help, models, options),
    glossary: buildGlossary(models, options),
    ...(connect ? { connect } : {}),
  };
}

// -- Markdown output --------------------------------------------------------

function inlinesToMarkdown(inlines: readonly Inline[]): string {
  return inlines
    .map((node) => {
      switch (node.type) {
        case 'text':
          return node.text;
        case 'code':
          return `\`${node.text}\``;
        case 'strong':
          return `**${inlinesToMarkdown(node.children)}**`;
        case 'em':
          return `*${inlinesToMarkdown(node.children)}*`;
        default:
          return node.ref;
      }
    })
    .join('');
}

/**
 * Flatten a rendered help to Markdown, for hosts that prefer their own
 * Markdown renderer. The glossary and the connect section follow the blocks as
 * ordinary headings and lists; collapsing is left to the host. Text is carried
 * verbatim, so a host must render the Markdown with raw HTML disabled; prefer
 * the AST when the output goes to a page.
 */
export function helpToMarkdown(rendered: RenderedHelp): string {
  const parts: string[] = [];
  for (const block of rendered.blocks) {
    if (block.type === 'heading') {
      parts.push(
        `${'#'.repeat(block.level)} ${inlinesToMarkdown(block.inlines)}`,
      );
    } else if (block.type === 'paragraph') {
      parts.push(inlinesToMarkdown(block.inlines));
    } else {
      parts.push(
        block.items
          .map(
            (item, index) =>
              `${block.ordered ? `${index + 1}.` : '-'} ${inlinesToMarkdown(item.inlines)}`,
          )
          .join('\n'),
      );
    }
  }
  if (rendered.glossary.length > 0) {
    parts.push(
      `## Fields\n\n${rendered.glossary
        .map((entry) => `- **${entry.label}**: ${entry.text}`)
        .join('\n')}`,
    );
  }
  if (rendered.connect) {
    const groups = rendered.connect.groups
      .map(
        (group) =>
          `### ${group.label}\n\n${group.entries
            .map((entry) => `- ${entry.model}: \`${entry.text}\``)
            .join('\n')}`,
      )
      .join('\n\n');
    parts.push(`## ${rendered.connect.title}\n\n${groups}`);
  }
  return `${parts.join('\n\n')}\n`;
}
