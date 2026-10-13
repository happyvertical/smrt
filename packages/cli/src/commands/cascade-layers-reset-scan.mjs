/**
 * Unlayered universal-reset scanner for `smrt doctor` (#3862).
 *
 * Unlayered CSS beats every `@layer` regardless of specificity. A host's
 * unlayered `*, *::before, *::after { margin: 0; padding: 0 }` (or Tailwind
 * preflight / normalize.css / sanitize.css imported without a layer) therefore
 * strips padding from every smrt component, whose rules sit in `smrt.theme`.
 *
 * Dependency-free ESM so the monorepo lint gate
 * (`scripts/check-smrt-cascade-layers.mjs`) can run the same code under plain
 * `node`. Parsing is deliberately small: comments and string literals are
 * skipped, `@layer` blocks are tracked by brace depth, and only style rules
 * and `@import` statements outside any layer are reported.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const SMRT_PACKAGES = ['@happyvertical/smrt-ui', '@happyvertical/smrt-svelte'];

export const RESET_RECIPE =
  'wrap the reset in @layer smrt.reset { … }, or import it with @import url(...) layer(smrt.reset); ' +
  'see packages/smrt-ui/agents/styling.md#cascade-layers';

const UNIVERSAL_SELECTOR = /^(\*(::(before|after|backdrop|marker|placeholder))?|html|body)$/;
const RESET_DECLARATION = /^(margin|padding)(?:-[a-z-]+)?\s*:\s*0(?:px|rem|em|%)?(?=[\s!;]|$)/i;
const RESET_IMPORT_NAME = /normalize|sanitize|reset|preflight/i;

/**
 * Replace comments with spaces (newlines kept so line numbers stay true),
 * leaving string literals such as `content: "/* x *\/"` untouched.
 *
 * @param {string} css
 * @returns {string}
 */
