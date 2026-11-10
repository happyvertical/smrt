/**
 * Table-driven hand-rolled-equivalent detector (#4690).
 *
 * The engine knows signal *kinds* (`import`, `call`, `regex`, `decimal-field`),
 * never intents: every rule comes from a parsed intent-index row. A new row
 * with signals therefore needs no code change here. Tokens of an unknown kind
 * are skipped with a note so an index that is newer than this tool degrades
 * instead of failing.
 */

import type { IntentRow, IntentSignal } from './intent-index.js';

export interface DetectorFile {
  /** Path relative to the reviewed project root. */
  relativePath: string;
  content: string;
  /** Normalised package specifiers imported by the file. */
  imports: string[];
}

export interface DetectorPackage {
  name?: string;
  relativePath: string;
  /** Home packages of any row that resolve in package.json or node_modules. */
  installed: ReadonlySet<string>;
  files: DetectorFile[];
}

export interface SignalEvidence {
  filePath: string;
  line: number;
  signal: string;
  detail: string;
}

export interface HandRolledFinding {
  code: string;
  intent: string;
  intentPage: string;
  componentPages: string[];
  entryPoint: string;
  packageName: string;
  packagePath: string;
  /** Home packages the consumer declares or has installed, yet never imports. */
  installedHomePackages: string[];
  homePackages: string[];
  matchedSignals: string[];
  evidence: SignalEvidence[];
}

export interface DetectOptions {
  /** Receives one human-readable note per skipped signal token. */
  onNote?: (note: string) => void;
  /** Evidence entries kept per finding. */
  maxEvidence?: number;
}

type LineMatcher = (line: string) => boolean;
type SignalCompiler = (
  signal: IntentSignal,
) => { matchLine: LineMatcher } | { matchImport: string } | { error: string };

const COMMENT_LINE = /^\s*(\/\/|\/\*|\*|<!--)/;

function normalizeSpecifier(value: string): string {
  if (value.startsWith('@')) {
    const [scope, name] = value.split('/');
    return scope && name ? `${scope}/${name}` : value;
  }
  return value.split('/')[0];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `*_cents`-style glob (`*` = any run) -> case-insensitive anchored regex. */
function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split('*')
    .map((part) => escapeRegExp(part))
    .join('.*');
  return new RegExp(`^${pattern}$`, 'i');
}

function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

const DECIMAL_PROPERTY =
  /^\s*(?:(?:public|private|protected|readonly|static)\s+)*(\w+)\s*(?::\s*number\s*)?=\s*-?\d+\.\d+/;
