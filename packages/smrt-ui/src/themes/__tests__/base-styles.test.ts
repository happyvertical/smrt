import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  join(process.cwd(), 'src/themes/styles/base.css'),
  'utf8',
);

describe('application baseline styles', () => {
  it('removes document margins and uses border-box sizing', () => {
    expect(css).toMatch(
      /\*,\s*\*::before,\s*\*::after\s*{[^}]*box-sizing:\s*border-box/s,
    );
    expect(css).toMatch(
      /html,\s*body\s*{[^}]*min-block-size:\s*100%[^}]*margin:\s*0/s,
    );
  });

  it('applies the active theme surface and typography to the document', () => {
    expect(css).toMatch(
      /body\s*{[^}]*background:\s*var\(--smrt-color-background\)/s,
    );
    expect(css).toMatch(
      /body\s*{[^}]*color:\s*var\(--smrt-color-on-background\)/s,
    );
    expect(css).toMatch(/body\s*{[^}]*font-family:\s*var\(--smrt-font-family/s);
  });

  it('makes native controls inherit the application typography', () => {
    expect(css).toMatch(
      /button,\s*input,\s*select,\s*textarea\s*{[^}]*font:\s*inherit/s,
    );
  });

  it('does not erase semantic list markers', () => {
    expect(css).not.toMatch(/(?:ul|ol)[^{]*{[^}]*list-style:\s*none/s);
  });
});
