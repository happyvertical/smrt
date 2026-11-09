/**
 * Managed AGENTS.md block (#4878 item A).
 *
 * AGENTS.md belongs to the user: every test that edits an existing file
 * asserts byte equality of everything outside the markers.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import {
  AGENTS_BLOCK_MAX_LINES,
  applyAgentsBlock,
  AGENTS_BLOCK_BEGIN as BEGIN,
  checkAgentsBlock,
  AGENTS_BLOCK_END as END,
  mergeAgentsBlock,
  renderAgentsBlock,
} from '../docs-agents-block.js';
import { docsCommands } from '../docs-claude.js';

const BLOCK = renderAgentsBlock({
  version: '1.2.3',
  versionPackage: '@happyvertical/smrt-cli',
  frameworkPath: '.agents/smrt-framework.md',
  intentIndexPath: '.agents/smrt-knowledge/intents/index.md',
});

let dir: string;
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-agents-block-')));
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const agents = () => join(dir, 'AGENTS.md');
const read = (path = agents()) => readFileSync(path, 'utf8');
function merged(existing: string, block = BLOCK): string {
  const result = mergeAgentsBlock(existing, block);
  if (result.refused !== undefined) throw new Error(result.refused);
  return result.text;
}
/** Splits a merged file into [prefix, block, suffix] around the markers. */
function around(text: string): [string, string, string] {
  const begin = text.indexOf(BEGIN);
  const end = text.indexOf(END) + END.length;
  return [text.slice(0, begin), text.slice(begin, end), text.slice(end)];
}

describe('renderAgentsBlock', () => {
  it('is at most 15 lines including markers and starts/ends with them', () => {
    const lines = BLOCK.split('\n');
    expect(lines.length).toBeLessThanOrEqual(AGENTS_BLOCK_MAX_LINES);
    expect(lines[0]).toBe('<!-- smrt:agents:begin -->');
    expect(lines.at(-1)).toBe('<!-- smrt:agents:end -->');
    expect(BLOCK).not.toContain('\r');
  });

  it('states the version, both paths, the rule and the commands', () => {
    expect(BLOCK).toContain('@happyvertical/smrt-cli@1.2.3');
    expect(BLOCK).toContain('`.agents/smrt-framework.md`');
    expect(BLOCK).toContain('`.agents/smrt-knowledge/intents/index.md`');
    expect(BLOCK).toContain('happyvertical/smrt');
    expect(BLOCK).toContain('framework first, no glue');
    expect(BLOCK).toContain('`smrt docs:agents`');
    expect(BLOCK).toContain(
      '`smrt-dev-mcp review --directory . --format summary`',
    );
  });

  it('says so, gracefully, when no intents were exported', () => {
    const text = renderAgentsBlock({ frameworkPath: 'smrt-framework.md' });
    expect(text).toContain('none was exported');
    expect(text).not.toContain('intents/index.md');
    expect(text.split('\n').length).toBeLessThanOrEqual(15);
  });

  it('normalises backslash paths to forward slashes', () => {
    const text = renderAgentsBlock({
      frameworkPath: '.agents\\smrt-framework.md',
      intentIndexPath: '.agents\\k\\intents\\index.md',
    });
    expect(text).toContain('.agents/k/intents/index.md');
    expect(text).not.toContain('\\');
  });
});

