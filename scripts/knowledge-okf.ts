/**
 * Open Knowledge Format (OKF) v0.2 component-page library (#4686).
 *
 * Shared by `scripts/generate-knowledge-okf.ts` (writes the bundle) and
 * `scripts/check-knowledge.ts` (verifies it). It contains no discovery logic of
 * its own: every fact on a page comes from the `SmrtKnowledgeIndex` that
 * `packages/smrt-dev-mcp/src/knowledge/` already builds, so the pages cannot
 * disagree with `smrt-knowledge.json`. Only erasable TypeScript syntax and
 * type-only imports of the pipeline are used, so Node can load this file
 * directly for `scripts/knowledge-okf.test.mjs`.
 *
 * Bundle layout (root `docs/knowledge/`, concept ID = path from the root with a
 * leading slash):
 *
 *   index.md                      generated; lists intents, components, others
 *   components/index.md           generated
 *   components/<name>.md          generated, <name> = unscoped package name
 *   intents/**, solutions/**      hand-authored; never written by the generator
 *
 * ## `source_revision`
 *
 * `source_revision` is `sha256:<hex>` over the canonical JSON of the page's
 * *input model*: package manifest facts (name, description, private,
 * exports, framework/SDK dependencies), the SHA-256 of the package's own
 * `AGENTS.md` and linked `agents/*.md` module docs, the object, MCP-tool and
 * `agentSurface` (intents and playbooks) slices of the knowledge index, and the
 * generator `FORMAT_VERSION`. The package version is deliberately not an input and
 * is not rendered: it changes on every release commit, which would stale all
 * pages; `smrt docs:agents` stamps `package_version` from the installed version
 * at export time. It is a content pin, not a commit id: it moves
 * when, and only when, something the page renders (or the AGENTS chain it
 * summarises) changes, so `knowledge:check --strict` goes red on a stale page
 * and stays green when HEAD merely moves. The workspace-root `AGENTS.md` is
 * deliberately not an input: no page renders it, and including it would force
 * all 80 pages to regenerate on every root instruction edit.
 *
 * Because the object, MCP and agent-surface slices come from the built
 * `smrt-knowledge.json` artifacts, the generator runs after `turbo build`
 * (it is deliberately NOT part of `pnpm build`, which would refresh a stale page
 * before the gate could see it), exactly like the freshness gate that
 * already requires built artifacts.
 *
 * ## `generated.at`
 *
 * The first time a page's `source_revision` is written it gets the current
 * time. While `source_revision` is unchanged the previous value is kept
 * verbatim, so re-running the generator yields zero diff.
 *
 * ## Omitted: `stale_after`
 *
 * Generated pages carry no `stale_after`. Their freshness is the
 * `source_revision` gate; a wall-clock backstop would expire pages the gate
 * still proves current. `stale_after` is for hand-authored concept pages.
 *
 * ## Evidence level
 *
 * The generator can only emit `manifest-described` (identity from the package
 * manifest) or `source-inspected` (the page also lists models, MCP tools or
 * agent-surface entries that the scanner derived from source). Release- and
 * deployment-verified marks are human decisions and are never emitted.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type {
  KnowledgePackage,
  SmrtKnowledgeIndex,
} from '../packages/smrt-dev-mcp/src/knowledge/index.js';

/** Bump when the rendered page shape changes; every page then regenerates. */
export const FORMAT_VERSION = 1;
export const OKF_VERSION = '0.2';
export const GENERATED_BY = 'smrt/scripts/generate-knowledge-okf.ts';
export const BUNDLE_RELATIVE_DIR = 'docs/knowledge';
const REPOSITORY_BLOB_URL = 'https://github.com/happyvertical/smrt/blob/main';

export type EvidenceLevel = 'manifest-described' | 'source-inspected';

export interface ComponentModel {
  /** Unscoped package name; the page file is `components/<name>.md`. */
  name: string;
  /** Concept ID with leading slash: `/components/<name>.md`. */
  id: string;
  packageName: string;
  description: string;
  isPrivate: boolean;
  directory: string;
  objectSource: string;
  exports: string[];
  frameworkDependencies: string[];
  sdkDependencies: string[];
  docs: Array<{ path: string; sha256: string }>;
  models: Array<{
    className: string;
    collection?: string;
    extends?: string;
    tableStrategy?: string;
  }>;
  mcpTools: Array<{ name: string; operation: string; sourceObject: string }>;
  intents: Array<{ id: string; description: string; sourceFile: string }>;
  playbooks: Array<{
    key: string;
    title: string;
    steps: number;
    sourceFile: string;
  }>;
  agentSurfaceDiagnostics: number;
  evidenceLevel: EvidenceLevel;
  sourceRevision: string;
}

