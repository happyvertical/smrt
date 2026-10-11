import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { aiState } from '../src/lib/ai/instance.ts';
import AiSetup from '../src/lib/components/AiSetup.svelte';

describe('AI setup page by mode', () => {
  it('byo: presets, model and key fields, Test connection and CORS guidance', () => {
    aiState.configure({ config: { mode: 'byo' } });
    const { body } = render(AiSetup, { props: { show: ['think'] } });
    for (const text of [
      'Ollama',
      'OpenRouter',
      'OpenAI',
      'Custom OpenAI-compatible endpoint',
      'Test connection',
      'Use this model',
      'Browser access',
      'OLLAMA_ORIGINS',
      'Think',
    ]) {
      expect(body, text).toContain(text);
    }
    // Ollama is first and keyless: no key field until a keyed preset is chosen.
    expect(body).not.toContain('id="byo-key"');
    expect(body).toContain('Your model');
  });

  it('host: names the server and shows no download', () => {
    aiState.configure({
      config: { mode: 'host', host: { endpoint: '/api/planner/chat' } },
    });
    const { body } = render(AiSetup, { props: { show: ['think'] } });
    expect(body).toContain('This site');
    expect(body).not.toContain('Download');
  });

  it('shows the notice when the config was unusable', () => {
    aiState.configure({
      config: { mode: 'browser' },
      notice:
        'The assistant settings could not be used (x), so it runs in your browser instead.',
    });
    const { body } = render(AiSetup, { props: { show: ['think'] } });
    expect(body).toContain('runs in your browser instead');
  });
});