describe('mergeAgentsBlock insertion', () => {
  it('inserts directly after the first H1 and keeps every other byte', () => {
    const before = '# My App\n\nHand written.\n\n## Later\n# Second H1\n';
    const [pre, block, post] = around(merged(before));
    expect(pre).toBe('# My App\n\n');
    expect(block).toBe(BLOCK);
    expect(post).toBe('\n\nHand written.\n\n## Later\n# Second H1\n');
    // Removing the block and the two separators the merge added restores it.
    expect(pre.slice(0, -1) + post.slice(1)).toBe(before);
  });

  it('inserts at the very top when there is no H1', () => {
    const before = 'Just prose.\n\n## Section\n';
    const text = merged(before);
    expect(text.startsWith(BEGIN)).toBe(true);
    expect(text.endsWith(`${END}\n\n${before}`)).toBe(true);
  });

  it('ignores a # line inside a code fence when looking for the H1', () => {
    const before = '```sh\n# not a heading\n```\n\n# Real\n\nText\n';
    const [pre] = around(merged(before));
    expect(pre).toBe('```sh\n# not a heading\n```\n\n# Real\n\n');
  });

  it('treats a setext H1 as the H1', () => {
    const before = 'My App\n======\n\nBody\n';
    const [pre, , post] = around(merged(before));
    expect(pre).toBe('My App\n======\n\n');
    expect(post).toBe('\n\nBody\n');
  });

  it('with frontmatter and no H1 inserts after the closing ---', () => {
    const before = '---\ntitle: x\n---\nBody text\n';
    const [pre, , post] = around(merged(before));
    expect(pre).toBe('---\ntitle: x\n---\n\n');
    expect(post).toBe('\n\nBody text\n');
  });

  it('with frontmatter and an H1 inserts after the H1', () => {
    const before = '---\ntitle: x\n---\n\n# App\n\nBody\n';
    const [pre, , post] = around(merged(before));
    expect(pre).toBe('---\ntitle: x\n---\n\n# App\n\n');
    expect(post).toBe('\n\nBody\n');
  });

  it('does not take a # comment in frontmatter for the H1', () => {
    const before = '---\n# a yaml comment\nk: v\n---\nBody\n';
    const [pre] = around(merged(before));
    expect(pre).toBe('---\n# a yaml comment\nk: v\n---\n\n');
  });

  it('an unclosed leading --- is not frontmatter', () => {
    const before = '---\nnot closed\n';
    expect(merged(before).startsWith(BEGIN)).toBe(true);
  });

  it('an H1-only file with a trailing newline keeps it', () => {
    expect(merged('# T\n')).toBe(`# T\n\n${BLOCK}\n`);
  });

  it('a file whose only line is an H1 without newline stays without one', () => {
    const text = merged('# T');
    expect(text).toBe(`# T\n\n${BLOCK}`);
    expect(text.endsWith('\n')).toBe(false);
  });

  it('a file without trailing newline keeps its last byte exactly', () => {
    const before = '# T\n\nlast line no newline';
    const text = merged(before);
    expect(text.endsWith('\n\nlast line no newline')).toBe(true);
    expect(text.endsWith('\n')).toBe(false);
  });

  it('an empty file becomes the block plus a newline', () => {
    expect(merged('')).toBe(`${BLOCK}\n`);
  });

  it('keeps a BOM first, inserts after it, and never duplicates it', () => {
    const before = '﻿# Title\n\nBody\n';
    const text = merged(before);
    expect(text.startsWith('﻿# Title\n\n')).toBe(true);
    expect(text.split('﻿')).toHaveLength(2);
    expect(text.endsWith('\n\nBody\n')).toBe(true);
    // BOM and no H1: block follows the BOM.
    expect(merged('﻿Body\n').startsWith(`﻿${BEGIN}`)).toBe(true);
  });
});

