import { describe, expect, it, vi } from 'vitest';
import {
  FALLBACK_REPLY,
  parseChange,
  stripThinking,
} from '../src/lib/assistant/change.ts';
import {
  getModel,
  graphicsBufferLimit,
  hasRoomFor,
  ROOMY_MODEL_ID,
} from '../src/lib/assistant/models.ts';
import { buildSystemPrompt } from '../src/lib/assistant/prompt.ts';
import { withoutThinking } from '../src/lib/assistant/session.svelte.ts';
import { recipes } from '../src/lib/recipes/index.ts';

describe('parseChange never shows raw model output', () => {
  it('strips thinking, closed or cut off', () => {
    expect(stripThinking('<think>hmm</think>{"reply":"Hi"}')).toBe(
      '{"reply":"Hi"}',
    );
    expect(stripThinking('answer <think>never ends')).toBe('answer');
    expect(
      parseChange(
        '<think>x</think>{"reply":"Added.","add":[],"remove":[]}',
        recipes,
      ).reply,
    ).toBe('Added.');
  });

  it('pulls the reply out of cut-off JSON', () => {
    const cut = '{ "reply": "Out of the gun. Let\\u0027s go", "add": ["comm';
    expect(parseChange(cut, recipes).reply).toBe("Out of the gun. Let's go");
    expect(parseChange('{ "reply": "Half a sentence', recipes).reply).toBe(
      'Half a sentence',
    );
  });

  it('falls back to a short line when no reply can be found', () => {
    expect(parseChange('{ "add": ["x"', recipes).reply).toBe(FALLBACK_REPLY);
    expect(parseChange('[1, 2', recipes).reply).toBe(FALLBACK_REPLY);
  });

  it('keeps prose that has no JSON in it', () => {
    expect(parseChange('Sure thing.', recipes).reply).toBe('Sure thing.');
  });
});

describe('prompt', () => {
  const settings = { currency: 'USD', taxRate: 0, paymentTerms: '' };
  it('answers what was said, never repeats, and shows no "none" terms', () => {
    const prompt = buildSystemPrompt(recipes, [], [], settings);
    expect(prompt).toMatch(/what they just said/);
    expect(prompt).toMatch(/never repeat a reply/);
    expect(prompt).toMatch(/do not mention them otherwise/);
    expect(prompt).not.toMatch(/terms none/i);
    expect(prompt).not.toMatch(/get this sorted/i);
  });
});

describe('Qwen3 no-think switch', () => {
  it('adds /no_think for Qwen3 only', async () => {
    const message = vi.fn().mockResolvedValue('{}');
    await withoutThinking({ message }, 'Qwen3-1.7B-q4f16_1-MLC').message('hi');
    expect(message).toHaveBeenCalledWith('hi /no_think', undefined);
    const other = vi.fn().mockResolvedValue('{}');
    const chat = { message: other };
    expect(withoutThinking(chat, 'Llama-3.2-1B-Instruct-q4f16_1-MLC')).toBe(
      chat,
    );
  });
});

describe('roomy graphics suggestion', () => {
  it('suggests the larger model only with room for it', async () => {
    const big = getModel(ROOMY_MODEL_ID);
    expect(big).toBeDefined();
    if (!big) return;
    expect(hasRoomFor(big, 4_294_967_296)).toBe(true);
    expect(hasRoomFor(big, 2_147_483_648)).toBe(false);
    expect(hasRoomFor(big, 0)).toBe(false);
    expect(
      await graphicsBufferLimit({
        gpu: {
          requestAdapter: async () => ({ limits: { maxBufferSize: 123 } }),
        },
      }),
    ).toBe(123);
    expect(await graphicsBufferLimit({})).toBe(0);
  });
});
