import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface AgentSkillSummary {
  name: string;
  description: string;
  path: string;
  references: string[];
}

export interface AgentSkillBundle extends AgentSkillSummary {
  skillMarkdown: string;
  referenceFiles: Array<{
    path: string;
    content: string;
  }>;
}

interface AgentSkillDefinition extends AgentSkillSummary {
  skillFile: string;
}

const AGENT_SKILLS: AgentSkillDefinition[] = [
  {
    name: 'smrt-review',
    description:
      'Harness-agnostic downstream SMRT code review workflow using smrt-dev-mcp deterministic context and prompt bundles.',
    path: 'agent-skills/smrt-review/SKILL.md',
    skillFile: 'agent-skills/smrt-review/SKILL.md',
    references: ['agent-skills/smrt-review/references/review-output.md'],
  },
];

export function listAgentSkills(): AgentSkillSummary[] {
  return AGENT_SKILLS.map(({ skillFile: _skillFile, ...skill }) => skill);
}

export function getAgentSkill(options: {
  name: string;
  includeReferences?: boolean;
}): AgentSkillBundle {
  const skill = AGENT_SKILLS.find((item) => item.name === options.name);
  if (!skill) {
    throw new Error(`Unknown agent skill: ${options.name}`);
  }

  return {
    name: skill.name,
    description: skill.description,
    path: skill.path,
    references: skill.references,
    skillMarkdown: readPackageFile(skill.skillFile),
    referenceFiles:
      options.includeReferences === false
        ? []
        : skill.references.map((path) => ({
            path,
            content: readPackageFile(path),
          })),
  };
}

function readPackageFile(relativePath: string): string {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  return readFileSync(join(packageRoot, relativePath), 'utf8');
}
