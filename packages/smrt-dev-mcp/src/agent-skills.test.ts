import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getAgentSkill,
  getAgentSkillsPackageVersion,
  listAgentSkills,
} from './agent-skills.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

interface CatalogEvals {
  positive: Array<{ prompt: string; signal: string }>;
  negative: Array<{ prompt: string; reason: string }>;
}

function readEvals(skill: string): CatalogEvals {
  return JSON.parse(
    readFileSync(join(packageRoot, 'skills', skill, 'evals.json'), 'utf8'),
  );
}

/** Words in the description that carry each positive signal class. */
const CATALOG_SIGNAL_TERMS: Record<string, string[]> = {
  jobs: ['background jobs', 'scheduled'],
  email: ['email', 'notifications'],
  storage: ['storage', 'uploads'],
  tenancy: ['tenancy', 'tenant'],
  money: ['money', 'price'],
  approvals: ['approvals'],
  audit: ['audit'],
  documents: ['document generation'],
};

describe('agent skill registry', () => {
  it('lists smrt-catalog beside smrt-code-review and serves its markdown', () => {
    const names = listAgentSkills().map((skill) => skill.name);
    expect(names).toEqual(
      expect.arrayContaining(['smrt-catalog', 'smrt-code-review']),
    );
    const skill = getAgentSkill({ name: 'smrt-catalog' });
    expect(skill.skillMarkdown).toContain('name: smrt-catalog');
    expect(skill.skillMarkdown).toContain(
      '.agents/smrt-knowledge/intents/index.md',
    );
    expect(skill.skillMarkdown).toContain('build-context');
    expect(skill.skillMarkdown).toContain('TEMPORARY');
  });

  it('reports the package version', () => {
    const manifest = JSON.parse(
      readFileSync(join(packageRoot, 'package.json'), 'utf8'),
    );
    expect(getAgentSkillsPackageVersion()).toBe(manifest.version);
  });
});

describe('smrt-catalog trigger evals', () => {
  const evals = readEvals('smrt-catalog');
  const description = (
    getAgentSkill({ name: 'smrt-catalog' }).skillMarkdown.match(
      /^description: (.+)$/m,
    )?.[1] ?? ''
  ).toLowerCase();

  it('has positive and negative prompts', () => {
    expect(evals.positive.length).toBeGreaterThanOrEqual(10);
    expect(evals.negative.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps the five canonical prompts in the positive set', () => {
    const prompts = evals.positive.map((item) => item.prompt);
    for (const prompt of [
      'add a nightly cleanup job',
      'send the customer a receipt email',
      'upload the logo to storage',
      'make this tenant-aware',
      'add a price field',
    ]) {
      expect(prompts).toContain(prompt);
    }
  });

  it('mentions every positive signal class in the description', () => {
    const signals = new Set(evals.positive.map((item) => item.signal));
    for (const signal of signals) {
      const terms = CATALOG_SIGNAL_TERMS[signal];
      expect(terms, `unknown signal class ${signal}`).toBeDefined();
      expect(
        terms.some((term) => description.includes(term)),
        `description does not mention ${signal}`,
      ).toBe(true);
    }
  });

  it('excludes ordinary feature work in the description', () => {
    expect(description).toContain('existing @smrt() object');
    expect(description).toContain('stay silent');
  });
});
