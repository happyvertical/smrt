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

  it('hosted policy starts with BYO and offers explicit WebLLM and manual choices', () => {
    aiState.configure({
      config: {
        mode: 'byo',
        alternatives: ['browser'],
        credentialPersistence: 'memory',
        byo: { presets: ['openai'] },
      },
    });
    const initial = render(AiSetup, { props: { show: ['think'] } }).body;
    expect(initial).toContain('Assistant mode');
    expect(initial).toContain('Your model');
    expect(initial).toContain('In-browser model (WebLLM)');
    expect(initial).toContain('Manual planning');
    expect(initial).toContain('Kept only in this tab until reload');

    aiState.selectInference('manual');
    const manual = render(AiSetup, { props: { show: ['think'] } }).body;
    expect(manual).toContain('Inference off');
    expect(manual).toContain('provider is contacted');
    expect(manual).not.toContain('Download');
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
        'The assistant settings could not be used (x), so inference is off. The planner still works manually.',
    });
    const { body } = render(AiSetup, { props: { show: ['think'] } });
    expect(body).toContain('inference is off');
  });
});
