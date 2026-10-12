#!/usr/bin/env node
/**
 * Component root hooks: `data-smrt-component` on the root element(s) of every
 * exported Svelte component.
 *
 *   node scripts/component-roots.mjs --report   classify exported components (no writes)
 *   node scripts/component-roots.mjs --write    codemod: add the hook to root elements (idempotent)
 *   node scripts/component-roots.mjs --check    lint gate: fail if a root element lacks its hook
 *
 * Definitions:
 *   - Exported: reachable from a package.json `exports`/`main` entry through
 *     `export … from` statements (see exportedComponents()).
 *   - Root elements: elements in the component's template that are not nested
 *     inside another element. Elements inside `{#if}`, `{#each}`, `{#key}` and
 *     `{#await}` branches count; snippets and child-component slot content do not.
 *   - Hook value: the component's file basename (no package prefix).
 *   - Placement: after the element's last attribute, so a `{...rest}` spread
 *     earlier in the tag cannot override the component's own value. A consumer
 *     `data-smrt-component` passed through `rest` is therefore overridden by the
 *     component. Explicit `NO_ROOT_ELEMENT` entries are the only exceptions.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK = 'data-smrt-component';

/**
 * Exported components whose template has no root element of their own: the
 * rendered root belongs to a child component, or the template renders nothing.
 * Keyed by repo-relative path; the reason is mandatory and reviewed.
 */
const CHILD = 'wrapper: template is one child component, whose root element carries the child hook';
const SLOT = 'renders slot/snippet content only; no element of its own';
const NONE = 'template renders no DOM of its own';
export const NO_ROOT_ELEMENT = {
  'packages/smrt-ui/src/i18n/Trans.svelte': 'renders text/expression only; no element of its own',
  'packages/smrt-ui/src/components/forms/CountrySelect.svelte': CHILD,
  'packages/smrt-ui/src/components/forms/CurrencySelect.svelte': CHILD,
  'packages/smrt-ui/src/components/forms/ProvinceSelect.svelte': CHILD,
  'packages/smrt-ui/src/components/feedback/Drawer.svelte': CHILD,
  'packages/smrt-ui/src/components/permissions/PermissionCheck.svelte': SLOT,
  'packages/smrt-svelte/src/components/app/RuntimeDiagnosticsWebMcp.svelte': NONE,
  'packages/smrt-svelte/src/components/workspace/admin-shell/ActivityBadge.svelte': CHILD,
  'packages/smrt-svelte/src/components/workspace/admin-shell/ShellDockTool.svelte': NONE,
  'packages/smrt-svelte/src/components/cookbook/CookbookApp.svelte': CHILD,
  'packages/smrt-svelte/src/components/command-palette/CommandPalette.svelte': CHILD,
  'packages/smrt-svelte/src/Provider.svelte': SLOT,
  'packages/ingestion/src/svelte/components/IntakeInbox.svelte': CHILD,
  'packages/ingestion/src/svelte/components/IntakeReview.svelte': CHILD,
  'packages/commerce/src/svelte/components/CustomerSelect.svelte': CHILD,
  'packages/commerce/src/svelte/components/VendorSelect.svelte': CHILD,
  'packages/chat/src/svelte/components/shared/Avatar.svelte': CHILD,
  'packages/chat/src/svelte/components/shared/ReactionPicker.svelte': CHILD,
  'packages/smrt-svelte/src/browser-ai/svelte/components/AILoadingOverlay.svelte': CHILD,
  'packages/smrt-svelte/src/browser-ai/svelte/components/CapabilityGate.svelte': SLOT,
  'packages/projects/src/svelte/ProjectBoard.svelte': CHILD,
  'packages/jobs/src/svelte/components/JobStatusBadge.svelte': CHILD,
  'packages/fields/src/svelte/components/AdvancedFields.svelte': CHILD,
  'packages/fields/src/svelte/components/FieldPolicyProvider.svelte': SLOT,
  'packages/fields/src/svelte/components/ModeSwitch.svelte': CHILD,
  'packages/fields/src/svelte/components/ObjectFormSourceProvider.svelte': SLOT,
  'packages/content/src/svelte/components/ContentGovernanceTool.svelte': CHILD,
  'packages/agents/src/svelte/components/ScheduleStatusBadge.svelte': CHILD,
};

