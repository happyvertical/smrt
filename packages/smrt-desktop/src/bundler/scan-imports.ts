import { APP_ROOT } from './graph.js';
import {
  type FilterDecision,
  nodeTreeFs,
  readRegularFile,
  resolveInside,
  type TreeFs,
  walkTree,
} from './paths.js';
import { locatePackage } from './prune.js';
import { BundleTreeError } from './tree-errors.js';

/**
 * Conservative import-specifier scan (design 4.3).
 *
 * Removing a hard dependency is only safe if nothing that stays loads it. The
 * scan reads the JavaScript of the kept application build and kept packages
 * and finds every string-literal specifier in `import ... from`,
 * `export ... from`, `import 'x'`, `import('x')`, `require('x')`,
 * `require.resolve('x')` and `import.meta.resolve('x')`. Each specifier is
 * resolved the way Node would resolve it from the importing file; if it lands
 * on a removed package the scan reports it:
 * - `static`: `import`/`export ... from` and a `require` at the top level of
 *   a module. The product would crash at load. Not acknowledgeable.
 * - `dynamic`: `import()`, `require` inside a function, block or call, and
 *   `*.resolve`. Allowed only when the product lists the importing file and
 *   specifier in `acknowledgedDynamicImports`, which is recorded verbatim.
 *
 * It is a heuristic over a small hand-written lexer (comments, strings,
 * templates, regex literals, brace depth), not a parser. It cannot see
 * non-literal specifiers (`import(name)`, `require(path)`); those are
 * reported in `nonLiteral` and remain a residual risk covered by the host
 * smoke start. `.svelte`, `.ts` and JSON files are not scanned. Files above
 * the size cap or that fail to read are listed in `unscanned`.
 */

export type ImportKind = 'static' | 'dynamic' | 'require' | 'resolve';

export interface ImportRef {
  readonly specifier: string;
  readonly kind: ImportKind;
  /** True when the reference is not executed at module load. */
  readonly lazy: boolean;
  readonly line: number;
}

export interface NonLiteralRef {
  readonly via: 'import' | 'require';
  readonly line: number;
}

export interface ExtractResult {
  readonly refs: readonly ImportRef[];
  readonly nonLiteral: readonly NonLiteralRef[];
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenType = 'id' | 'str' | 'tmpl' | 'p';

interface Token {
  readonly t: TokenType;
  readonly v: string;
  readonly line: number;
  /** Executed lazily: inside braces or parentheses, or after an arrow. */
  readonly lazy: boolean;
}

const REGEX_AFTER_PUNCT: ReadonlySet<string> = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
  '~',
  '^',
  '=>',
]);
const REGEX_AFTER_WORD: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

/** Words that start a new top-level statement (ends an arrow body). */
const STATEMENT_WORDS: ReadonlySet<string> = new Set([
  'const',
  'let',
  'var',
  'import',
  'export',
  'class',
  'function',
]);

