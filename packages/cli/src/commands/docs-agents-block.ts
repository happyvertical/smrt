/**
 * Managed block of `smrt docs:agents` (#4878 item A).
 *
 * Maintains a marker-delimited section in the consumer's `AGENTS.md`, the one
 * file every harness loads, so a fresh agent session knows the knowledge
 * bundle exists without being told.
 *
 * `AGENTS.md` belongs to the user. The invariants, in order of importance:
 *  - only the text from the begin marker through the end marker is ever
 *    replaced; every other byte (BOM, line endings, trailing newline,
 *    hand-written content) survives;
 *  - a damaged marker structure (unpaired, reversed, duplicated) is refused and
 *    nothing is written;
 *  - the new content is computed in full before the file is touched, and an
 *    unchanged result is not written at all;
 *  - writes obey the bundle writer's containment and symlink rules.
 *
 * Markers are matched as plain text anywhere in the file, including inside code
 * fences: a fenced example of the markers counts, which can only make the
 * module refuse, never corrupt.
 */
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { assertNotSymlink, containedPath } from './docs-knowledge-bundle.js';

export const AGENTS_BLOCK_BEGIN = '<!-- smrt:agents:begin -->';
export const AGENTS_BLOCK_END = '<!-- smrt:agents:end -->';
/** Upper bound on the rendered block, markers included. */
export const AGENTS_BLOCK_MAX_LINES = 15;

const BOM = '﻿';

export interface AgentsBlockInputs {
  /** Installed smrt version to state (the smrt-cli version when installed). */
  version?: string;
  /** Package the version belongs to, e.g. `@happyvertical/smrt-cli`. */
  versionPackage?: string;
  /** Framework reference, relative to the AGENTS.md directory, forward slashes. */
  frameworkPath: string;
  /** Intent index, same convention; omitted when no intents were exported. */
  intentIndexPath?: string;
}

/** Renders the block with `\n` line endings; markers included, at most 15 lines. */
export function renderAgentsBlock(inputs: AgentsBlockInputs): string {
  const slash = (path: string) => path.replace(/\\/g, '/');
  const built =
    inputs.version && inputs.versionPackage
      ? ` (${inputs.versionPackage}@${inputs.version})`
      : inputs.version
        ? ` (smrt ${inputs.version})`
        : '';
  const lines = [
    AGENTS_BLOCK_BEGIN,
    `## smrt framework${built}`,
    '',
    `- Framework reference: \`${slash(inputs.frameworkPath)}\``,
    inputs.intentIndexPath
      ? `- Intent index: \`${slash(inputs.intentIndexPath)}\``
      : '- Intent index: none was exported (no installed package ships intent pages)',
    `- Before adding infrastructure, utility or integration code, read the ${inputs.intentIndexPath ? 'intent index' : 'framework reference'}.`,
    '- If smrt has the home package but lacks the behaviour, or lacks it entirely, file an issue on happyvertical/smrt and mark any local shim temporary: framework first, no glue.',
    '- Refresh this block and the references: `smrt docs:agents`.',
    '- Check for duplicated capability: `smrt-dev-mcp review --directory . --format summary`.',
    '',
    '_Generated; edit outside the markers only. Text between them is replaced on refresh._',
    AGENTS_BLOCK_END,
  ];
  return lines.join('\n');
}

export type MergeResult =
  | { text: string; refused?: undefined }
  | { text?: undefined; refused: string };

function count(haystack: string, needle: string): number {
  let n = 0;
  for (let at = haystack.indexOf(needle); at !== -1; ) {
    n++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return n;
}

/** The marker structure of `text`: `ok` with offsets, or why it is unusable. */
export function inspectMarkers(
  text: string,
):
  | { state: 'absent' }
  | { state: 'ok'; begin: number; end: number }
  | { state: 'refused'; reason: string } {
  const begins = count(text, AGENTS_BLOCK_BEGIN);
  const ends = count(text, AGENTS_BLOCK_END);
  if (begins === 0 && ends === 0) return { state: 'absent' };
  if (begins > 1 || ends > 1) {
    return {
      state: 'refused',
      reason: `found ${begins} begin and ${ends} end markers; expected exactly one pair`,
    };
  }
  if (begins === 0) {
    return { state: 'refused', reason: 'end marker without a begin marker' };
  }
  if (ends === 0) {
    return { state: 'refused', reason: 'begin marker without an end marker' };
  }
  const begin = text.indexOf(AGENTS_BLOCK_BEGIN);
  const end = text.indexOf(AGENTS_BLOCK_END);
  if (end < begin) {
    return { state: 'refused', reason: 'end marker comes before begin marker' };
  }
  return { state: 'ok', begin, end: end + AGENTS_BLOCK_END.length };
}

/** CRLF when CRLF line endings outnumber bare LF; LF otherwise (and for no newline). */
export function dominantEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Offset just past the line starting at `from` (past its terminator when present). */
function lineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl + 1;
}

