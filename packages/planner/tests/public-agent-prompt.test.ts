import { describe, expect, it } from 'vitest';
import { buildAgentPrompt } from '../src/lib/cookbook/prompt.ts';
import { COOKBOOK_SCHEMA } from '../src/lib/cookbook/types.ts';
import * as coreApi from '../src/lib/core/index.ts';
import * as publicApi from '../src/lib/index.ts';

describe('public canonical coding-agent prompt', () => {
  it('exports the identical existing builder from root and Node-safe core', () => {
    expect(publicApi).toHaveProperty('buildAgentPrompt', buildAgentPrompt);
    expect(coreApi).toHaveProperty('buildAgentPrompt', buildAgentPrompt);
  });
  it('preserves the builder output and options for consumer exports', () => {
    const cookbook = {
      $schema: COOKBOOK_SCHEMA,
      version: 1 as const,
      recipes: [],
      features: [],
      policies: [],
    };
    const options = { fallbackName: 'Été studio', version: '0.57.17' };
    expect(coreApi.buildAgentPrompt(cookbook, options)).toEqual(
      buildAgentPrompt(cookbook, options),
    );
    expect(publicApi.buildAgentPrompt(cookbook, options)).toEqual(
      buildAgentPrompt(cookbook, options),
    );
  });
});
