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
 * Only a marker alone on its own line and outside a fenced code block is
 * structural. A marker mentioned inline in prose, or shown inside a fence, is
 * ignored entirely, so a documented example can never be mistaken for the
 * block and the text around it is never overwritten.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
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
    `- Data shape rules (what smrt requires of a field, how to harden a smrt class in this app): the "Data shape rules" section of the framework reference.`,
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

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Offset just past the line starting at `from` (past its terminator when present). */
function lineEnd(text: string, from: number): number {
  const nl = text.indexOf('\n', from);
  return nl === -1 ? text.length : nl + 1;
}

function stripEol(line: string): string {
  return line.replace(/\r?\n$/, '').replace(/\r$/, '');
}

/**
 * Advances fence state for one line: returns the fence opener in force after
 * `line` (`undefined` when outside a fence). Shared by the H1 finder and the
 * marker scanner so both agree on what is code.
 */
function nextFence(
  line: string,
  fence: string | undefined,
): string | undefined {
  const fenceMatch = FENCE.exec(line);
  if (fence) {
    return fenceMatch &&
      fenceMatch[1][0] === fence[0] &&
      fenceMatch[1].length >= fence.length &&
      line.trim() === fenceMatch[1]
      ? undefined
      : fence;
  }
  return fenceMatch ? fenceMatch[1] : undefined;
}

interface StructuralMarker {
  kind: 'begin' | 'end';
  /** Offset of the first marker character. */
  start: number;
  /** Offset just past the marker. */
  end: number;
}

/**
 * Markers that are structural: alone on their own line (surrounding
 * whitespace allowed) and outside a fenced code block. A marker string
 * mentioned inline in prose or shown inside a fence is documentation, not
 * structure, and is ignored. An unclosed fence runs to the end of the file, so
 * markers after it are ignored too; insertion always happens before any fence
 * (after the first H1 outside fences, or at the top), so a block inserted next
 * to such a file is found again on the next run.
 */
function structuralMarkers(text: string): StructuralMarker[] {
  const found: StructuralMarker[] = [];
  let fence: string | undefined;
  // Scan the same region the insertion point is computed over: past a BOM and
  // a leading frontmatter block, whose lines are neither fences nor markers.
  const bom = text.startsWith(BOM) ? BOM.length : 0;
  for (let at = afterFrontmatter(text, bom); at < text.length; ) {
    const next = lineEnd(text, at);
    const line = stripEol(text.slice(at, next));
    const inFence = fence !== undefined;
    fence = nextFence(line, fence);
    if (!inFence && fence === undefined) {
      // 0-3 leading spaces only: deeper or tab indentation is an indented
      // code block, not structure.
      const match = /^( {0,3})(\S.*?)[ \t]*$/.exec(line);
      const trimmed = match?.[2];
      const kind =
        trimmed === AGENTS_BLOCK_BEGIN
          ? 'begin'
          : trimmed === AGENTS_BLOCK_END
            ? 'end'
            : undefined;
      if (kind && match && trimmed !== undefined) {
        const start = at + match[1].length;
        found.push({ kind, start, end: start + trimmed.length });
      }
    }
    at = next;
  }
  return found;
}

/**
 * The marker structure of `text`: `ok` with offsets, or why it is unusable.
 * Only structural markers count (see {@link structuralMarkers}).
 */
export function inspectMarkers(
  text: string,
):
  | { state: 'absent' }
  | { state: 'ok'; begin: number; end: number }
  | { state: 'refused'; reason: string } {
  const markers = structuralMarkers(text);
  const begins = markers.filter((m) => m.kind === 'begin');
  const ends = markers.filter((m) => m.kind === 'end');
  if (begins.length === 0 && ends.length === 0) return { state: 'absent' };
  if (begins.length > 1 || ends.length > 1) {
    return {
      state: 'refused',
      reason: `found ${begins.length} begin and ${ends.length} end markers; expected exactly one pair`,
    };
  }
  if (begins.length === 0) {
    return { state: 'refused', reason: 'end marker without a begin marker' };
  }
  if (ends.length === 0) {
    return { state: 'refused', reason: 'begin marker without an end marker' };
  }
  if (ends[0].start < begins[0].start) {
    return { state: 'refused', reason: 'end marker comes before begin marker' };
  }
  return { state: 'ok', begin: begins[0].start, end: ends[0].end };
}

/** CRLF when CRLF line endings outnumber bare LF; LF otherwise (and for no newline). */
export function dominantEol(text: string): '\r\n' | '\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
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
      fence = nextFence(line, fence);
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
      replaceFileAtomically(agentsPath, merged.text);
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

/**
 * Writes `text` to a fresh temp file beside `path` (flag `wx`: never reuses a
 * path), then renames it over `path`. The target is never truncated, and a
 * symlink swapped in at `path` after the checks is replaced, not followed. The
 * original mode is kept; the temp file is removed on any failure.
 */
function replaceFileAtomically(path: string, text: string): void {
  const mode = lstatOrNull(path)?.mode;
  const temp = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = openSync(temp, 'wx', 0o666);
  try {
    try {
      const data = Buffer.from(text, 'utf8');
      for (let written = 0; written < data.length; ) {
        written += writeSync(fd, data, written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (mode !== undefined) chmodSync(temp, mode & 0o7777);
    renameSync(temp, path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Already gone.
    }
    throw error;
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