function isIdentChar(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95 ||
    code === 36 ||
    code > 127
  );
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const length = source.length;
  let i = 0;
  let line = 1;
  let brace = 0;
  let paren = 0;
  let arrow = false;
  const templates: number[] = [];

  const lazyNow = () => brace > 0 || paren > 0 || arrow;
  const push = (t: TokenType, v: string) => {
    tokens.push({ t, v, line, lazy: lazyNow() });
  };

  /** Scan template characters from `i`; returns text and whether it ended. */
  const templateBody = (): { text: string; ended: boolean } => {
    let text = '';
    while (i < length) {
      const ch = source[i] as string;
      if (ch === '\\') {
        text += source[i + 1] ?? '';
        if (source[i + 1] === '\n') line++;
        i += 2;
      } else if (ch === '`') {
        i++;
        return { text, ended: true };
      } else if (ch === '$' && source[i + 1] === '{') {
        i += 2;
        return { text, ended: false };
      } else {
        if (ch === '\n') line++;
        text += ch;
        i++;
      }
    }
    return { text, ended: true };
  };

  const startTemplate = () => {
    const first = templateBody();
    if (first.ended) {
      push('str', first.text);
      return;
    }
    push('tmpl', '`');
    templates.push(brace);
    brace++;
  };

  if (source.startsWith('#!')) {
    while (i < length && source[i] !== '\n') i++;
  }

  while (i < length) {
    const ch = source[i] as string;
    const code = source.charCodeAt(i);

    if (ch === '\n') {
      line++;
      i++;
    } else if (code <= 32 || code === 0xa0 || code === 0xfeff) {
      i++;
    } else if (ch === '/' && source[i + 1] === '/') {
      while (i < length && source[i] !== '\n') i++;
    } else if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i += 2;
    } else if (ch === '"' || ch === "'") {
      let text = '';
      i++;
      while (i < length && source[i] !== ch && source[i] !== '\n') {
        if (source[i] === '\\') {
          text += source[i + 1] ?? '';
          if (source[i + 1] === '\n') line++;
          i += 2;
        } else {
          text += source[i];
          i++;
        }
      }
      i++;
      push('str', text);
    } else if (ch === '`') {
      i++;
      startTemplate();
    } else if (ch === '/') {
      const last = tokens[tokens.length - 1];
      const regexAllowed =
        last === undefined ||
        (last.t === 'p' && REGEX_AFTER_PUNCT.has(last.v)) ||
        (last.t === 'id' && REGEX_AFTER_WORD.has(last.v));
      let end = -1;
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        while (j < length && source[j] !== '\n') {
          const c = source[j] as string;
          if (c === '\\') j++;
          else if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) {
            end = j;
            break;
          }
          j++;
        }
      }
      if (end === -1) {
        push('p', '/');
        i++;
      } else {
        i = end + 1;
        while (i < length && isIdentChar(source.charCodeAt(i))) i++;
        // A regex literal is an operand: a following `/` is a division.
        push('id', '/re/');
      }
    } else if (isIdentChar(code)) {
      const start = i;
      while (i < length && isIdentChar(source.charCodeAt(i))) i++;
      const word = source.slice(start, i);
      if (brace === 0 && paren === 0 && STATEMENT_WORDS.has(word)) {
        arrow = false;
      }
      push('id', word);
    } else if (ch === '=' && source[i + 1] === '>') {
      push('p', '=>');
      arrow = true;
      i += 2;
    } else {
      if (ch === '{') brace++;
      else if (ch === '(') paren++;
      else if (ch === ')') paren = Math.max(0, paren - 1);
      else if (ch === '}') {
        brace = Math.max(0, brace - 1);
        if (templates.length > 0 && templates[templates.length - 1] === brace) {
          templates.pop();
          i++;
          const next = templateBody();
          if (!next.ended) {
            templates.push(brace);
            brace++;
          }
          continue;
        }
      } else if (ch === ';' && brace === 0) arrow = false;
      push('p', ch);
      i++;
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** Extract literal specifiers and non-literal dynamic loads from `source`. */
export function extractImports(source: string): ExtractResult {
  const tokens = lex(source);
  const refs: ImportRef[] = [];
  const nonLiteral: NonLiteralRef[] = [];
  const seen = new Set<string>();
  const add = (ref: ImportRef) => {
    const key = `${ref.kind}\0${ref.specifier}\0${ref.lazy}`;
    if (!seen.has(key)) {
      seen.add(key);
      refs.push(ref);
    }
  };
  const at = (k: number) => tokens[k];
  const isP = (k: number, v: string) => {
    const token = at(k);
    return token !== undefined && token.t === 'p' && token.v === v;
  };
  const isId = (k: number, v: string) => {
    const token = at(k);
    return token !== undefined && token.t === 'id' && token.v === v;
  };

  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k] as Token;
    if (token.t !== 'id') continue;
    const afterDot = isP(k - 1, '.');

    if (token.v === 'from' && !afterDot) {
      const next = at(k + 1);
      if (next?.t === 'str') {
        add({
          specifier: next.v,
          kind: 'static',
          lazy: false,
          line: token.line,
        });
      }
    } else if (token.v === 'import' && !afterDot) {
      const next = at(k + 1);
      if (next?.t === 'str') {
        add({
          specifier: next.v,
          kind: 'static',
          lazy: false,
          line: token.line,
        });
      } else if (isP(k + 1, '(')) {
        const arg = at(k + 2);
        if (arg?.t === 'str' && (isP(k + 3, ')') || isP(k + 3, ','))) {
          add({
            specifier: arg.v,
            kind: 'dynamic',
            lazy: true,
            line: token.line,
          });
        } else {
          nonLiteral.push({ via: 'import', line: token.line });
        }
      } else if (
        isP(k + 1, '.') &&
        isId(k + 2, 'meta') &&
        isP(k + 3, '.') &&
        isId(k + 4, 'resolve') &&
        isP(k + 5, '(')
      ) {
        const arg = at(k + 6);
        if (arg?.t === 'str') {
          add({
            specifier: arg.v,
            kind: 'resolve',
            lazy: true,
            line: token.line,
          });
        } else {
          nonLiteral.push({ via: 'import', line: token.line });
        }
      }
    } else if (token.v === 'require' && !afterDot && !isId(k - 1, 'function')) {
      if (isP(k + 1, '(')) {
        const arg = at(k + 2);
        if (arg?.t === 'str' && isP(k + 3, ')')) {
          add({
            specifier: arg.v,
            kind: token.lazy ? 'require' : 'static',
            lazy: token.lazy,
            line: token.line,
          });
        } else {
          nonLiteral.push({ via: 'require', line: token.line });
        }
      } else if (isP(k + 1, '.') && isId(k + 2, 'resolve') && isP(k + 3, '(')) {
        const arg = at(k + 4);
        if (arg?.t === 'str') {
          add({
            specifier: arg.v,
            kind: 'resolve',
            lazy: true,
            line: token.line,
          });
        }
      }
    }
  }
  return { refs, nonLiteral };
}

