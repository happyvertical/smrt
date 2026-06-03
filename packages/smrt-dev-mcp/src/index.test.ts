import { describe, expect, it } from 'vitest';
import { TOOLS } from './index.js';

describe('smrt-dev-mcp tools', () => {
  it('lists deterministic knowledge, review, and architecture tools', () => {
    const names = TOOLS.map((tool) => tool.name);

    expect(names).toContain('reflect-knowledge');
    expect(names).toContain('check-knowledge-freshness');
    expect(names).toContain('build-review-context');
    expect(names).toContain('smrt-review');
    expect(names).toContain('build-architecture-context');
    expect(names).toContain('smrt-architecture');
    expect(names).toContain('list-agent-skills');
    expect(names).toContain('get-agent-skill');
  });
});
