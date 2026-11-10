import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

it('server-renders shared choice controls without selecting recommendations or hiding Other', async () => {
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'silent',
    plugins: [svelte()],
    server: { middlewareMode: true },
  });
  try {
    const [{ default: Component }, { render }] = await Promise.all([
      server.ssrLoadModule('/src/svelte/ProjectQuestionsAndDecisions.svelte'),
      server.ssrLoadModule('svelte/server'),
    ]);
    const { body } = render(Component, {
      props: {
        questions: [
          {
            id: 'choice',
            prompt: 'How often?',
            status: 'open',
            revision: 1,
            canResolve: true,
            options: [{ id: '15min', label: '15 minutes', recommended: true }],
          },
          {
            id: 'legacy',
            prompt: 'Legacy question?',
            status: 'open',
            revision: 1,
            canResolve: true,
          },
        ],
      },
    });
    const radios = body.match(/<input\b[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios).toHaveLength(2);
    for (const radio of radios) {
      expect(radio).toContain('name="selectedOptionId"');
      expect(radio).toContain('data-smrt-component="Input"');
      expect(radio).toMatch(/\srequired(?:\s|=|>)/);
      expect(radio).not.toMatch(/\schecked(?:\s|=|>)/);
    }
    expect(body).toContain('Recommended');
    expect(body).toContain('Other answer');
    expect(body).toMatch(/<textarea[^>]*id="answer-choice"/);
    expect(body).toMatch(/<textarea[^>]*id="answer-legacy"/);
  } finally {
    await server.close();
  }
});