/**
 * The package a bare specifier names (`@scope/name` or `name`), or
 * `undefined` for relative, absolute, `node:`, `#imports`, URL and data
 * specifiers.
 */
export function packageNameOf(specifier: string): string | undefined {
  if (
    specifier.length === 0 ||
    specifier.startsWith('.') ||
    specifier.startsWith('/') ||
    specifier.startsWith('#') ||
    specifier.startsWith('node:') ||
    /^[a-z][a-z0-9+.-]*:/i.test(specifier)
  ) {
    return undefined;
  }
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return parts.length >= 2 && parts[1] !== ''
      ? `${parts[0]}/${parts[1]}`
      : undefined;
  }
  return parts[0] === '' ? undefined : parts[0];
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export interface AcknowledgedImport {
  /**
   * The importing file: a package name (`ws`) for kept packages, or the
   * `app/build/...` path (or a directory prefix of it) for the application.
   */
  readonly from: string;
  /** The specifier, or the package name it belongs to. */
  readonly specifier: string;
}

export interface ScanSource {
  /** `APP_ROOT` or the package id (`node_modules/a/node_modules/b`). */
  readonly owner: string;
  /** Display path (bundle-relative). */
  readonly path: string;
  /** Value an `AcknowledgedImport.from` is compared against. */
  readonly from: string;
  readonly text: string;
}

export interface ImportFinding {
  readonly path: string;
  readonly package: string;
  readonly specifier: string;
  readonly kind: 'static' | 'dynamic';
  readonly line: number;
}

export interface NonLiteralFinding {
  readonly path: string;
  readonly via: 'import' | 'require';
  readonly line: number;
}

export interface ImportScanReport {
  readonly filesScanned: number;
  /** Removed packages loaded at module load (never acknowledgeable). */
  readonly static: readonly ImportFinding[];
  /** Lazy loads of removed packages that nobody acknowledged. */
  readonly dynamic: readonly ImportFinding[];
  /** Lazy loads of removed packages the product acknowledged. */
  readonly acknowledged: readonly ImportFinding[];
  readonly nonLiteral: readonly NonLiteralFinding[];
  /** Files skipped because they were too large or unreadable. */
  readonly unscanned: readonly string[];
}

function isAcknowledged(
  source: ScanSource,
  finding: ImportFinding,
  acknowledged: readonly AcknowledgedImport[],
): boolean {
  return acknowledged.some(
    (ack) =>
      (ack.specifier === finding.specifier ||
        ack.specifier === finding.package) &&
      (ack.from === source.from || source.from.startsWith(`${ack.from}/`)),
  );
}

/**
 * Analyse in-memory sources. `isRemoved(owner, packageName)` says whether the
 * package, as resolved from the importing file's owner, was removed.
 */
export function analyzeSources(
  sources: Iterable<ScanSource>,
  isRemoved: (owner: string, packageName: string) => boolean,
  acknowledged: readonly AcknowledgedImport[] = [],
  unscanned: readonly string[] = [],
): ImportScanReport {
  const staticFindings: ImportFinding[] = [];
  const dynamicFindings: ImportFinding[] = [];
  const acknowledgedFindings: ImportFinding[] = [];
  const nonLiteral: NonLiteralFinding[] = [];
  let filesScanned = 0;

  for (const source of sources) {
    filesScanned++;
    const { refs, nonLiteral: unknown } = extractImports(source.text);
    for (const item of unknown) {
      nonLiteral.push({ path: source.path, via: item.via, line: item.line });
    }
    for (const ref of refs) {
      const name = packageNameOf(ref.specifier);
      if (name === undefined || !isRemoved(source.owner, name)) continue;
      const finding: ImportFinding = {
        path: source.path,
        package: name,
        specifier: ref.specifier,
        kind: ref.kind === 'static' ? 'static' : 'dynamic',
        line: ref.line,
      };
      if (finding.kind === 'static') staticFindings.push(finding);
      else if (isAcknowledged(source, finding, acknowledged)) {
        acknowledgedFindings.push(finding);
      } else dynamicFindings.push(finding);
    }
  }
  return {
    filesScanned,
    static: staticFindings,
    dynamic: dynamicFindings,
    acknowledged: acknowledgedFindings,
    nonLiteral,
    unscanned: [...unscanned],
  };
}