function stripEol(line: string): string {
  return line.replace(/\r?\n$/, '').replace(/\r$/, '');
}

/** Offset past a leading YAML frontmatter block (`---` ... `---`), or `start`. */
function afterFrontmatter(text: string, start: number): number {
  if (stripEol(text.slice(start, lineEnd(text, start))).trimEnd() !== '---') {
    return start;
  }
  for (let at = lineEnd(text, start); at < text.length; ) {
    const next = lineEnd(text, at);
    const line = stripEol(text.slice(at, next)).trimEnd();
    if (line === '---' || line === '...') return next;
    at = next;
  }
  return start; // never closed: not frontmatter
}

/**
 * Offset past the first H1 line (ATX `# Title` or one-line setext `Title` +
 * `===`) outside code fences and frontmatter, or -1 when there is none.
 */
function afterFirstH1(text: string, from: number): number {
  let fence: string | undefined;
  for (let at = from; at < text.length; ) {
    const next = lineEnd(text, at);
    const line = stripEol(text.slice(at, next));
    const fenceMatch = FENCE.exec(line);
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence[0] &&
        fenceMatch[1].length >= fence.length &&
        line.trim() === fenceMatch[1]
      ) {
        fence = undefined;
      }
    } else if (fenceMatch) {
      fence = fenceMatch[1];
    } else if (/^ {0,3}#(?:[ \t]|$)/.test(line)) {
      return next;
    } else if (line.trim() !== '' && next < text.length) {
      const underlineEnd = lineEnd(text, next);
      const underline = stripEol(text.slice(next, underlineEnd));
      if (/^ {0,3}=+[ \t]*$/.test(underline)) return underlineEnd;
    }
    at = next;
  }
  return -1;
}

function startsWithBlankLine(text: string): boolean {
  return /^[ \t]*\r?\n/.test(text);
}

/**
 * Returns `existing` with `block` inserted (no markers yet) or replacing the
 * current marked section. Never alters a byte outside the markers except to
 * add separating line breaks around a fresh insertion.
 */
export function mergeAgentsBlock(existing: string, block: string): MergeResult {
  const markers = inspectMarkers(existing);
  if (markers.state === 'refused') return { refused: markers.reason };

  const eol = dominantEol(existing);
  const rendered = block.replace(/\r?\n/g, eol);

  if (markers.state === 'ok') {
    return {
      text: `${existing.slice(0, markers.begin)}${rendered}${existing.slice(markers.end)}`,
    };
  }

  const bom = existing.startsWith(BOM) ? BOM.length : 0;
  const bodyStart = afterFrontmatter(existing, bom);
  const h1End = afterFirstH1(existing, bodyStart);
  const at = h1End === -1 ? bodyStart : h1End;
  const before = existing.slice(0, at);
  const after = existing.slice(at);

  const lead =
    before.length === bom ? '' : before.endsWith('\n') ? eol : `${eol}${eol}`;
  const tail =
    after.length === 0
      ? before.length === bom || before.endsWith('\n')
        ? eol
        : ''
      : startsWithBlankLine(after)
        ? eol
        : `${eol}${eol}`;
  return { text: `${before}${lead}${rendered}${tail}${after}` };
}

export type AgentsBlockStatus =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'refused'
  | 'skipped';

export type ClaudeImportStatus =
  | 'created'
  | 'imports-agents'
  | 'no-import'
  | 'not-touched';

