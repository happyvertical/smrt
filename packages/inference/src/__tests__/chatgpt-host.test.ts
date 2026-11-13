// The settings host installs the ChatGPT plan resolver outside the user
// resolver, so only a call that asks for the plan is moved onto it.
import {
  getInferenceResolver,
  type InferenceRequest,
  type InferenceResolverContext,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createInferenceSettingsHost } from '../server.js';

const before = getInferenceResolver();
afterEach(() => setInferenceResolver(before));

describe('the settings host with chatgptPlan', () => {
  it('answers a call that asked for the plan with a chatgpt-plan target', async () => {
    createInferenceSettingsHost({
      database: async () => {
        throw new Error('no database in this test');
      },
      overrides: () => ({}),
      chatgptPlan: {
        connection: {
          status: async () => ({ signedIn: true, signingIn: false }),
          defaultModel: async () => 'gpt-x',
        },
        appliesTo: (request) => request.className === 'Chosen',
      },
    }).install();
    const out = await getInferenceResolver()?.resolve(
      { tier: 'good', className: 'Chosen' } as InferenceRequest,
      {} as InferenceResolverContext,
    );
    expect(out?.target).toMatchObject({
      provider: 'chatgpt-plan',
      model: 'gpt-x',
    });
  });
});