export interface OkfIssue {
  code: string;
  message: string;
  file: string;
}

export function unscopedName(packageName: string): string {
  return packageName.replace(/^@[^/]+\//, '');
}

export function componentId(name: string): string {
  return `/components/${name}.md`;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function byString<T>(key: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  };
}

/** JSON with sorted object keys: the canonical form hashed into `source_revision`. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function readDescription(pkg: KnowledgePackage): string {
  try {
    const manifest = JSON.parse(
      readFileSync(join(pkg.directory, 'package.json'), 'utf8'),
    ) as { description?: unknown };
    if (typeof manifest.description === 'string') {
      const text = oneLine(manifest.description);
      if (text) return text;
    }
  } catch {
    // Fall through: the index already read this file, so this is unreachable
    // for discovered packages; the fallback only keeps the emitter total.
  }
  return `Workspace package ${pkg.name}`;
}

/** Build the input model (and its pin) for one workspace package. */
export function buildComponentModel(pkg: KnowledgePackage): ComponentModel {
  const name = unscopedName(pkg.name);
  const directory = pkg.relativeDirectory;
  const prefix = directory ? `${directory}/` : '';
  const docs: ComponentModel['docs'] = [];
  if (pkg.docSource) {
    docs.push({
      path: `${prefix}${pkg.docSource}`,
      sha256: pkg.agentDocSha256 ?? sha256(pkg.agentDoc ?? ''),
    });
  }
  for (const doc of pkg.moduleDocs) {
    docs.push({ path: `${prefix}${doc.path}`, sha256: sha256(doc.content) });
  }
  docs.sort(byString((doc) => doc.path));

  // A local artifact may also register models consumed from other packages.
  const owns = (name?: string) =>
    !name?.includes(':') || name.startsWith(`${pkg.name}:`);
  const surface = pkg.agentSurface;
  const models = pkg.objects
    .filter((object) => owns(object.qualifiedName))
    .map((object) => ({
      className: object.className,
      collection: object.collection,
      extends: object.extends,
      tableStrategy: object.tableStrategy,
    }))
    .sort(byString((model) => model.className));
  const mcpTools = pkg.mcpTools
    .filter((tool) => owns(tool.sourceObject))
    .map((tool) => ({
      name: tool.name,
      operation: tool.operation,
      sourceObject: tool.sourceObject,
    }))
    .sort(byString((tool) => `${tool.name}\u0000${tool.sourceObject}`));
  const intents = (surface?.intents ?? [])
    .map((intent) => ({
      id: intent.id,
      description: oneLine(intent.description),
      sourceFile: intent.sourceFile,
    }))
    .sort(byString((intent) => intent.id));
  const playbooks = (surface?.playbooks ?? [])
    .map((playbook) => ({
      key: playbook.key,
      title: oneLine(playbook.title),
      steps: playbook.steps.length,
      sourceFile: playbook.sourceFile,
    }))
    .sort(byString((playbook) => playbook.key));

  const derivedFromSource =
    pkg.objectSource !== 'none' &&
    (models.length > 0 ||
      mcpTools.length > 0 ||
      intents.length > 0 ||
      playbooks.length > 0);

  const model: Omit<ComponentModel, 'sourceRevision'> = {
    name,
    id: componentId(name),
    packageName: pkg.name,
    description: readDescription(pkg),
    isPrivate: pkg.isPrivate,
    directory,
    objectSource: pkg.objectSource,
    exports: [...pkg.exportKeys].sort(),
    frameworkDependencies: [...pkg.smrtDependencies].sort(),
    sdkDependencies: [...pkg.sdkDependencies].sort(),
    docs,
    models,
    mcpTools,
    intents,
    playbooks,
    agentSurfaceDiagnostics: surface?.diagnostics.length ?? 0,
    evidenceLevel: derivedFromSource
      ? 'source-inspected'
      : 'manifest-described',
  };
  return {
    ...model,
    sourceRevision: `sha256:${sha256(
      canonicalJson({ formatVersion: FORMAT_VERSION, model }),
    )}`,
  };
}

/**
 * One model per authored workspace package, sorted by concept ID. Two packages
 * that map to the same unscoped name make the bundle ambiguous, so it fails
 * loudly rather than letting one page overwrite the other.
 */
export function buildComponentModels(
  index: SmrtKnowledgeIndex,
): ComponentModel[] {
  const byName = new Map<string, ComponentModel>();
  for (const pkg of index.smrtPackages) {
    if (pkg.isInstalledDependency || pkg.isWorkspaceRoot) continue;
    const model = buildComponentModel(pkg);
    if (model.name === 'index') {
      throw new Error(
        `Package ${pkg.name} maps to the reserved concept name "index".`,
      );
    }
    const existing = byName.get(model.name);
    if (existing) {
      throw new Error(
        `OKF component ID collision: ${existing.packageName} and ${pkg.name} both map to ${model.id}.`,
      );
    }
    byName.set(model.name, model);
  }
  return [...byName.values()].sort(byString((model) => model.id));
}

// ---------------------------------------------------------------------------
// Frontmatter emitter / parser
// ---------------------------------------------------------------------------

function emitScalar(value: string | number | boolean | null): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function emitYamlLines(value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        const nested = emitYamlLines(item, indent + 2);
        lines.push(`${pad}- ${nested[0].trimStart()}`, ...nested.slice(1));
      } else {
        lines.push(`${pad}- ${emitScalar(item as string)}`);
      }
    }
    return lines;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const entry = record[key];
    if (entry === undefined) continue;
    if (Array.isArray(entry) && entry.length === 0) {
      lines.push(`${pad}${key}: []`);
    } else if (entry && typeof entry === 'object') {
      lines.push(`${pad}${key}:`, ...emitYamlLines(entry, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${emitScalar(entry as string)}`);
    }
  }
  return lines;
}

/**
 * Emit a deterministic `---` frontmatter block. Insertion order is preserved
 * (callers fix the key order), strings are always JSON-quoted (valid YAML), and
 * nothing depends on the clock or the environment.
 */
export function emitFrontmatter(fields: Record<string, unknown>): string {
  return `---\n${emitYamlLines(fields, 0).join('\n')}\n---\n`;
}

export interface ParsedPage {
  /** `undefined` when the page has no frontmatter block. */
  frontmatter: Record<string, unknown> | undefined;
  body: string;
  /** Set when a frontmatter block exists but is not parseable YAML mapping. */
  error?: string;
}

export function parsePage(text: string): ParsedPage {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match) return { frontmatter: undefined, body: text };
  const body = text.slice(match[0].length);
  try {
    const parsed = parseYaml(match[1]);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        frontmatter: undefined,
        body,
        error: 'frontmatter is not a YAML mapping',
      };
    }
    return { frontmatter: parsed as Record<string, unknown>, body };
  } catch (error) {
    return {
      frontmatter: undefined,
      body,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function code(text: string): string {
  return `\`${text.replace(/`/g, "'")}\``;
}