export interface AgentsBlockResult {
  status: AgentsBlockStatus;
  /** Absolute path of AGENTS.md. */
  path: string;
  warnings: string[];
  /** The rendered block (with `\n` endings), for dry-run output. */
  block: string;
  claude: ClaudeImportStatus;
  /** Why the block was refused or skipped. */
  reason?: string;
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

const CLAUDE_IMPORT = /(^|\s)@(?:\.\/)?AGENTS\.md(?=\s|$)/;

function titleFor(root: string): string {
  try {
    const name = JSON.parse(
      readFileSync(resolve(root, 'package.json'), 'utf8'),
    ).name;
    if (typeof name === 'string' && name.trim() !== '') return name.trim();
  } catch {
    // Fall back to the directory name.
  }
  return basename(resolve(root));
}

/**
 * Inserts or refreshes the managed block in `<root>/AGENTS.md`. Never throws:
 * every failure is a `refused` result with a warning.
 *
 * With `dryRun` nothing is written, but the result reports what would happen.
 */
export function applyAgentsBlock(options: {
  root: string;
  block: string;
  dryRun?: boolean;
  /** H1 for a newly created AGENTS.md; defaults to the root package name or directory. */
  title?: string;
}): AgentsBlockResult {
  const { root, block } = options;
  const warnings: string[] = [];
  let agentsPath = resolve(root, 'AGENTS.md');
  const result = (
    status: AgentsBlockStatus,
    claude: ClaudeImportStatus = 'not-touched',
    reason?: string,
  ): AgentsBlockResult => ({
    status,
    path: agentsPath,
    warnings,
    block,
    claude,
    ...(reason ? { reason } : {}),
  });
  const refuse = (reason: string): AgentsBlockResult => {
    warnings.push(`AGENTS.md managed block not written: ${reason}`);
    return result('refused', 'not-touched', reason);
  };

  try {
    agentsPath = containedPath(root, 'AGENTS.md');
    assertNotSymlink(agentsPath);

    const existed = lstatOrNull(agentsPath) !== null;
    let existing = '';
    if (existed) {
      if (!lstatOrNull(agentsPath)?.isFile()) {
        return refuse('AGENTS.md is not a regular file');
      }
      existing = readFileSync(agentsPath, 'utf8');
    }

    const merged = mergeAgentsBlock(
      existed ? existing : `# ${options.title ?? titleFor(root)}\n`,
      block,
    );
    if (merged.refused !== undefined) {
      return refuse(`${merged.refused}; fix or remove the markers by hand`);
    }

    let status: AgentsBlockStatus;
    if (!existed) status = 'created';
    else if (merged.text === existing) status = 'unchanged';
    else status = 'updated';

    if (!options.dryRun && status !== 'unchanged') {
      // The full new content exists; only now is the file opened for writing.
      assertNotSymlink(agentsPath);
      writeFileSync(agentsPath, merged.text, 'utf8');
    }

    const claude = handleClaudeFile(
      root,
      agentsPath,
      status === 'created',
      options.dryRun === true,
      warnings,
    );
    return result(status, claude);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }
}

/** CLAUDE.md: created as `@AGENTS.md` only beside a freshly created AGENTS.md; otherwise only checked. */
function handleClaudeFile(
  root: string,
  agentsPath: string,
  agentsCreated: boolean,
  dryRun: boolean,
  warnings: string[],
): ClaudeImportStatus {
  try {
    const claudePath = containedPath(root, 'CLAUDE.md');
    if (lstatOrNull(claudePath) === null) {
      if (!agentsCreated) return 'not-touched';
      if (dryRun) return 'created';
      // 'wx' never replaces a file that appeared meanwhile.
      closeSync(openSync(claudePath, 'wx'));
      writeFileSync(claudePath, '@AGENTS.md\n', 'utf8');
      return 'created';
    }
    // A symlinked CLAUDE.md pointing at AGENTS.md is the common single-source
    // setup: it loads AGENTS.md by being it.
    try {
      if (
        existsSync(agentsPath) &&
        realpathSync(claudePath) === realpathSync(agentsPath)
      ) {
        return 'imports-agents';
      }
    } catch {
      // Dangling link: fall through to the read, which fails below.
    }
    const text = readFileSync(claudePath, 'utf8');
    if (CLAUDE_IMPORT.test(text)) return 'imports-agents';
    warnings.push(
      'CLAUDE.md exists but does not import AGENTS.md, so Claude Code will not load the managed block. Add a line `@AGENTS.md` to it; this command never edits CLAUDE.md.',
    );
    return 'no-import';
  } catch (error) {
    warnings.push(
      `CLAUDE.md not checked: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 'not-touched';
  }
}

export interface AgentsBlockCheck {
  state: 'present' | 'missing' | 'refused';
  path: string;
  reason?: string;
}

/**
 * Read-only detector for `smrt doctor` and friends: is a well-formed managed
 * block in `<root>/AGENTS.md`? A missing file counts as `missing`.
 */
export function checkAgentsBlock(root: string): AgentsBlockCheck {
  let path = resolve(root, 'AGENTS.md');
  try {
    path = containedPath(root, 'AGENTS.md');
    assertNotSymlink(path);
    if (lstatOrNull(path) === null) return { state: 'missing', path };
    const markers = inspectMarkers(readFileSync(path, 'utf8'));
    if (markers.state === 'ok') return { state: 'present', path };
    if (markers.state === 'absent') return { state: 'missing', path };
    return { state: 'refused', path, reason: markers.reason };
  } catch (error) {
    return {
      state: 'refused',
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
