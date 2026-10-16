import { describe, expect, it } from 'vitest';
import { highlightCss } from '../src/lib/theme/css-highlight.ts';

describe('CSS editor highlighting', () => {
  it('keeps every character while marking selectors, properties, values, and comments', () => {
    const css = '/* note */\n.card { color: #abc; content: "<b>"; }';
    const tokens = highlightCss(css);
    expect(tokens.map((token) => token.text).join('')).toBe(css);
    expect(tokens).toContainEqual({ text: '/* note */', kind: 'comment' });
    expect(
      tokens.some(
        (token) => token.kind === 'selector' && token.text.includes('.card'),
      ),
    ).toBe(true);
    expect(
      tokens.some(
        (token) => token.kind === 'property' && token.text.includes('color'),
      ),
    ).toBe(true);
    expect(
      tokens.some(
        (token) => token.kind === 'value' && token.text.includes('#abc'),
      ),
    ).toBe(true);
  });
});
