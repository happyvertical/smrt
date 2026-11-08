/**
 * Alias config validation and chain expansion (#4752).
 */
import type { InferenceConfig } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  expandTarget,
  findInferenceConfigIssues,
  hasInferenceChains,
  validateInferenceConfig,
} from '../config.js';
import { InferenceConfigError } from '../errors.js';

const KEY_ENV = 'SMRT_TEST_4752_KEY';

afterEach(() => {
  delete process.env[KEY_ENV];
});

describe('findInferenceConfigIssues', () => {
  it('accepts a valid alias chain and tier bindings', () => {
    const config: InferenceConfig = {
      aliases: {
        frontier: {
          candidates: [
            { provider: 'anthropic', model: 'claude-x' },
            { preset: 'openrouter', model: 'some/model', apiKeyEnv: KEY_ENV },
            { alias: 'local' },
          ],
        },
        local: { candidates: [{ preset: 'lemonade', model: 'qwen' }] },
      },
      tiers: {
        great: { alias: 'frontier' },
        cheap: { candidates: [{ provider: 'openai', model: 'mini' }] },
        good: { provider: 'openai', model: 'mid' },
      },
    };
    expect(findInferenceConfigIssues(config)).toEqual([]);
    expect(hasInferenceChains(config)).toBe(true);
  });

  it('names an alias with no candidates', () => {
    const issues = findInferenceConfigIssues({
      aliases: { frontier: { candidates: [] } },
    });
    expect(issues).toEqual([
      expect.objectContaining({
        code: 'alias-empty',
        path: 'inference.aliases.frontier.candidates',
      }),
    ]);
  });

  it('names a tier pointing at an unknown alias, and a nested unknown alias', () => {
    const issues = findInferenceConfigIssues({
      aliases: { a: { candidates: [{ alias: 'nope' }] } },
      tiers: { best: { kind: 'alias', alias: 'missing' } },
    });
    expect(issues.map((issue) => [issue.code, issue.path])).toEqual([
      ['alias-unknown', 'inference.aliases.a.candidates[0]'],
      ['alias-unknown', 'inference.tiers.best'],
    ]);
    expect(issues[1]?.message).toContain('"missing"');
  });

  it('names a cycle with its path, once', () => {
    const issues = findInferenceConfigIssues({
      aliases: {
        a: { candidates: [{ alias: 'b' }] },
        b: { candidates: [{ alias: 'c' }] },
        c: { candidates: [{ alias: 'a' }] },
      },
    });
    const cycles = issues.filter((issue) => issue.code === 'alias-cycle');
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toContain('a -> b -> c -> a');
  });

  it('refuses a key without its own endpoint, unknown presets and empty candidates', () => {
    const issues = findInferenceConfigIssues({
      tiers: {
        great: {
          candidates: [
            { provider: 'anthropic', model: 'x', apiKeyEnv: KEY_ENV },
            { preset: 'nope', model: 'x' },
            {},
            { alias: 'x', provider: 'openai' },
          ],
        },
      },
    });
    expect(issues.map((issue) => issue.code)).toEqual([
      'candidate-key-without-endpoint',
      'preset-unknown',
      'candidate-invalid',
      'alias-unknown',
      'candidate-invalid',
    ]);
  });

  it('validateInferenceConfig throws one error naming every offender', () => {
    expect(() =>
      validateInferenceConfig({
        aliases: { a: { candidates: [] } },
        tiers: { great: { alias: 'b' } },
      }),
    ).toThrow(InferenceConfigError);
    try {
      validateInferenceConfig({
        aliases: { a: { candidates: [] } },
        tiers: { great: { alias: 'b' } },
      });
    } catch (error) {
      expect((error as InferenceConfigError).issues).toHaveLength(2);
      expect((error as Error).message).toContain('inference.aliases.a');
      expect((error as Error).message).toContain('inference.tiers.great');
    }
  });

  it('reports no chains for a config without aliases or chain targets', () => {
    expect(hasInferenceChains(undefined)).toBe(false);
    expect(
      hasInferenceChains({ tiers: { good: { provider: 'openai' } } }),
    ).toBe(false);
  });
});

describe('expandTarget', () => {
  const config: InferenceConfig = {
    aliases: {
      frontier: {
        candidates: [
          { provider: 'anthropic', model: 'big', params: { temperature: 0 } },
          { alias: 'local' },
          {
            provider: 'openai',
            model: 'gpt',
            baseUrl: 'https://proxy.example/v1',
            apiKeyEnv: KEY_ENV,
          },
        ],
      },
      local: { candidates: [{ preset: 'lemonade', model: 'qwen' }] },
    },
  };

  it('expands nested aliases in order with key-free labels', () => {
    process.env[KEY_ENV] = 'sk-secret';
    const steps = expandTarget({ alias: 'frontier' }, 'great', config);
    expect(steps.map((step) => step.label)).toEqual([
      'anthropic/big',
      'preset:lemonade/qwen',
      'openai/gpt',
    ]);
    expect(steps[0]?.params).toEqual({ temperature: 0 });
    expect(steps[1]?.target).toEqual({
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:13305/v1',
      model: 'qwen',
      apiKey: 'smrt-local',
    });
    expect(steps[2]?.target.apiKey).toBe('sk-secret');
    expect(steps[2]?.unavailable).toBeUndefined();
    expect(JSON.stringify(steps.map((step) => step.label))).not.toContain(
      'sk-secret',
    );
  });

  it('never drops a key: a key without its own baseUrl stays on the target', () => {
    process.env[KEY_ENV] = 'sk-secret';
    const [step] = expandTarget(
      { candidates: [{ provider: 'openai', model: 'm', apiKeyEnv: KEY_ENV }] },
      'good',
      undefined,
    );
    // Core's pair rule then refuses it instead of using the configured key.
    expect(step?.target).toEqual({
      provider: 'openai',
      model: 'm',
      apiKey: 'sk-secret',
    });
  });

  it('marks a candidate whose key variable is unset as a credential failure', () => {
    const steps = expandTarget({ alias: 'frontier' }, 'great', config);
    expect(steps[2]?.unavailable).toBe('credential');
  });

  it('marks a key-requiring preset without a key unavailable', () => {
    const [step] = expandTarget(
      { candidates: [{ preset: 'openrouter', model: 'm' }] },
      'good',
      config,
    );
    expect(step?.unavailable).toBe('credential');
  });

  it('treats an empty single target as the configured client', () => {
    const [step] = expandTarget({}, 'good', undefined);
    expect(step?.label).toBe('default');
    expect(step?.target).toEqual({});
  });

  it('throws on a cycle at expansion time', () => {
    expect(() =>
      expandTarget({ alias: 'a' }, 'good', {
        aliases: { a: { candidates: [{ alias: 'a' }] } },
      }),
    ).toThrow(InferenceConfigError);
  });
});