/**
 * Throw when the report contains a static load of a removed package
 * (`removed_package_imported`) or an unacknowledged lazy one
 * (`dynamic_import_unacknowledged`). Subjects are `path -> package`.
 */
export function assertNoRemovedImports(report: ImportScanReport): void {
  const subjects = (findings: readonly ImportFinding[]) =>
    findings.map((finding) => `${finding.path} -> ${finding.package}`);
  if (report.static.length > 0) {
    throw new BundleTreeError('removed_package_imported', {
      subjects: subjects(report.static),
    });
  }
  if (report.dynamic.length > 0) {
    throw new BundleTreeError('dynamic_import_unacknowledged', {
      subjects: subjects(report.dynamic),
    });
  }
}

// ---------------------------------------------------------------------------
// Scanning a directory
// ---------------------------------------------------------------------------

const SCRIPT_FILE = /\.(?:m?js|cjs)$/i;

export interface ScanDirectoryOptions {
  /** Absolute root of the tree to scan (canonical). */
  readonly root: string;
  /**
   * `app-build`: files belong to the application (`app/build/<rel>`).
   * `node-modules`: `root` is a `node_modules` directory; each file belongs
   * to its innermost package.
   */
  readonly kind: 'app-build' | 'node-modules';
  readonly isRemoved: (owner: string, packageName: string) => boolean;
  readonly acknowledged?: readonly AcknowledgedImport[];
  readonly fs?: TreeFs;
  readonly platform?: NodeJS.Platform;
  /** Per-file cap; larger files are listed as unscanned. Default 8 MiB. */
  readonly maxFileBytes?: number;
}

function sourceFor(
  options: ScanDirectoryOptions,
  rel: string,
  text: string,
): ScanSource {
  if (options.kind === 'app-build') {
    const path = `app/build/${rel}`;
    return { owner: APP_ROOT, path, from: path, text };
  }
  const located = locatePackage(rel.split('/'));
  if (located === undefined) {
    return { owner: APP_ROOT, path: `node_modules/${rel}`, from: rel, text };
  }
  const marker = located.packageDir.split('/');
  const nameSegments = located.packageDir
    .split('/')
    .slice(marker.lastIndexOf('node_modules') + 1);
  return {
    owner: `node_modules/${located.packageDir}`,
    path: `node_modules/${rel}`,
    from: nameSegments.join('/'),
    text,
  };
}

/** Scan the JavaScript files under a directory (see `ScanDirectoryOptions`). */
export async function scanDirectory(
  options: ScanDirectoryOptions,
): Promise<ImportScanReport> {
  const fs = options.fs ?? nodeTreeFs;
  const platform = options.platform ?? process.platform;
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
  const unscanned: string[] = [];

  const walk = await walkTree({
    root: options.root,
    fs,
    platform,
    filter: (entry): FilterDecision => {
      if (entry.kind !== 'file') return 'keep';
      if (!SCRIPT_FILE.test(entry.name)) return 'skip';
      if (entry.size > maxFileBytes) {
        unscanned.push(entry.rel);
        return 'skip';
      }
      return 'keep';
    },
    limits: { maxFileBytes },
  });

  const sources: ScanSource[] = [];
  for (const entry of walk.entries) {
    if (entry.kind !== 'file') continue;
    try {
      const bytes = await readRegularFile(
        resolveInside(options.root, entry.rel.split('/'), platform),
        maxFileBytes,
        { fs },
      );
      sources.push(
        sourceFor(options, entry.rel, Buffer.from(bytes).toString('utf8')),
      );
    } catch {
      unscanned.push(entry.rel);
    }
  }
  return analyzeSources(
    sources,
    options.isRemoved,
    options.acknowledged ?? [],
    unscanned.sort(),
  );
}
