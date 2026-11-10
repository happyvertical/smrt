import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer } from 'vite';
import { expect, it } from 'vitest';

it('server-renders the first open record with recommended option first and no motion', async () => {
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'silent',
    plugins: [svelte()],
    server: { middlewareMode: true },
  });
  try {
    const [{ default: Component }, { render }] = await Promise.all([
      server.ssrLoadModule('/src/svelte/ProjectInterview.svelte'),
      server.ssrLoadModule('svelte/server'),
    ]);
    const { body } = render(Component, {
      props: {
        questions: [
          {
            id: 'done',
            prompt: 'Already answered?',
            status: 'answered',
            answer: 'Yes',
            revision: 2,
          },
          {
            id: 'cadence',
            prompt: 'How often should we report?',
            status: 'open',
            revision: 1,
            canResolve: true,
            options: [
              { id: 'monthly', label: 'Monthly' },
              { id: 'weekly', label: 'Weekly', recommended: true },
            ],
          },
        ],
        framing: {
          cadence: {
            why: 'Sets the reporting rhythm.',
            unblocks: ['Status report template'],
          },
        },
      },
    });
    expect(body).toContain('data-smrt-component="ProjectInterview"');
    expect(body).toContain('data-motion="off"');
    expect(body).toContain('How often should we report?');
    expect(body).not.toContain('Already answered?');
    expect(body).toContain('Question 2 of 2');
    expect(body).toContain('1 of 2 answered');
    expect(body).toContain('Sets the reporting rhythm.');
    expect(body).toContain('Status report template');
    const radios = body.match(/<input\b[^>]*type="radio"[^>]*>/g) ?? [];
    expect(radios.map((radio) => radio.match(/value="([^"]+)"/)?.[1])).toEqual([
      'weekly',
      'monthly',
      'other',
    ]);
    for (const radio of radios) {
      expect(radio).not.toMatch(/\schecked(?:\s|=|>)/);
    }
  } finally {
    await server.close();
  }
});
