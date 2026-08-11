import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVER_VERSION, TOOLS } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('smrt-dev-mcp tools', () => {
  it('lists deterministic knowledge, review, and architecture tools', () => {
    const names = TOOLS.map((tool) => tool.name);

    expect(names).toContain('reflect-knowledge');
    expect(names).toContain('reflect-domain-knowledge');
    expect(names).toContain('check-knowledge-freshness');
    expect(names).toContain('check-domain-knowledge');
    expect(names).toContain('build-review-context');
    expect(names).toContain('build-domain-review-context');
    expect(names).toContain('smrt-review');
    expect(names).toContain('build-architecture-context');
    expect(names).toContain('build-domain-architecture-context');
    expect(names).toContain('smrt-architecture');
    expect(names).toContain('review-smrt-project');
    expect(names).toContain('list-agent-skills');
    expect(names).toContain('get-agent-skill');
    expect(names).toEqual(
      expect.arrayContaining([
        'migration-status',
        'job-health',
        'schedule-health',
        'dispatch-health',
        'recent-changes',
        'registry-drift',
      ]),
    );

    for (const tool of TOOLS) {
      expect(tool.inputSchema.$schema).toBe(
        'https://json-schema.org/draft/2020-12/schema',
      );
      expect(tool.outputSchema).toMatchObject({
        type: 'object',
        required: ['ok', 'coverage', 'diagnostics', 'data'],
      });
    }
  });

  it('advertises the package version', () => {
    const packageJson = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'),
    ) as { version: string };

    expect(SERVER_VERSION).toBe(packageJson.version);
  });
});