export function stripCssComments(css) {
  let out = '';
  let quote = null;
  for (let i = 0; i < css.length; i += 1) {
    const c = css[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < css.length) {
        out += css[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end === -1 ? css.length : end + 2;
      out += css.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** 1-based line number of the character at `index`. */
function lineAt(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Find unlayered universal resets and unlayered reset `@import`s in a
 * stylesheet. Rules inside any `@layer` block (including `@layer smrt.*` and
 * Tailwind's `@layer base`) are never reported.
 *
 * @param {string} css
 * @returns {Array<{ line: number, kind: 'rule' | 'import', selector: string, detail: string }>}
 */
export function findUnlayeredResets(css) {
  const src = stripCssComments(css);
  const findings = [];
  /** @type {Array<{ kind: 'layer' | 'rule' | 'group', head: string, headLine: number, decls: string[] }>} */
  const stack = [];
  let prelude = '';
  let preludeStart = -1;
  let quote = null;

  const flushDecl = () => {
    const text = prelude.trim();
    const frame = stack[stack.length - 1];
    if (text && frame && frame.kind === 'rule') frame.decls.push(text);
    prelude = '';
    preludeStart = -1;
  };

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quote) {
      prelude += c;
      if (c === '\\' && i + 1 < src.length) {
        prelude += src[i + 1];
        i += 1;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      if (preludeStart === -1) preludeStart = i;
      prelude += c;
      continue;
    }
    if (c === '{') {
      const head = prelude.trim();
      const headIndex = preludeStart === -1 ? i : preludeStart;
      let kind = 'rule';
      if (/^@layer\b/i.test(head)) kind = 'layer';
      else if (head.startsWith('@')) kind = 'group';
      stack.push({ kind, head, headLine: lineAt(src, headIndex), decls: [] });
      prelude = '';
      preludeStart = -1;
      continue;
    }
    if (c === '}') {
      flushDecl();
      const frame = stack.pop();
      if (frame && frame.kind === 'rule' && !stack.some((f) => f.kind === 'layer')) {
        const universal = frame.head
          .split(',')
          .map((selector) => selector.trim())
          .filter((selector) => UNIVERSAL_SELECTOR.test(selector));
        const resetDecls = frame.decls.filter((decl) => RESET_DECLARATION.test(decl));
        if (universal.length > 0 && resetDecls.length > 0) {
          findings.push({
            line: frame.headLine,
            kind: 'rule',
            selector: frame.head,
            detail: resetDecls.join('; '),
          });
        }
      }
      continue;
    }
    if (c === ';') {
      const head = prelude.trim();
      if (stack.length === 0 && /^@import\b/i.test(head)) {
        const layered = /\blayer\s*\(/i.test(head);
        const url = head.match(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/i);
        if (!layered && url && RESET_IMPORT_NAME.test(url[1])) {
          findings.push({
            line: lineAt(src, preludeStart === -1 ? i : preludeStart),
            kind: 'import',
            selector: head,
            detail: `unlayered import of ${url[1]}`,
          });
        }
      }
      flushDecl();
      continue;
    }
    if (preludeStart === -1 && !/\s/.test(c)) preludeStart = i;
    prelude += c;
  }
  return findings;
}

/**
 * Svelte `<style>` bodies, with findings mapped to the `.svelte` file's lines.
 *
 * @param {string} source
 * @returns {Array<{ line: number, kind: 'rule' | 'import', selector: string, detail: string }>}
 */
export function findUnlayeredResetsInSvelte(source) {
  const findings = [];
  const pattern = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const bodyStart = match.index + match[0].indexOf('>') + 1;
    for (const finding of findUnlayeredResets(match[1])) {
      findings.push({ ...finding, line: lineAt(source, bodyStart) + finding.line - 1 });
    }
  }
  return findings;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.svelte-kit', '.git', 'build', '.turbo']);

/**
 * Project CSS sources: `src/**` `*.css` and `*.svelte`, plus a root `app.css`.
 *
 * @param {string} root
 * @returns {string[]} absolute paths
 */
export function listCascadeSources(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && /\.(css|svelte)$/.test(entry.name)) {
        files.push(join(dir, entry.name));
      }
    }
  };
  const src = join(root, 'src');
  if (existsSync(src) && statSync(src).isDirectory()) walk(src);
  const rootCss = join(root, 'app.css');
  if (existsSync(rootCss) && !files.includes(rootCss)) files.push(rootCss);
  return files;
}

/**
 * Whether a project's package.json depends on smrt-ui or smrt-svelte.
 *
 * @param {Record<string, any> | null | undefined} packageJson
 * @returns {boolean}
 */
export function dependsOnSmrtUi(packageJson) {
  const sections = ['dependencies', 'devDependencies', 'peerDependencies'];
  return sections.some((section) =>
    SMRT_PACKAGES.some((name) => Boolean(packageJson?.[section]?.[name])),
  );
}

/**
 * Scan a project root for unlayered universal resets.
 *
 * @param {string} root project directory
 * @param {{ packageJson?: Record<string, any> | null, requireSmrtDependency?: boolean }} [options]
 *   `requireSmrtDependency` (default true) skips projects that do not depend on
 *   smrt-ui/smrt-svelte. Monorepo passes set it to false.
 * @returns {{
 *   applies: boolean,
 *   filesScanned: number,
 *   findings: Array<{ file: string, line: number, kind: 'rule' | 'import', selector: string, detail: string }>,
 * }}
 */
export function scanProjectForUnlayeredResets(root, options = {}) {
  const requireDependency = options.requireSmrtDependency !== false;
  const applies = !requireDependency || dependsOnSmrtUi(options.packageJson);
  if (!applies) return { applies, filesScanned: 0, findings: [] };
  const files = listCascadeSources(root);
  const findings = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const found = file.endsWith('.svelte')
      ? findUnlayeredResetsInSvelte(text)
      : findUnlayeredResets(text);
    for (const finding of found) {
      findings.push({ file: relative(root, file), ...finding });
    }
  }
  return { applies, filesScanned: files.length, findings };
}
