/**
 * Capability checks in the chain walk and the doctor (#4758): a candidate
 * that lacks a required capability is a `missing-capability` substitution
 * and is never called; a permitted fallback runs it without the feature,
 * tagged; fusion JSON seats use the text recovery path; the doctor prints
 * capabilities and their source.
 */
import {
  type InferenceCallOptions,
  type InferenceCapabilities,
  type InferenceConfig,
  type InferenceExecutionContext,
  type InferenceTarget,
  InferenceUnavailableError,
  type InferenceUsageRecord,
  resolveInferenceFromConfig,
} from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { classifyInferenceFailure } from '../classify.js';
import { InferenceExhaustedError } from '../errors.js';
import { createChainClient } from '../executor.js';
import {
  checkInferenceBindings,
  formatInferenceDoctorReport,
  inferenceCapabilitiesFromModelListing,
} from '../node.js';
import { INFERENCE_FAILURE_CLASSES } from '../types.js';

const FULL: InferenceCapabilities = {
  json: true,
  tools: true,
  vision: true,
  source: 'provider',
};
const TEXT_ONLY: InferenceCapabilities = {
  json: false,
  tools: false,
  vision: false,
  maxContext: 4096,
  source: 'assumed',
};

const TOOL = {
  type: 'function',
  function: { name: 'lookup', parameters: { type: 'object' } },
};

function harness(
  models: Array<string | { model: string; params: Record<string, unknown> }>,
  capabilities: Record<string, InferenceCapabilities>,
) {
  const config: InferenceConfig = {
    tiers: {
      great: {
        candidates: models.map((entry) =>
          typeof entry === 'string'
            ? { provider: 'openai', model: entry }
            : { provider: 'openai', ...entry },
        ),
      },
    },
    degrade: false,
  };
  const calls: Array<{ model: string; options: InferenceCallOptions }> = [];
  const usage: InferenceUsageRecord[] = [];
  const probed: string[] = [];
  const context: InferenceExecutionContext = {
    request: { tier: 'great' },
    resolution: resolveInferenceFromConfig({ tier: 'great' }, config),
    config,
    clientFor: async (target: InferenceTarget) => ({
      message: async (_text: string, options: InferenceCallOptions = {}) => {
        const model = String(options.model ?? target.model);
        calls.push({ model, options });
        return `answer from ${model}`;
      },
    }),
    capabilitiesFor: async (target) => {
      probed.push(String(target.model));
      return capabilities[String(target.model)] ?? FULL;
    },
    resolveTier: async (next) =>
      resolveInferenceFromConfig({ tier: next }, config),
    recordUsage: async (record) => {
      usage.push(record);
    },
  };
  return {
    client: createChainClient(context, {
      retryDelayMs: () => 0,
      sleep: async () => {},
      now: () => 0,
    }),
    calls,
    usage,
    probed,
  };
}