const DECIMAL_TYPED_FIELD =
  /@field\(\s*\{[^}]*type\s*:\s*['"]decimal['"][^}]*\}\s*\)\s*(?:(?:public|private|protected|readonly)\s+)*(\w+)/;

/**
 * Signal grammar. Add a kind here only when an index row cannot be expressed
 * with the existing ones; intents themselves never appear in this file.
 *
 * - `import:<module>`  the module (or a subpath of it) is imported.
 * - `call:<ident>`     `ident(` appears in code.
 * - `regex:<pattern>`  the JavaScript regular expression matches a line.
 * - `decimal-field:<glob>`  a property whose name matches the glob (compared
 *   as written and as snake_case) is declared with a decimal literal
 *   (`= 0.0`) or `@field({ type: 'decimal' })`.
 */
const COMPILERS: Record<string, SignalCompiler> = {
  import: (signal) => ({ matchImport: normalizeSpecifier(signal.value) }),
  call: (signal) => {
    if (!/^[\w$.]+$/.test(signal.value)) {
      return { error: `invalid identifier "${signal.value}"` };
    }
    const pattern = new RegExp(
      `(?<![\\w$])${escapeRegExp(signal.value)}\\s*\\(`,
    );
    return { matchLine: (line) => pattern.test(line) };
  },
  regex: (signal) => {
    try {
      const pattern = new RegExp(signal.value);
      return { matchLine: (line) => pattern.test(line) };
    } catch (error) {
      return {
        error: `invalid regular expression (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  },
  'decimal-field': (signal) => {
    const glob = globToRegExp(signal.value);
    const matches = (name: string | undefined) =>
      !!name && (glob.test(name) || glob.test(camelToSnake(name)));
    return {
      matchLine: (line) =>
        matches(DECIMAL_PROPERTY.exec(line)?.[1]) ||
        matches(DECIMAL_TYPED_FIELD.exec(line)?.[1]),
    };
  },
};

export const SUPPORTED_SIGNAL_KINDS = Object.keys(COMPILERS);

interface CompiledSignal {
  raw: string;
  matchLine?: LineMatcher;
  matchImport?: string;
}

function compileRow(
  row: IntentRow,
  noted: Set<string>,
  onNote: (note: string) => void,
): CompiledSignal[] {
  const compiled: CompiledSignal[] = [];
  for (const signal of row.signals) {
    const compiler = COMPILERS[signal.kind];
    const skip = (reason: string) => {
      const key = `${row.intentPage}\0${signal.raw}`;
      if (noted.has(key)) return;
      noted.add(key);
      onNote(
        `intent index: skipping signal \`${signal.raw}\` for ${row.intentPage} (${reason})`,
      );
    };
    if (!compiler) {
      skip(`unknown signal kind "${signal.kind}"`);
      continue;
    }
    const result = compiler(signal);
    if ('error' in result) skip(result.error);
    else compiled.push({ raw: signal.raw, ...result });
  }
  return compiled;
}

function importLine(file: DetectorFile, specifier: string): number {
  const lines = file.content.split('\n');
  const pattern = new RegExp(`['"]${escapeRegExp(specifier)}(?:/[^'"]*)?['"]`);
  const index = lines.findIndex(
    (line) => !COMMENT_LINE.test(line) && pattern.test(line),
  );
  return index < 0 ? 1 : index + 1;
}

/**
 * For every (intent row, package) where a signal is present and the package
 * imports none of the row's home packages, emit one finding.
 */
export function detectHandRolled(
  rows: readonly IntentRow[],
  packages: readonly DetectorPackage[],
  options: DetectOptions = {},
): HandRolledFinding[] {
  const onNote = options.onNote ?? (() => undefined);
  const maxEvidence = options.maxEvidence ?? 6;
  const noted = new Set<string>();
  const findings: HandRolledFinding[] = [];

  for (const row of rows) {
    const signals = compileRow(row, noted, onNote);
    if (signals.length === 0 || row.homePackages.length === 0) continue;
    const homeNames = row.homePackages.map((home) => home.packageName);

    for (const pkg of packages) {
      if (pkg.name && homeNames.includes(pkg.name)) continue;
      const importsHome = pkg.files.some((file) =>
        file.imports.some((specifier) => homeNames.includes(specifier)),
      );
      if (importsHome) continue;

      const evidence: SignalEvidence[] = [];
      const matched = new Set<string>();
      for (const file of pkg.files) {
        for (const signal of signals) {
          if (signal.matchImport !== undefined) {
            if (!file.imports.includes(signal.matchImport)) continue;
            matched.add(signal.raw);
            evidence.push({
              filePath: file.relativePath,
              line: importLine(file, signal.matchImport),
              signal: signal.raw,
              detail: `Imports ${signal.matchImport}`,
            });
          } else if (signal.matchLine) {
            const lines = file.content.split('\n');
            for (let index = 0; index < lines.length; index += 1) {
              if (COMMENT_LINE.test(lines[index])) continue;
              if (!signal.matchLine(lines[index])) continue;
              matched.add(signal.raw);
              evidence.push({
                filePath: file.relativePath,
                line: index + 1,
                signal: signal.raw,
                detail: `Matches ${signal.raw}`,
              });
              break; // first hit per signal per file
            }
          }
        }
      }
      if (evidence.length === 0) continue;

      evidence.sort(
        (left, right) =>
          left.filePath.localeCompare(right.filePath) || left.line - right.line,
      );
      findings.push({
        code: `hand-rolled-${row.intentPage.replace(/^\/intents\//, '').replace(/\.md$/, '')}`,
        intent: row.intent,
        intentPage: row.intentPage,
        componentPages: row.homePackages.map((home) => home.componentPage),
        entryPoint: row.entryPoint,
        packageName: pkg.name ?? pkg.relativePath,
        packagePath: pkg.relativePath,
        installedHomePackages: homeNames.filter((name) =>
          pkg.installed.has(name),
        ),
        homePackages: homeNames,
        matchedSignals: Array.from(matched),
        evidence: evidence.slice(0, maxEvidence),
      });
    }
  }
  return findings;
}
