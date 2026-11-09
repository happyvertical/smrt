/**
 * The two starter templates carry the AGENTS.md block (#4878 item D). The
 * block must stay byte-identical to what `smrt docs:agents` would write for a
 * version-less render, so the first refresh finds nothing but the version to
 * change.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectMarkers, renderAgentsBlock } from '../docs-agents-block.js';

const packages = fileURLToPath(new URL('../../../../', import.meta.url));
const TEMPLATES = ['template-sveltekit', 'template-site-static-json'] as const;

const expected = renderAgentsBlock({
  frameworkPath: '.agents/smrt-framework.md',
  intentIndexPath: '.agents/smrt-knowledge/intents/index.md',
});

describe.each(TEMPLATES)('%s template AGENTS.md block', (name) => {
  const text = readFileSync(`${packages}${name}/template/AGENTS.md`, 'utf-8');

  it('has well-formed markers', () => {
    expect(inspectMarkers(text).state).toBe('ok');
  });

  it('is byte-identical to the generator output, at most 15 lines', () => {
    expect(text).toContain(expected);
    expect(expected.split('\n').length).toBeLessThanOrEqual(15);
  });

  it('sits directly after the first H1', () => {
    const [h1, blank, begin] = text.split('\n');
    expect(h1.startsWith('# ')).toBe(true);
    expect(blank).toBe('');
    expect(begin).toBe(expected.split('\n')[0]);
  });
});

describe.each(TEMPLATES)('%s template package.json', (name) => {
  it('exposes the docs:agents script', () => {
    const pkg = JSON.parse(
      readFileSync(`${packages}${name}/template/package.json`, 'utf-8'),
    );
    expect(pkg.scripts['docs:agents']).toBe('smrt docs:agents');
  });
});