describe('missing-capability in the chain walk', () => {
  it('is a failure class', () => {
    expect(INFERENCE_FAILURE_CLASSES).toContain('missing-capability');
    expect(
      classifyInferenceFailure(
        new InferenceUnavailableError({
          reason: 'capability',
          message: 'no tools',
        }),
      ),
    ).toBe('missing-capability');
  });

  it('advances past a candidate without JSON mode before calling it', async () => {
    const h = harness(['small', 'big'], { small: TEXT_ONLY });
    await expect(
      h.client.message('hi', { responseFormat: { type: 'json_object' } }),
    ).resolves.toBe('answer from big');
    expect(h.calls.map((call) => call.model)).toEqual(['big']);
    expect(
      JSON.parse(String(h.calls[0]?.options.usageTags?.substitutions)),
    ).toEqual([
      {
        from: 'openai/small',
        to: 'openai/big',
        reason: 'missing-capability',
      },
    ]);
  });

  it('advances past a candidate without tools when tools are required', async () => {
    const h = harness(['small', 'big'], { small: TEXT_ONLY });
    await h.client.message('hi', { tools: [TOOL] });
    expect(h.calls.map((call) => call.model)).toEqual(['big']);
    expect(h.calls[0]?.options.tools).toEqual([TOOL]);
  });

  it('exhausts with missing-capability when no candidate fits', async () => {
    const h = harness(['a', 'b'], { a: TEXT_ONLY, b: TEXT_ONLY });
    const error = await h.client
      .message('hi', { tools: [TOOL] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InferenceExhaustedError);
    expect((error as InferenceExhaustedError).reason).toBe(
      'missing-capability',
    );
    expect(h.calls).toEqual([]);
    expect(h.usage[0]?.tags.reason).toBe('missing-capability');
  });

  it('applies permitted fallbacks per candidate, tagged, and strips the option', async () => {
    const h = harness(['small'], { small: TEXT_ONLY });
    await h.client.message('hi', {
      responseFormat: { type: 'json_object' },
      tools: [TOOL],
      capabilityFallback: { json: 'text', tools: 'drop' },
    });
    const options = h.calls[0]?.options ?? {};
    expect(h.calls.map((call) => call.model)).toEqual(['small']);
    expect(options).not.toHaveProperty('responseFormat');
    expect(options).not.toHaveProperty('tools');
    expect(options).not.toHaveProperty('capabilityFallback');
    expect(options.usageTags?.capabilityFallback).toBe('json→text,tools→none');
  });

  it("checks and strips a candidate's own params, not only caller options", async () => {
    const jsonParams = { responseFormat: { type: 'json_object' } };
    const skipped = harness([{ model: 'small', params: jsonParams }, 'big'], {
      small: TEXT_ONLY,
    });
    await skipped.client.message('hi');
    expect(skipped.calls.map((call) => call.model)).toEqual(['big']);

    const degraded = harness(
      [{ model: 'small', params: { ...jsonParams, tools: [TOOL] } }],
      { small: TEXT_ONLY },
    );
    await degraded.client.message('hi', {
      capabilityFallback: { json: 'text', tools: 'drop' },
    });
    expect(degraded.calls[0]?.options).not.toHaveProperty('responseFormat');
    expect(degraded.calls[0]?.options).not.toHaveProperty('tools');
    expect(degraded.calls[0]?.options.usageTags?.capabilityFallback).toBe(
      'json→text,tools→none',
    );
  });

  it('leaves capable candidates and plain calls untouched', async () => {
    const h = harness(['big'], {});
    await h.client.message('hi', {
      responseFormat: { type: 'json_object' },
      capabilityFallback: { json: 'text' },
    });
    expect(h.calls[0]?.options.responseFormat).toEqual({
      type: 'json_object',
    });
    expect(h.calls[0]?.options.usageTags).not.toHaveProperty(
      'capabilityFallback',
    );
    expect(h.calls[0]?.options).not.toHaveProperty('capabilityFallback');

    const plain = harness(['big'], {});
    await plain.client.message('hi');
    // No requirement, no detection.
    expect(plain.probed).toEqual([]);
  });
});

describe('doctor capabilities', () => {
  it('reads OpenRouter-style and llama.cpp listings', () => {
    expect(
      inferenceCapabilitiesFromModelListing(
        {
          data: [
            {
              id: 'm',
              context_length: 8192,
              supported_parameters: ['tools', 'temperature'],
              architecture: { input_modalities: ['text'] },
            },
          ],
        },
        'm',
      ),
    ).toEqual({ maxContext: 8192, tools: true, json: false, vision: false });
    expect(
      inferenceCapabilitiesFromModelListing(
        { data: [{ id: 'q', meta: { n_ctx_train: 32768 } }] },
        'q',
      ),
    ).toEqual({ maxContext: 32768 });
    expect(
      inferenceCapabilitiesFromModelListing({ data: [{ id: 'x' }] }, 'q'),
    ).toBeUndefined();
  });

  it('prints each candidate capabilities and source with --probe, never keys', async () => {
    const fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: 'qwen-small', max_context_length: 4096 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as unknown as typeof globalThis.fetch;
    const report = await checkInferenceBindings({
      config: {
        tiers: {
          cheap: { candidates: [{ preset: 'lm-studio', model: 'qwen-small' }] },
          good: {
            candidates: [
              {
                provider: 'openai',
                model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC',
                baseUrl: 'http://127.0.0.1:9999/v1',
                apiKey: 'sk-secret-value',
              },
            ],
          },
        },
      },
      env: {},
      probe: true,
      fetch,
    });
    const cheap = report.bindings.find((b) => b.binding === 'tier:cheap');
    expect(cheap?.candidates[0]?.capabilities).toEqual({
      json: false,
      tools: true,
      vision: true,
      maxContext: 4096,
      source: 'preset',
    });
    const good = report.bindings.find((b) => b.binding === 'tier:good');
    expect(good?.candidates[0]?.capabilities).toMatchObject({
      json: false,
      tools: false,
      source: 'assumed',
    });
    const lines = formatInferenceDoctorReport(report).join('\n');
    expect(lines).toContain(
      'capabilities: json no, tools yes, vision yes, context 4096 (source: preset)',
    );
    expect(lines).not.toContain('sk-secret-value');
  });
});