const requireFromUi = createRequire(join(ROOT, 'packages/smrt-ui/package.json'));
const { parse } = requireFromUi('svelte/compiler');

function listPackages() {
  const dir = join(ROOT, 'packages');
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((p) => existsSync(join(p, 'package.json')) && existsSync(join(p, 'src')));
}

function exportTargets(pkgDir) {
  const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  const targets = new Set();
  const visit = (value) => {
    if (typeof value === 'string') targets.add(value);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(pkg.exports);
  for (const field of ['main', 'module', 'svelte']) if (pkg[field]) targets.add(pkg[field]);
  const sources = new Set();
  for (const t of targets) {
    if (!t.startsWith('./dist/')) continue;
    const rel = t.slice('./dist/'.length).replace(/\.(d\.ts|js)$/, '');
    for (const ext of ['.ts', '.js']) {
      const candidate = join(pkgDir, 'src', rel + ext);
      if (existsSync(candidate)) sources.add(candidate);
    }
    const idx = join(pkgDir, 'src', rel, 'index.ts');
    if (existsSync(idx)) sources.add(idx);
  }
  return [...sources];
}

const EXPORT_FROM = /export\s*(?:\*|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/g;

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  if (base.endsWith('.svelte')) return { kind: 'svelte', path: base };
  const stripped = base.replace(/\.(js|ts)$/, '');
  for (const cand of [stripped + '.ts', stripped + '.js', join(stripped, 'index.ts')]) {
    if (existsSync(cand) && statSync(cand).isFile()) return { kind: 'ts', path: cand };
  }
  return null;
}

/** Map of absolute .svelte path -> component name (basename). */
export function exportedComponents() {
  const found = new Map();
  const seen = new Set();
  const queue = listPackages().flatMap(exportTargets);
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(EXPORT_FROM)) {
      const hit = resolveSpecifier(file, m[1]);
      if (!hit) continue;
      if (hit.kind === 'svelte') found.set(hit.path, basename(hit.path, '.svelte'));
      else queue.push(hit.path);
    }
    // Import-then-export: `import X from './X.svelte'; export { X };`
    const reexported = localExportNames(text);
    for (const m of text.matchAll(SVELTE_DEFAULT_IMPORT)) {
      if (!reexported.has(m[1])) continue;
      const hit = resolveSpecifier(file, m[2]);
      if (hit?.kind === 'svelte') found.set(hit.path, basename(hit.path, '.svelte'));
    }
  }
  return found;
}

const SVELTE_DEFAULT_IMPORT = /import\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+\.svelte)['"]/g;
const LOCAL_EXPORT_LIST = /export\s*\{([^}]*)\}(?!\s*from)/g;

/** Local names listed in `export { a, b as c }` (no `from`); `a` and `b` are the local names. */
function localExportNames(text) {
  const names = new Set();
  for (const m of text.matchAll(LOCAL_EXPORT_LIST)) {
    for (const part of m[1].split(',')) {
      const local = part.trim().split(/\s+as\s+/)[0].trim();
      if (local) names.add(local);
    }
  }
  return names;
}

/**
 * Control-flow blocks, and the slot content a root-level child component is
 * given (its elements are authored here and render inside the wrapper), pass
 * root-ness through. Snippet bodies are not rendered at the root and do not.
 */
const BLOCK_FRAGMENTS = {
  Component: ['fragment'],
  SvelteComponent: ['fragment'],
  IfBlock: ['consequent', 'alternate'],
  EachBlock: ['body', 'fallback'],
  KeyBlock: ['fragment'],
  AwaitBlock: ['pending', 'then', 'catch'],
};

/** Elements rendered at the component's root (not nested in another element). */
export function rootElements(fragment) {
  const out = [];
  // Local snippets: a root-level {@render name()} renders the snippet's body at the root.
  const snippets = new Map();
  for (const node of fragment.nodes ?? []) {
    if (node.type === 'SnippetBlock') snippets.set(node.expression.name, node.body);
  }
  const rendering = new Set();
  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (node.type === 'RegularElement' || node.type === 'SvelteElement') {
        if (!out.includes(node)) out.push(node);
        continue;
      }
      if (node.type === 'RenderTag') {
        const name = node.expression?.callee?.name;
        if (snippets.has(name) && !rendering.has(name)) {
          rendering.add(name);
          walk(snippets.get(name).nodes);
          rendering.delete(name);
        }
        continue;
      }
      for (const key of BLOCK_FRAGMENTS[node.type] ?? []) {
        const child = node[key];
        if (child && Array.isArray(child.nodes)) walk(child.nodes);
      }
    }
  };
  walk(fragment.nodes);
  return out;
}

