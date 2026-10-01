/**
 * Touch targets: on phones (48rem and under) Button of every size and the
 * Switch row are at least 44px tall, and TagsInput's remove button is a 44px
 * target on phones and touch screens. The sizing lives in each component's
 * stylesheet, so an app never needs its own `min-height: 44px` override.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd().endsWith('packages/smrt-ui')
  ? process.cwd()
  : join(process.cwd(), 'packages/smrt-ui');
const read = (path: string) =>
  readFileSync(join(root, 'src/components', path), 'utf8');

/** The body of the first `@media (…max-width: 48rem…)` block in `source`. */
function phoneBlock(source: string): string {
  const start = source.indexOf('@media (max-width: 48rem)');
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf('\n  }', start) + 4);
}

describe('phone touch targets', () => {
  it('Button is at least 44px tall on phones, in every size', () => {
    const phone = phoneBlock(read('ui/Button.svelte'));
    expect(phone).toMatch(/\.button\s*\{[^}]*min-block-size:\s*2\.75rem/);
  });

  it('Switch is at least 44px tall on phones', () => {
    expect(read('forms/Switch.svelte')).toMatch(
      /@media \(max-width: 48rem\)\s*\{\s*\.switch\s*\{\s*min-block-size:\s*2\.75rem/,
    );
  });

  it('TagsInput remove buttons are 44px on phones and touch screens', () => {
    const source = read('forms/TagsInput.svelte');
    const start = source.indexOf(
      '@media (max-width: 48rem), (pointer: coarse)',
    );
    expect(start).toBeGreaterThan(-1);
    const block = source.slice(start, source.indexOf('\n  }', start));
    expect(block).toMatch(/\.tag button\s*\{[^}]*min-inline-size:\s*2\.75rem/);
    expect(block).toMatch(/\.tag button\s*\{[^}]*min-block-size:\s*2\.75rem/);
  });

  it('Dropdown menu rows are at least 44px tall', () => {
    expect(read('ui/Dropdown.svelte')).toMatch(
      /\.dropdown__item\s*\{[^}]*min-block-size:\s*2\.75rem/,
    );
  });
});