export function renderComponentPage(
  model: ComponentModel,
  knownIds: ReadonlySet<string>,
  generatedAt: string,
): string {
  const dir = model.directory;
  const frontmatter = emitFrontmatter({
    type: 'Component',
    title: model.packageName,
    description: model.description,
    status: 'stable',
    generated: { by: GENERATED_BY, at: generatedAt },
    audience: 'internal',
    // biome-ignore lint/style/useNamingConvention: OKF frontmatter key names
    evidence_level: model.evidenceLevel,
    // biome-ignore lint/style/useNamingConvention: OKF frontmatter key names
    source_revision: model.sourceRevision,
    sources: [
      {
        id: 'manifest',
        resource: `${REPOSITORY_BLOB_URL}/${dir}/package.json`,
        title: `${model.packageName} package manifest`,
      },
      ...model.docs.map((doc, position) => ({
        id: position === 0 ? 'agents' : `agents-${position + 1}`,
        resource: `${REPOSITORY_BLOB_URL}/${doc.path}`,
        title: `${model.packageName} ${doc.path}`,
      })),
    ],
  });

  const out: string[] = [frontmatter, `# ${model.packageName}`, ''];
  out.push(
    '## Package',
    '',
    `- Directory: ${code(dir)}`,
    `- Private: ${model.isPrivate ? 'yes' : 'no'}`,
    `- Object source: ${code(model.objectSource)}`,
    `- Evidence level: ${code(model.evidenceLevel)}`,
    '',
  );
  if (model.docs.length > 0) {
    out.push('## Documentation', '');
    for (const doc of model.docs) out.push(`- ${code(doc.path)}`);
    out.push('');
  }
  if (model.frameworkDependencies.length > 0) {
    out.push('## Framework dependencies', '');
    for (const dep of model.frameworkDependencies) {
      const id = componentId(unscopedName(dep));
      out.push(
        knownIds.has(id) ? `- [${unscopedName(dep)}](${id})` : `- ${code(dep)}`,
      );
    }
    out.push('');
  }
  if (model.sdkDependencies.length > 0) {
    out.push('## SDK dependencies', '');
    for (const dep of model.sdkDependencies) out.push(`- ${code(dep)}`);
    out.push('');
  }
  if (model.exports.length > 0) {
    out.push('## Exports', '');
    for (const key of model.exports) out.push(`- ${code(key)}`);
    out.push('');
  }
  if (model.models.length > 0) {
    out.push('## Models', '');
    for (const item of model.models) {
      const details = [
        item.collection ? `collection ${code(item.collection)}` : '',
        item.extends ? `extends ${code(item.extends)}` : '',
        item.tableStrategy ? `${item.tableStrategy.toUpperCase()} table` : '',
      ].filter(Boolean);
      out.push(
        `- ${code(item.className)}${details.length ? ` (${details.join(', ')})` : ''}`,
      );
    }
    out.push('');
  }
  if (model.mcpTools.length > 0) {
    out.push('## MCP tools', '');
    for (const tool of model.mcpTools) {
      out.push(
        `- ${code(tool.name)}: ${tool.operation} on ${code(tool.sourceObject)}`,
      );
    }
    out.push('');
  }
  if (model.intents.length > 0) {
    out.push('## Agent intents', '');
    for (const intent of model.intents) {
      out.push(
        `- ${code(intent.id)}: ${intent.description} (${code(intent.sourceFile)})`,
      );
    }
    out.push('');
  }
  if (model.playbooks.length > 0) {
    out.push('## Agent playbooks', '');
    for (const playbook of model.playbooks) {
      out.push(
        `- ${code(playbook.key)}: ${playbook.title}, ${playbook.steps} step${playbook.steps === 1 ? '' : 's'} (${code(playbook.sourceFile)})`,
      );
    }
    out.push('');
  }
  if (model.agentSurfaceDiagnostics > 0) {
    out.push(
      '## Agent surface diagnostics',
      '',
      `- Non-static declarations: ${model.agentSurfaceDiagnostics}`,
      '',
    );
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

export function renderComponentIndex(
  models: readonly ComponentModel[],
): string {
  const lines = ['# Components', ''];
  for (const model of models) {
    lines.push(`* [${model.packageName}](${model.id}) - ${model.description}`);
  }
  return `${lines.join('\n')}\n`;
}

function listBundleEntries(bundleDir: string): {
  directories: Array<{ name: string; hasIndex: boolean }>;
  pages: Array<{ file: string; title: string; description: string }>;
} {
  const directories: Array<{ name: string; hasIndex: boolean }> = [];
  const pages: Array<{ file: string; title: string; description: string }> = [];
  if (!existsSync(bundleDir)) return { directories, pages };
  for (const entry of readdirSync(bundleDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name === 'components' || entry.name === 'intents') continue;
      if (existsSync(join(bundleDir, entry.name, 'index.md'))) {
        directories.push({ name: entry.name, hasIndex: true });
      }
    } else if (
      entry.name.endsWith('.md') &&
      entry.name !== 'index.md' &&
      entry.name !== 'log.md'
    ) {
      const parsed = parsePage(
        readFileSync(join(bundleDir, entry.name), 'utf8'),
      );
      const fm = parsed.frontmatter ?? {};
      pages.push({
        file: entry.name,
        title: typeof fm.title === 'string' ? fm.title : entry.name,
        description: typeof fm.description === 'string' ? fm.description : '',
      });
    }
  }
  directories.sort(byString((item) => item.name));
  pages.sort(byString((item) => item.file));
  return { directories, pages };
}

/**
 * Root `index.md`: the only index permitted frontmatter (`okf_version`). The
 * developer-intent index comes first because it is the primary entry point;
 * other top-level hand-authored directories and pages found on disk follow the
 * generated component directory.
 */
export function renderRootIndex(bundleDir: string): string {
  const { directories, pages } = listBundleEntries(bundleDir);
  const lines = [
    `---\nokf_version: ${JSON.stringify(OKF_VERSION)}\n---\n`,
    '# Knowledge base',
    '',
    '* [intents](/intents/index.md) - Developer intents: what to reach for before writing it yourself',
    '* [components](/components/index.md) - Generated component pages, one per workspace package',
  ];
  for (const dir of directories) {
    lines.push(`* [${dir.name}](/${dir.name}/index.md) - Browse this group`);
  }
  for (const page of pages) {
    lines.push(
      `* [${page.title}](/${page.file})${page.description ? ` - ${oneLine(page.description)}` : ''}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Bundle planning, writing, checking
// ---------------------------------------------------------------------------

export function bundleDirFor(rootDir: string): string {
  return join(rootDir, BUNDLE_RELATIVE_DIR);
}

function readExistingPin(
  path: string,
): { revision?: string; at?: string } | undefined {
  if (!existsSync(path)) return undefined;
  const fm = parsePage(readFileSync(path, 'utf8')).frontmatter;
  if (!fm) return {};
  const generated = fm.generated as { at?: unknown } | undefined;
  return {
    revision:
      typeof fm.source_revision === 'string' ? fm.source_revision : undefined,
    at: typeof generated?.at === 'string' ? generated.at : undefined,
  };
}

export function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The full set of generated files (bundle-relative path -> content). A page
 * whose pin is unchanged keeps its stored `generated.at`; anything else gets
 * `now`.
 */
export function planBundle(
  models: readonly ComponentModel[],
  bundleDir: string,
  now: Date,
): Map<string, string> {
  const knownIds = new Set(models.map((model) => model.id));
  const files = new Map<string, string>();
  for (const model of models) {
    const relativePath = model.id.slice(1);
    const existing = readExistingPin(join(bundleDir, relativePath));
    const at =
      existing?.revision === model.sourceRevision && existing.at
        ? existing.at
        : formatTimestamp(now);
    files.set(relativePath, renderComponentPage(model, knownIds, at));
  }
  files.set('components/index.md', renderComponentIndex(models));
  files.set('index.md', renderRootIndex(bundleDir));
  return files;
}

function walkMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkMarkdown(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found.sort();
}

/**
 * Write the generated files and remove stale generated pages. Hand-authored
 * directories are never touched: only `components/` is pruned.
 */
export function writeBundle(
  models: readonly ComponentModel[],
  bundleDir: string,
  now: Date,
): { written: number; removed: string[] } {
  const plan = planBundle(models, bundleDir, now);
  let written = 0;
  for (const [relativePath, content] of plan) {
    const path = join(bundleDir, relativePath);
    if (existsSync(path) && readFileSync(path, 'utf8') === content) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    written += 1;
  }
  const removed: string[] = [];
  for (const file of walkMarkdown(join(bundleDir, 'components'))) {
    const relativePath = relative(bundleDir, file).split(sep).join('/');
    if (!plan.has(relativePath)) {
      rmSync(file);
      removed.push(relativePath);
    }
  }
  return { written, removed: removed.sort() };
}

function stripCode(markdown: string): string {
  return markdown
    .replace(/^(```|~~~)[\s\S]*?^\1/gm, '')
    .replace(/`[^`\n]*`/g, '');
}

/** Absolute concept-ID link targets (`/x/y.md`) in a hand-authored page. */
export function extractAbsoluteLinks(markdown: string): string[] {
  const targets: string[] = [];
  const pattern = /\]\(\s*<?(\/[^)\s>#?]*)[^)]*\)/g;
  for (const match of stripCode(markdown).matchAll(pattern)) {
    targets.push(match[1]);
  }
  return targets;
}

/**
 * Verify the bundle against the current inputs. Returns one issue per problem;
 * an empty list means the bundle is fresh, complete, unedited, and every
 * hand-authored absolute link resolves.
 */
export function checkBundle(
  models: readonly ComponentModel[],
  bundleDir: string,
): OkfIssue[] {
  const issues: OkfIssue[] = [];
  const display = (path: string) =>
    `${BUNDLE_RELATIVE_DIR}/${path.split(sep).join('/')}`;
  const plan = planBundle(models, bundleDir, new Date(0));
  const byPath = new Map(models.map((model) => [model.id.slice(1), model]));

  for (const [relativePath, expected] of plan) {
    const file = display(relativePath);
    const path = join(bundleDir, relativePath);
    if (!existsSync(path)) {
      issues.push({
        code: 'okf-page-missing',
        file,
        message: `Generated OKF page is missing. Run pnpm knowledge:okf.`,
      });
      continue;
    }
    const actual = readFileSync(path, 'utf8');
    const model = byPath.get(relativePath);
    if (model) {
      const parsed = parsePage(actual);
      if (!parsed.frontmatter) {
        issues.push({
          code: 'okf-page-edited',
          file,
          message: `Generated OKF page has unparseable frontmatter${parsed.error ? ` (${parsed.error})` : ''}. Run pnpm knowledge:okf.`,
        });
        continue;
      }
      if (parsed.frontmatter.source_revision !== model.sourceRevision) {
        issues.push({
          code: 'okf-page-stale',
          file,
          message: `source_revision ${String(parsed.frontmatter.source_revision)} no longer matches the package's current inputs (${model.sourceRevision}). Run pnpm knowledge:okf.`,
        });
        continue;
      }
      // Same pin but different bytes: render with the stored timestamp and
      // compare, so only the content (not the clock) can differ.
      const at = (parsed.frontmatter.generated as { at?: string } | undefined)
        ?.at;
      const knownIds = new Set(models.map((item) => item.id));
      const reference = renderComponentPage(
        model,
        knownIds,
        typeof at === 'string' ? at : '',
      );
      if (reference !== actual) {
        issues.push({
          code: 'okf-page-edited',
          file,
          message: `Generated OKF page differs from its generator output (hand edit?). Run pnpm knowledge:okf.`,
        });
      }
    } else if (actual !== expected) {
      issues.push({
        code: 'okf-index-stale',
        file,
        message: `Generated OKF index is out of date. Run pnpm knowledge:okf.`,
      });
    }
  }

  for (const file of walkMarkdown(join(bundleDir, 'components'))) {
    const relativePath = relative(bundleDir, file).split(sep).join('/');
    if (!plan.has(relativePath)) {
      issues.push({
        code: 'okf-page-extra',
        file: display(relativePath),
        message: `No workspace package maps to this page; generated pages are never hand-authored. Run pnpm knowledge:okf.`,
      });
    }
  }

  // Every other page is hand-authored: it needs a parseable frontmatter with a
  // non-empty `type`, and each absolute link must resolve inside the bundle.
  const generatedPaths = new Set(plan.keys());
  for (const file of walkMarkdown(bundleDir)) {
    const relativePath = relative(bundleDir, file).split(sep).join('/');
    if (generatedPaths.has(relativePath)) continue;
    const text = readFileSync(file, 'utf8');
    const parsed = parsePage(text);
    const reserved = /(^|\/)(index|log)\.md$/.test(relativePath);
    if (parsed.error) {
      issues.push({
        code: 'okf-frontmatter-invalid',
        file: display(relativePath),
        message: `Frontmatter does not parse: ${parsed.error}`,
      });
    } else if (!reserved) {
      const type = parsed.frontmatter?.type;
      if (typeof type !== 'string' || type.trim() === '') {
        issues.push({
          code: 'okf-frontmatter-invalid',
          file: display(relativePath),
          message: parsed.frontmatter
            ? 'Frontmatter `type` is missing or empty.'
            : 'Concept page has no frontmatter block (`type` is required).',
        });
      }
    }
    for (const target of new Set(extractAbsoluteLinks(text))) {
      if (!existsSync(join(bundleDir, target))) {
        issues.push({
          code: 'okf-dangling-link',
          file: display(relativePath),
          message: `Link ${target} does not resolve to a concept page in ${BUNDLE_RELATIVE_DIR}/${target.startsWith('/components/') ? ' (no such workspace package)' : ''}.`,
        });
      }
    }
  }
  return issues;
}