/** Root elements of a component's source text (exported for tests). */
export function rootsOf(source) {
  return rootElements(parse(source, { modern: true }).fragment);
}

/** Hook value on an element, or undefined when absent. Dynamic values yield null. */
export function hookOf(element) {
  const attr = element.attributes.find((a) => a.type === 'Attribute' && a.name === HOOK);
  if (!attr) return undefined;
  if (attr.value === true) return '';
  if (Array.isArray(attr.value) && attr.value.every((v) => v.type === 'Text')) {
    return attr.value.map((v) => v.data).join('');
  }
  return null;
}

/** Insertion offset for a new attribute: after the last attribute, else after the tag name. */
function insertionOffset(element) {
  if (element.attributes.length > 0) return element.attributes.at(-1).end;
  const name = element.type === 'SvelteElement' ? 'svelte:element' : element.name;
  return element.start + 1 + name.length;
}

function parseComponent(file) {
  return parse(readFileSync(file, 'utf8'), { modern: true });
}

/** Lint: { file, name, problems[] } for every exported component. */
export function checkAll() {
  const results = [];
  for (const [file, name] of exportedComponents()) {
    const rel = relative(ROOT, file);
    if (!existsSync(file)) {
      results.push({ rel, name, problems: [], generated: true });
      continue;
    }
    const roots = rootElements(parseComponent(file).fragment);
    const problems = [];
    if (roots.length === 0 && !(rel in NO_ROOT_ELEMENT)) {
      problems.push(`no root element and not in NO_ROOT_ELEMENT`);
    }
    for (const el of roots) {
      const value = hookOf(el);
      if (value !== name) {
        problems.push(`line ${el.start}: <${el.name ?? 'svelte:element'}> ${HOOK}=${value === undefined ? 'missing' : JSON.stringify(value)} (want "${name}")`);
      }
    }
    results.push({ rel, name, roots: roots.length, problems });
  }
  return results;
}

function report() {
  return checkAll().map((r) => `${r.generated ? 'generated-missing' : r.roots === 0 ? 'no-root' : `roots=${r.roots}`}\t${r.rel}\t${r.problems.join('; ')}`);
}

function writeHooks() {
  const results = [];
  for (const [file, name] of exportedComponents()) {
    if (!existsSync(file)) continue;
    const roots = rootElements(parseComponent(file).fragment);
    const edits = [];
    for (const el of roots) {
      const value = hookOf(el);
      if (value === name) continue; // idempotent
      if (value !== undefined) {
        results.push({ file: relative(ROOT, file), conflict: `existing ${HOOK}=${JSON.stringify(value)}` });
        continue;
      }
      edits.push({ at: insertionOffset(el), text: ` ${HOOK}="${name}"` });
    }
    if (edits.length === 0) continue;
    let text = readFileSync(file, 'utf8');
    for (const e of edits.sort((a, b) => b.at - a.at)) {
      text = text.slice(0, e.at) + e.text + text.slice(e.at);
    }
    writeFileSync(file, text);
    results.push({ file: relative(ROOT, file), edited: edits.length });
  }
  return results;
}

function main(mode) {
  if (mode === '--report') {
    console.log(report().join('\n'));
  } else if (mode === '--write') {
    console.log(JSON.stringify(writeHooks(), null, 2));
  } else if (mode === '--check') {
    const failing = checkAll().filter((r) => r.problems.length > 0);
    for (const r of failing) for (const p of r.problems) console.error(`${r.rel}: ${p}`);
    if (failing.length) {
      console.error(`\n${failing.length} exported component(s) fail the ${HOOK} root gate.`);
      process.exit(1);
    }
    console.log(`All exported components carry ${HOOK} on their root element(s).`);
  } else {
    console.error('usage: component-roots.mjs --report | --write | --check');
    process.exit(2);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]);
}
