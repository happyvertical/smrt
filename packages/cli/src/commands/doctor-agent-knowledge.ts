/**
 * `smrt doctor` "Agent knowledge" section (#4878 item C).
 *
 * Read-only and warning-level: a missing or stale exported bundle, a missing
 * AGENTS.md block, or a missing `smrt-catalog` skill (each harness directory
 * separately) never changes doctor's exit code. Every message names
 * `smrt docs:agents`.
 *
 * Applies only where a `@happyvertical/smrt*` package is installed, found with
 * the same root resolution as `docs:agents`: the pnpm workspace root and every
 * member when run inside a consumer workspace, the working directory otherwise.
 * Without one there is nothing to document and the section is skipped quietly.
 * `SMRT_AGENT_DOCS=off` does not silence doctor.
 */
import {
  AGENT_DOCS_SKILL,
  type AgentDocsInspection,
  inspectAgentDocs,
} from './docs-refresh.js';

export interface AgentKnowledgeSection {
  /** False when no smrt package is installed; nothing else is meaningful then. */
  applies: boolean;
  lines: string[];
  warnings: string[];
  passed: string[];
}

export function runAgentKnowledgeDoctorSection(
  cwd: string,
  inspect: (cwd: string) => AgentDocsInspection = inspectAgentDocs,
): AgentKnowledgeSection {
  const state = inspect(cwd);
  if (!state.installed) {
    return { applies: false, lines: [], warnings: [], passed: [] };
  }
  const warnings: string[] = [];
  if (state.bundle === 'missing') {
    warnings.push(
      'agent knowledge bundle is missing; run `smrt docs:agents` to export it',
    );
  } else if (state.bundle === 'stale') {
    warnings.push(
      `agent knowledge bundle is stale (${state.staleReasons[0] ?? 'installed versions changed'}); run \`smrt docs:agents\``,
    );
  }
  if (state.block === 'missing') {
    warnings.push(
      'AGENTS.md has no smrt block (<!-- smrt:agents:begin -->); run `smrt docs:agents`',
    );
  } else if (state.block === 'refused') {
    warnings.push(
      `AGENTS.md smrt block cannot be refreshed (${state.blockReason ?? 'damaged markers'}); fix the markers, then run \`smrt docs:agents\``,
    );
  }
  for (const skill of state.skills) {
    if (!skill.present) {
      warnings.push(
        `skill ${AGENT_DOCS_SKILL} is missing under ${skill.dir}; run \`smrt docs:agents\``,
      );
    }
  }
  return {
    applies: true,
    lines: warnings.map((warning) => `   ⚠️  ${warning}`),
    warnings,
    passed: warnings.length === 0 ? ['Agent knowledge'] : [],
  };
}
