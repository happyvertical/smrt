/**
 * docs:agents skill installation tests (#4708): the smrt-catalog skill is
 * written into the consumer's harness directories, replaced on rerun, and a
 * hand-edited copy is left alone.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAgentSkill } from '@happyvertical/smrt-dev-mcp/agent-skills';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { docsCommands } from '../docs-claude.js';
import {
  installAgentSkills,
  SKILL_MARKER_PREFIX,
  withGeneratedMarker,
} from '../docs-skills-install.js';

let tempDir: string;
let originalCwd: string;

const CLAUDE_COPY = '.claude/skills/smrt-catalog/SKILL.md';
const AGENTS_COPY = '.agents/skills/smrt-catalog/SKILL.md';

function installPackage(name: string): void {
  const dir = join(tempDir, 'node_modules', '@happyvertical', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `@happyvertical/${name}`, version: '1.0.0' }),
  );
  writeFileSync(join(dir, 'AGENTS.md'), `# ${name}\n`);
}

const run = (options: Record<string, unknown> = {}) =>
  requireCommandHandler(docsCommands['docs:agents'])([], options);

describe('docs:agents skill installation (#4708)', () => {
  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-docs-skills-')));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    installPackage('smrt-jobs');
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes smrt-catalog into the Claude and harness-neutral directories', async () => {
    await run();

    for (const rel of [CLAUDE_COPY, AGENTS_COPY]) {
      const text = readFileSync(join(tempDir, rel), 'utf-8');
      expect(text.startsWith('---\nname: smrt-catalog\n')).toBe(true);
      expect(text).toContain(SKILL_MARKER_PREFIX);
      expect(text).toMatch(/smrt-dev-mcp@\d+\.\d+\.\d+/);
      expect(text).toContain('.agents/smrt-knowledge/intents/index.md');
    }
    // The contributor skill is only for smrt checkouts.
    expect(
      existsSync(join(tempDir, '.claude/skills/smrt-contribute/SKILL.md')),
    ).toBe(false);
  });

  it('is idempotent and replaces a stale generated copy', async () => {
    await run();
    const first = readFileSync(join(tempDir, CLAUDE_COPY), 'utf-8');
    await run();
    expect(readFileSync(join(tempDir, CLAUDE_COPY), 'utf-8')).toBe(first);

    // An older generated copy (marker kept, body different) is replaced.
    writeFileSync(
      join(tempDir, CLAUDE_COPY),
      first.replace('# SMRT Catalog', '# Old Catalog'),
    );
    await run();
    expect(readFileSync(join(tempDir, CLAUDE_COPY), 'utf-8')).toBe(first);
  });

  it('leaves a hand-edited copy (no marker) alone and warns', async () => {
    mkdirSync(join(tempDir, '.claude/skills/smrt-catalog'), {
      recursive: true,
    });
    writeFileSync(join(tempDir, CLAUDE_COPY), 'my own catalog skill\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await run();

    expect(readFileSync(join(tempDir, CLAUDE_COPY), 'utf-8')).toBe(
      'my own catalog skill\n',
    );
    expect(warn.mock.calls.flat().join('\n')).toContain(CLAUDE_COPY);
    // The other harness directory is still managed.
    expect(readFileSync(join(tempDir, AGENTS_COPY), 'utf-8')).toContain(
      SKILL_MARKER_PREFIX,
    );
  });

  it('also installs smrt-contribute in a smrt checkout and leaves its identical checked-in copy alone', async () => {
    writeFileSync(
      join(tempDir, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    );
    writeFileSync(join(tempDir, 'AGENTS.md'), '# smrt\n');
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: '@happyvertical/smrt' }),
    );
    mkdirSync(join(tempDir, 'packages'), { recursive: true });
    const shipped = getAgentSkill({ name: 'smrt-contribute' }).skillMarkdown;
    const checkedIn = join(tempDir, '.agents/skills/smrt-contribute/SKILL.md');
    mkdirSync(join(tempDir, '.agents/skills/smrt-contribute'), {
      recursive: true,
    });
    writeFileSync(checkedIn, shipped);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await run();

    expect(readFileSync(checkedIn, 'utf-8')).toBe(shipped);
    expect(warn.mock.calls.flat().join('\n')).not.toContain('smrt-contribute');
    expect(
      readFileSync(
        join(tempDir, '.claude/skills/smrt-contribute/SKILL.md'),
        'utf-8',
      ),
    ).toContain(SKILL_MARKER_PREFIX);
  });

  it('installs only the catalog in a downstream pnpm monorepo', async () => {
    writeFileSync(
      join(tempDir, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    );
    writeFileSync(join(tempDir, 'AGENTS.md'), '# app\n');
    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'my-app-monorepo' }),
    );
    mkdirSync(join(tempDir, 'packages'), { recursive: true });

    await run();

    expect(existsSync(join(tempDir, CLAUDE_COPY))).toBe(true);
    expect(existsSync(join(tempDir, '.claude/skills/smrt-contribute'))).toBe(
      false,
    );
    expect(existsSync(join(tempDir, '.agents/skills/smrt-contribute'))).toBe(
      false,
    );
  });

  it('points the installed catalog at the real bundle directory', async () => {
    await run();
    expect(readFileSync(join(tempDir, AGENTS_COPY), 'utf-8')).toContain(
      '.agents/smrt-knowledge/intents/index.md',
    );

    await requireCommandHandler(docsCommands['docs:claude'])([], {});
    const claude = readFileSync(join(tempDir, CLAUDE_COPY), 'utf-8');
    expect(claude).toContain('.claude/smrt-knowledge/intents/index.md');
    expect(claude).not.toContain('.agents/smrt-knowledge');
  });

  it('writes nothing with --no-install-skills', async () => {
    await run({ 'no-install-skills': true });

    expect(existsSync(join(tempDir, '.claude'))).toBe(false);
    expect(existsSync(join(tempDir, '.agents/skills'))).toBe(false);
    expect(existsSync(join(tempDir, '.agents/smrt-framework.md'))).toBe(true);
  });

  it('writes nothing on --dry-run', async () => {
    await run({ 'dry-run': true });

    expect(existsSync(join(tempDir, '.claude'))).toBe(false);
  });

  it('refuses to write through a symlinked skills directory', () => {
    const elsewhere = join(tempDir, 'elsewhere');
    mkdirSync(elsewhere);
    mkdirSync(join(tempDir, '.claude'));
    symlinkSync(elsewhere, join(tempDir, '.claude', 'skills'));

    expect(() =>
      installAgentSkills({
        projectRoot: tempDir,
        skills: ['smrt-catalog'],
        generatedBy: 'smrt docs:agents',
      }),
    ).toThrow(/symlink/);
    expect(existsSync(join(elsewhere, 'smrt-catalog'))).toBe(false);
    // Contained and checked before any write: nothing landed in .agents either.
    expect(existsSync(join(tempDir, AGENTS_COPY))).toBe(false);
  });

  it('keeps frontmatter first and puts the marker after it', () => {
    const out = withGeneratedMarker(
      '---\nname: x\n---\n\n# Body\n',
      'x',
      '1.2.3',
      'smrt docs:agents',
    );
    expect(out.startsWith('---\nname: x\n---\n')).toBe(true);
    expect(out).toContain('smrt-dev-mcp@1.2.3');
    expect(out.indexOf(SKILL_MARKER_PREFIX)).toBeGreaterThan(
      out.indexOf('name: x'),
    );
  });
});
