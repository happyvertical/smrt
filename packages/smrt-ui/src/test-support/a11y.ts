/**
 * Accessibility assertion helper for component golden tests (Sweep L4, #1423).
 *
 * Runs axe-core against a rendered container and fails the test with a readable
 * report if any violations are found. Use after a Testing Library `render()`:
 *
 *   const { container } = render(MyComponent, { props });
 *   await expectNoA11yViolations(container);
 *
 * `color-contrast` is disabled by default: jsdom has no layout/paint engine, so
 * contrast can't be computed and the rule produces non-deterministic noise.
 * Pass `{ rules: { 'color-contrast': { enabled: true } } }` to override.
 */
import axe from 'axe-core';
import { expect } from 'vitest';

export async function expectNoA11yViolations(
  container: HTMLElement,
  options: axe.RunOptions = {},
): Promise<void> {
  const results = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false } },
    ...options,
  });

  if (results.violations.length > 0) {
    const report = results.violations
      .map((v) => {
        const targets = v.nodes
          .map((n) => `      - ${n.target.join(' ')}`)
          .join('\n');
        return `  [${v.id}] ${v.help}\n    ${v.helpUrl}\n${targets}`;
      })
      .join('\n');
    expect.fail(
      `axe found ${results.violations.length} accessibility violation(s):\n${report}`,
    );
  }
}
