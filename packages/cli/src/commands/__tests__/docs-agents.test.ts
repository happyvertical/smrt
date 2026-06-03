import { describe, expect, it } from 'vitest';
import { docsCommands } from '../docs-claude.js';

describe('docs command registration', () => {
  it('registers docs:agents and deprecated docs:claude alias', () => {
    expect(docsCommands['docs:agents']).toBeDefined();
    expect(docsCommands['docs:claude']).toBeDefined();
    expect(docsCommands['docs:claude'].description).toContain('Deprecated');
  });
});
