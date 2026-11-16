import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  getAgentSkill,
  getAgentSkillsPackageVersion,
  listAgentSkills,
} from './agent-skills.js';
import { TOOLS } from './tool-catalog.js';

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

describe('smrt-contribute (#4709)', () => {
  const evals = readEvals('smrt-contribute') as unknown as {
    positive: Array<{ prompt: string; context: string }>;
    negative: Array<{ prompt: string; context: string }>;
  };
  const skill = getAgentSkill({ name: 'smrt-contribute' });
  const description = (
    skill.skillMarkdown.match(/^description: (.+)$/m)?.[1] ?? ''
  ).toLowerCase();

  it('is registered and covers the contributor traps', () => {
    expect(listAgentSkills().map((item) => item.name)).toContain(
      'smrt-contribute',
    );
    const body = skill.skillMarkdown;
    for (const trap of [
      '--filter @happyvertical/smrt-',
      'pnpm format',
      'pnpm lint',
      'knowledge:check',
      'knowledge:okf',
      '92',
      '.changeset',
      'README',
      '--no-verify',
      'ci: fork-approved',
      '.github/',
      'check:agents-chain',
    ]) {
      expect(body, `missing ${trap}`).toContain(trap);
    }
  });

  it('does not publish the maintainer lifecycle as instructions', () => {
    // Mentioned only to say it does not apply.
    expect(skill.skillMarkdown).toContain('does not apply to you');
    expect(skill.skillMarkdown).not.toMatch(/add `agent: implementation`/);
  });

  it('names fork and clone contexts and excludes consumers and maintainers', () => {
    expect(description).toContain('fork or clone');
    expect(description).toContain('happyvertical/smrt');
    expect(description).toContain('merely depends on smrt packages');
    expect(description).toContain('maintainer session');
    expect(evals.positive.length).toBeGreaterThanOrEqual(5);
    expect(evals.negative.length).toBeGreaterThanOrEqual(5);
    for (const item of evals.positive) {
      expect(['fork', 'clone']).toContain(item.context);
    }
    const negativeContexts = evals.negative
      .map((item) => item.context)
      .join('|');
    expect(negativeContexts).toContain('consumer project');
    expect(negativeContexts).toContain('maintainer session');
  });

  it('keeps the repository copy identical to the packaged skill', () => {
    const repoCopy = join(
      packageRoot,
      '..',
      '..',
      '.agents',
      'skills',
      'smrt-contribute',
      'SKILL.md',
    );
    expect(readFileSync(repoCopy, 'utf8')).toBe(skill.skillMarkdown);
  });
});

describe('smrt-ai-work (#5005)', () => {
  const skill = getAgentSkill({ name: 'smrt-ai-work' });
  const body = skill.skillMarkdown;
  const evals = readEvals('smrt-ai-work');
  const description = (
    body.match(/^description: (.+)$/m)?.[1] ?? ''
  ).toLowerCase();

  it('is registered and served', () => {
    expect(listAgentSkills().map((item) => item.name)).toContain(
      'smrt-ai-work',
    );
    expect(body).toContain('name: smrt-ai-work');
  });

  it('produces a prompt, a tracked call and a workflow definition', () => {
    for (const term of [
      'definePrompt',
      'resolvePrompt',
      'trackedPromptCall',
      'createTrackedAiClient',
      'AiPromptKeyRequiredError',
      '@happyvertical/smrt-workflows',
      'createWorkflowRunDriver',
    ]) {
      expect(body, term).toContain(term);
    }
  });

  it('states the handler job contract', () => {
    for (const term of [
      'registerJobHandler',
      'enqueueHandlerJob',
      'JobHandlerRegistrationClosedError',
      'handlerUnclaimedDeadlineMs',
      'serializeAiRunContext',
    ]) {
      expect(body, term).toContain(term);
    }
  });

  it('explains runs, events, evaluations, tiers, latency, effort, budgets and fusions', () => {
    for (const term of [
      'Run',
      'getRunTrajectory',
      'recordAiEvaluation',
      'Tier, latency, effort',
      'maxTokens',
      'Fusion, seat',
      'https://happyvertical.github.io/smrt/ai-runs',
    ]) {
      expect(body, term).toContain(term);
    }
  });

  it('cites only sources a consuming project can reach', () => {
    const root = join(packageRoot, '..', '..');
    // No monorepo path: a consumer has no docs/ or packages/ checkout.
    expect(body).not.toMatch(/(?:^|[\s`(])(?:docs|packages)\//m);

    // An installed package's file: it exists and the package ships it.
    const packages = new Map<string, string>();
    for (const dir of readdirSync(join(root, 'packages'))) {
      const manifest = join(root, 'packages', dir, 'package.json');
      if (!existsSync(manifest)) continue;
      const { name } = JSON.parse(readFileSync(manifest, 'utf8'));
      packages.set(name, join(root, 'packages', dir));
    }
    const installed = [
      ...body.matchAll(/node_modules\/(@happyvertical\/[\w-]+)\/([\w./-]+)/g),
    ];
    expect(installed.length).toBeGreaterThan(0);
    for (const [cited, name, path] of installed) {
      const dir = packages.get(name as string);
      expect(dir, cited).toBeDefined();
      expect(existsSync(join(dir as string, path as string)), cited).toBe(true);
      const { files } = JSON.parse(
        readFileSync(join(dir as string, 'package.json'), 'utf8'),
      ) as { files: string[] };
      const top = (path as string).split('/')[0];
      expect(files, cited).toContain(top);
    }

    // A docs site page: the site's own URL, and a page that exists.
    const config = readFileSync(
      join(root, 'docs', 'docusaurus.config.ts'),
      'utf8',
    );
    expect(config).toContain("url: 'https://happyvertical.github.io'");
    expect(config).toContain("baseUrl: '/smrt/'");
    const pages = [
      ...body.matchAll(/https:\/\/happyvertical\.github\.io\/smrt\/([\w-]+)/g),
    ];
    expect(pages.length).toBeGreaterThan(0);
    for (const [url, slug] of pages) {
      expect(existsSync(join(root, 'docs', 'content', `${slug}.md`)), url).toBe(
        true,
      );
    }
  });

  it('has trigger evals the description covers', () => {
    expect(evals.positive.length).toBeGreaterThanOrEqual(5);
    expect(evals.negative.length).toBeGreaterThanOrEqual(3);
    for (const term of ['workflow', 'budgets', 'prompt', 'tracked call']) {
      expect(description, term).toContain(term);
    }
  });

  it('is served by the get-agent-skill tool schema', () => {
    const tool = TOOLS.find((item) => item.name === 'get-agent-skill');
    const properties = tool?.inputSchema.properties as
      | { name: { enum: string[] } }
      | undefined;
    const names = properties?.name.enum ?? [];
    expect([...names].sort()).toEqual(
      listAgentSkills()
        .map((item) => item.name)
        .sort(),
    );
  });

  it('routes from the catalog skill', () => {
    expect(getAgentSkill({ name: 'smrt-catalog' }).skillMarkdown).toContain(
      'smrt-ai-work',
    );
  });
});