describe('mergeAgentsBlock line endings', () => {
  it('a CRLF file stays CRLF everywhere', () => {
    const before = '# T\r\n\r\nline one\r\nline two\r\n';
    const text = merged(before);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    const [pre, block, post] = around(text);
    expect(pre).toBe('# T\r\n\r\n');
    expect(block).toBe(BLOCK.replace(/\n/g, '\r\n'));
    expect(post).toBe('\r\n\r\nline one\r\nline two\r\n');
  });

  it('a CRLF file without trailing newline stays without', () => {
    const text = merged('# T\r\n\r\nend');
    expect(text.endsWith('\r\n\r\nend')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('refreshing a CRLF file with a block keeps CRLF and outside bytes', () => {
    const first = merged('# T\r\n\r\nbody\r\n');
    const stale = first.replace('Framework reference', 'Hand edited');
    const refreshed = merged(stale);
    expect(refreshed).toBe(first);
    expect(refreshed.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('an LF file stays LF', () => {
    expect(merged('# T\n\nx\n')).not.toContain('\r');
  });
});

describe('mergeAgentsBlock replacement', () => {
  it('replaces hand-edited content between the markers, nothing else', () => {
    const outsideBefore = '# T\n\nintro\n\n';
    const outsideAfter = '\n\n## Mine\nkeep me\n';
    const stale = `${outsideBefore}${BEGIN}\nhand edited!\n${END}${outsideAfter}`;
    const text = merged(stale);
    expect(text).toBe(`${outsideBefore}${BLOCK}${outsideAfter}`);
  });

  it('bytes after the end marker on the same line survive', () => {
    const stale = `# T\n\n${BEGIN}\nx\n${END} trailing  \nrest`;
    const [, , post] = around(merged(stale));
    expect(post).toBe(' trailing  \nrest');
  });

  it('is a fixed point: merging its own output changes nothing', () => {
    for (const before of [
      '# T\n',
      '# T',
      'prose',
      '',
      '﻿# T\r\nx\r\n',
      '---\na: b\n---\nx\n',
    ]) {
      const once = merged(before);
      expect(merged(once)).toBe(once);
    }
  });
});

describe('mergeAgentsBlock refusals', () => {
  const cases: Record<string, string> = {
    'begin without end': `# T\n\n${BEGIN}\nstuff\n`,
    'end without begin': `# T\n\nstuff\n${END}\n`,
    'end before begin': `# T\n${END}\nmiddle\n${BEGIN}\n`,
    'duplicate pairs': `${BEGIN}\na\n${END}\n${BEGIN}\nb\n${END}\n`,
    'two begins, one end': `${BEGIN}\n${BEGIN}\n${END}\n`,
    'one begin, two ends': `${BEGIN}\n${END}\n${END}\n`,
  };
  for (const [name, input] of Object.entries(cases)) {
    it(`refuses ${name} and writes nothing`, () => {
      expect(mergeAgentsBlock(input, BLOCK).refused).toEqual(
        expect.any(String),
      );
      writeFileSync(agents(), input);
      const result = applyAgentsBlock({ root: dir, block: BLOCK });
      expect(result.status).toBe('refused');
      expect(result.warnings.join(' ')).toContain('not written');
      expect(read()).toBe(input);
    });
  }

  it('counts markers inside code fences (documented: refuse over corrupt)', () => {
    const input = `# T\n\n\`\`\`md\n${BEGIN}\n\`\`\`\n`;
    expect(mergeAgentsBlock(input, BLOCK).refused).toBeDefined();
  });
});

describe('applyAgentsBlock', () => {
  it('creates AGENTS.md with a package-name H1, and CLAUDE.md importing it', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"my-consumer"}');
    const result = applyAgentsBlock({ root: dir, block: BLOCK });
    expect(result.status).toBe('created');
    expect(read()).toBe(`# my-consumer\n\n${BLOCK}\n`);
    expect(read(join(dir, 'CLAUDE.md'))).toBe('@AGENTS.md\n');
    expect(result.claude).toBe('created');
    expect(result.warnings).toEqual([]);
  });

  it('falls back to the directory name for the H1', () => {
    applyAgentsBlock({ root: dir, block: BLOCK });
    expect(read().startsWith(`# ${dir.split('/').at(-1)}\n`)).toBe(true);
  });

  it('creates AGENTS.md but never touches an existing CLAUDE.md without import (warns)', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), 'my own claude rules\n');
    const result = applyAgentsBlock({ root: dir, block: BLOCK });
    expect(result.status).toBe('created');
    expect(read(join(dir, 'CLAUDE.md'))).toBe('my own claude rules\n');
    expect(result.claude).toBe('no-import');
    expect(result.warnings.join(' ')).toMatch(/will not load/);
  });

  it('an existing CLAUDE.md importing @AGENTS.md is silent and untouched', () => {
    const claude = 'Intro\n\n@AGENTS.md\n';
    writeFileSync(join(dir, 'CLAUDE.md'), claude);
    const result = applyAgentsBlock({ root: dir, block: BLOCK });
    expect(result.warnings).toEqual([]);
    expect(result.claude).toBe('imports-agents');
    expect(read(join(dir, 'CLAUDE.md'))).toBe(claude);
  });

  it('a CLAUDE.md symlinked to AGENTS.md is silent', () => {
    writeFileSync(agents(), '# T\n');
    symlinkSync('AGENTS.md', join(dir, 'CLAUDE.md'));
    const result = applyAgentsBlock({ root: dir, block: BLOCK });
    expect(result.warnings).toEqual([]);
  });

  it('does not create CLAUDE.md beside a pre-existing AGENTS.md', () => {
    writeFileSync(agents(), '# T\n');
    applyAgentsBlock({ root: dir, block: BLOCK });
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('warns about CLAUDE.md without import even when AGENTS.md pre-existed', () => {
    writeFileSync(agents(), '# T\n');
    writeFileSync(join(dir, 'CLAUDE.md'), 'x\n');
    const result = applyAgentsBlock({ root: dir, block: BLOCK });
    expect(result.claude).toBe('no-import');
    expect(read(join(dir, 'CLAUDE.md'))).toBe('x\n');
  });

  it('refuses a symlinked AGENTS.md without following it', () => {
    const target = join(dir, 'real.md');
    writeFileSync(target, '# Real\n');
    symlinkSync(target, agents());
    const result = applyAgentsBlock({ root: dir, block: BLOCK });
    expect(result.status).toBe('refused');
    expect(read(target)).toBe('# Real\n');
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('refuses a dangling AGENTS.md symlink', () => {
    symlinkSync(join(dir, 'nowhere.md'), agents());
    const result = applyAgentsBlock({ root: dir, block: BLOCK });
    expect(result.status).toBe('refused');
    expect(existsSync(join(dir, 'nowhere.md'))).toBe(false);
  });

  it('is idempotent: second run reports unchanged, bytes and mtime stable', () => {
    writeFileSync(agents(), '# T\r\n\r\nhand written\r\n');
    expect(applyAgentsBlock({ root: dir, block: BLOCK }).status).toBe(
      'updated',
    );
    const first = read();
    const old = new Date('2020-01-01T00:00:00Z');
    utimesSync(agents(), old, old);
    const second = applyAgentsBlock({ root: dir, block: BLOCK });
    expect(second.status).toBe('unchanged');
    expect(read()).toBe(first);
    expect(statSync(agents()).mtimeMs).toBe(old.getTime());
  });

  it('refreshes only the block when inputs change', () => {
    writeFileSync(agents(), '# T\n\nmine\n');
    applyAgentsBlock({ root: dir, block: BLOCK });
    const newer = renderAgentsBlock({
      version: '9.9.9',
      versionPackage: '@happyvertical/smrt-cli',
      frameworkPath: 'f.md',
    });
    const result = applyAgentsBlock({ root: dir, block: newer });
    expect(result.status).toBe('updated');
    expect(read()).toBe(`# T\n\n${newer}\n\nmine\n`);
  });

  it('dry-run writes nothing and reports what would happen', () => {
    const result = applyAgentsBlock({ root: dir, block: BLOCK, dryRun: true });
    expect(result.status).toBe('created');
    expect(result.claude).toBe('created');
    expect(result.block).toBe(BLOCK);
    expect(existsSync(agents())).toBe(false);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);

    writeFileSync(agents(), '# T\n');
    const again = applyAgentsBlock({ root: dir, block: BLOCK, dryRun: true });
    expect(again.status).toBe('updated');
    expect(read()).toBe('# T\n');
  });

  it('never throws, even for an unreadable root', () => {
    const result = applyAgentsBlock({
      root: join(dir, 'missing', 'deep'),
      block: BLOCK,
      dryRun: false,
    });
    // The directory does not exist: creating the file fails, reported not thrown.
    expect(['refused', 'created']).toContain(result.status);
  });

  it('property: prefix and suffix survive two runs for varied files', () => {
    const files = [
      '',
      '# T',
      '# T\n',
      '# T\r\n',
      '﻿# T\n\nbody',
      'no heading\n',
      'no heading',
      '---\nk: v\n---\n# H\n\nbody\r\n\r\nmixed\n',
      'Setext\n===\ntext\n',
      '\n\n# After blanks\n\n\n\ntrailing blanks\n\n\n',
      '# T\n\n```\n# fenced\n```\n',
      '#hashtag not heading\n',
      '# T  \t\n\ttabbed\n',
    ];
    for (const original of files) {
      writeFileSync(agents(), original);
      applyAgentsBlock({ root: dir, block: BLOCK });
      const once = read();
      const second = applyAgentsBlock({ root: dir, block: BLOCK });
      expect(second.status).toBe('unchanged');
      expect(read()).toBe(once);
      const [prefix, block, suffix] = around(once);
      expect(block.replace(/\r\n/g, '\n')).toBe(BLOCK);
      // Every original byte is still present, in order, outside the block.
      const outside = prefix + suffix;
      let at = 0;
      for (const ch of original) {
        at = outside.indexOf(ch, at);
        expect(at, JSON.stringify(original)).toBeGreaterThanOrEqual(0);
        at++;
      }
      // Stripping only whitespace-newlines the merge added gives the original.
      expect(outside.replace(/[\r\n]/g, '')).toBe(
        original.replace(/[\r\n]/g, ''),
      );
    }
  });
});

describe('checkAgentsBlock', () => {
  it('reports missing, present and refused', () => {
    expect(checkAgentsBlock(dir).state).toBe('missing');
    writeFileSync(agents(), '# T\n');
    expect(checkAgentsBlock(dir).state).toBe('missing');
    applyAgentsBlock({ root: dir, block: BLOCK });
    expect(checkAgentsBlock(dir).state).toBe('present');
    writeFileSync(agents(), `# T\n${BEGIN}\n`);
    const refused = checkAgentsBlock(dir);
    expect(refused.state).toBe('refused');
    expect(refused.reason).toContain('without an end');
  });

  it('refuses a symlinked AGENTS.md and writes nothing', () => {
    writeFileSync(join(dir, 'real.md'), '# T\n');
    symlinkSync(join(dir, 'real.md'), agents());
    expect(checkAgentsBlock(dir).state).toBe('refused');
  });
});

describe('docs:agents handler', () => {
  let original: string;
  const run = (options: Record<string, unknown> = {}) =>
    requireCommandHandler(docsCommands['docs:agents'])([], options);

  function install(root: string, name: string, version: string): void {
    const pkg = join(root, 'node_modules', '@happyvertical', name);
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({ name: `@happyvertical/${name}`, version }),
    );
    writeFileSync(join(pkg, 'AGENTS.md'), `# ${name}\n`);
  }

  beforeEach(() => {
    original = process.cwd();
    writeFileSync(join(dir, 'package.json'), '{"name":"consumer"}');
    install(dir, 'smrt-core', '4.5.6');
    process.chdir(dir);
  });
  afterEach(() => process.chdir(original));

  it('writes the block after the bundle, stating the installed version', async () => {
    writeFileSync(agents(), '# Consumer\n\nMine.\n');
    await run();
    const text = read();
    expect(text).toContain(BEGIN);
    expect(text).toContain('@happyvertical/smrt-core@4.5.6');
    expect(text).toContain('`.agents/smrt-framework.md`');
    expect(text.startsWith('# Consumer\n\n')).toBe(true);
    expect(text.endsWith('\n\nMine.\n')).toBe(true);
    const before = read();
    await run();
    expect(read()).toBe(before);
  });

  it('points at the intent index only when intents were exported', async () => {
    await run();
    const exported = existsSync(
      join(dir, '.agents', 'smrt-knowledge', 'intents', 'index.md'),
    );
    expect(read().includes('.agents/smrt-knowledge/intents/index.md')).toBe(
      exported,
    );
  });

  it('--no-agents-block writes no AGENTS.md or CLAUDE.md', async () => {
    await run({ 'no-agents-block': true });
    expect(existsSync(agents())).toBe(false);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(dir, '.agents', 'smrt-framework.md'))).toBe(true);
  });

  it('--dry-run writes nothing and reports the block on stderr, not stdout', async () => {
    await run({ 'dry-run': true });
    expect(existsSync(agents())).toBe(false);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    const stderr = errorSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(stderr).toContain(BEGIN);
    expect(stderr).toContain('would be created');
    const stdout = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(stdout).not.toContain(BEGIN);
  });

  it('a refused block warns and does not change the exit path', async () => {
    const bad = `# T\n${BEGIN}\n`;
    writeFileSync(agents(), bad);
    await expect(run()).resolves.toBeUndefined();
    expect(read()).toBe(bad);
    expect(errorSpy.mock.calls.flat().join(' ')).toContain('not written');
    expect(existsSync(join(dir, '.agents', 'smrt-framework.md'))).toBe(true);
  });

  it('a monorepo member run writes the block at the workspace root', async () => {
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    const app = join(dir, 'apps', 'a');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"name":"a"}');
    rmSync(join(dir, 'node_modules'), { recursive: true, force: true });
    install(app, 'smrt-core', '7.0.0');
    process.chdir(app);
    await run();
    expect(read()).toContain('@happyvertical/smrt-core@7.0.0');
    expect(existsSync(join(app, 'AGENTS.md'))).toBe(false);
  });
});
