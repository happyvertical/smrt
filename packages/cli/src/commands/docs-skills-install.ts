/**
 * Skill-installation half of `smrt docs:agents` (#4708).
 *
 * Writes the bundled smrt skills from `@happyvertical/smrt-dev-mcp` into the
 * consumer's harness directories so a harness discovers them without the MCP
 * server: `.claude/skills/<name>/SKILL.md` (Claude Code) and the
 * harness-neutral `.agents/skills/<name>/SKILL.md` (Codex, Gemini, others).
 *
 * Ownership: an installed copy carries a generated marker with the
 * smrt-dev-mcp version. A rerun replaces a marked copy; an unmarked copy was
 * hand-edited (or hand-written) and is left alone with a warning. Writes obey
 * the bundle writer's rules: contained under the project root, never through
 * a symlink.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  getAgentSkill,
  getAgentSkillsPackageVersion,
} from '@happyvertical/smrt-dev-mcp/agent-skills';
import { assertNotSymlink, containedPath } from './docs-knowledge-bundle.js';

/** Harness directories that receive each skill, relative to the project root. */
export const SKILL_INSTALL_DIRS = ['.claude/skills', '.agents/skills'] as const;

/** Prefix of the marker line; the rest carries the producer and version. */
/** Where the shipped skill text says the knowledge bundle lives. */
const DEFAULT_BUNDLE_DIR = '.agents/smrt-knowledge';

export const SKILL_MARKER_PREFIX = '<!-- smrt-generated:';

export type SkillInstallStatus =
  | 'installed'
  | 'updated'
  | 'unchanged'
  | 'skipped-hand-edited';

export interface SkillInstallResult {
  skill: string;
  path: string;
  status: SkillInstallStatus;
}

/**
 * Inserts the generated marker after the frontmatter, which must stay the
 * first thing in the file for skill-aware harnesses.
 */
export function withGeneratedMarker(
  markdown: string,
  skill: string,
  version: string,
  generatedBy: string,
): string {
  const marker = `${SKILL_MARKER_PREFIX} ${generatedBy} from @happyvertical/smrt-dev-mcp@${version}; ${skill}; edits are overwritten on rerun, remove this line to keep a local copy -->`;
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(markdown);
  if (!frontmatter) return `${marker}\n${markdown}`;
  const end = frontmatter[0].length;
  return `${markdown.slice(0, end)}\n${marker}\n${markdown.slice(end)}`;
}

function hasMarker(text: string): boolean {
  return text
    .split(/\r?\n/)
    .some((line) => line.startsWith(SKILL_MARKER_PREFIX));
}

/** Refuses when the file or any directory between `root` and it is a symlink. */
function assertNoSymlinkOnPath(root: string, target: string): void {
  const rel = relative(resolve(root), target);
  let current = resolve(root);
  for (const segment of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    assertNotSymlink(current);
  }
}

/**
 * Installs `skills` under every harness directory of `projectRoot`. Existing
 * unmarked copies are skipped (and reported through `warn`) unless they are
 * already byte-identical to what would be written.
 */
export function installAgentSkills(options: {
  projectRoot: string;
  skills: string[];
  /**
   * Bundle directory relative to `projectRoot` (default `.agents/smrt-knowledge`).
   * The shipped skill text names the default; other locations are substituted.
   */
  bundleDir?: string;
  generatedBy: string;
  warn?: (message: string) => void;
}): SkillInstallResult[] {
  const warn = options.warn ?? console.warn;
  const version = getAgentSkillsPackageVersion();
  const normalizedBundle = options.bundleDir
    ?.split(sep)
    .join('/')
    .replace(/\/+$/, '');
  const bundleRef =
    normalizedBundle && normalizedBundle !== DEFAULT_BUNDLE_DIR
      ? normalizedBundle
      : undefined;
  const results: SkillInstallResult[] = [];

  // Resolve and contain every destination before anything is written.
  const plan = options.skills.flatMap((skill) => {
    const shipped = getAgentSkill({
      name: skill,
      includeReferences: false,
    }).skillMarkdown;
    const source = bundleRef
      ? shipped.split(DEFAULT_BUNDLE_DIR).join(bundleRef)
      : shipped;
    const body = withGeneratedMarker(
      source,
      skill,
      version,
      options.generatedBy,
    );
    return SKILL_INSTALL_DIRS.map((dir) => {
      const target = containedPath(
        options.projectRoot,
        join(dir, skill, 'SKILL.md'),
      );
      assertNoSymlinkOnPath(options.projectRoot, target);
      return { skill, target, body, source };
    });
  });

  for (const { skill, target, body, source } of plan) {
    const shown = relative(resolve(options.projectRoot), target);
    let status: SkillInstallStatus = 'installed';
    if (existsSync(target)) {
      const existing = readFileSync(target, 'utf8');
      // A checked-in copy identical to the shipped skill (this repository's
      // own .agents/skills/smrt-contribute) is already current, not hand-edited.
      if (existing === body || existing === source) {
        results.push({ skill, path: shown, status: 'unchanged' });
        continue;
      }
      if (!hasMarker(existing)) {
        warn(
          `   ⚠️  ${shown} has no smrt-generated marker; leaving it alone (delete it to let docs:agents manage it)`,
        );
        results.push({ skill, path: shown, status: 'skipped-hand-edited' });
        continue;
      }
      status = 'updated';
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body, 'utf8');
    results.push({ skill, path: shown, status });
  }
  return results;
}
