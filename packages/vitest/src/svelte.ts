/**
 * Svelte component-test surface (Sweep S11, #1416).
 *
 * Re-exports Testing Library's Svelte bindings, user-event, and the a11y helper
 * so a package gets the whole component-test harness from one import — and needs
 * only depend on `@happyvertical/smrt-vitest` (which carries the Testing Library
 * deps). Pair with `@happyvertical/smrt-vitest/svelte-setup` in `setupFiles` and
 * a per-file jsdom environment:
 *
 *   // @vitest-environment jsdom
 *   import { render, screen, userEvent, expectNoA11yViolations }
 *     from '@happyvertical/smrt-vitest/svelte';
 *
 *   const { container } = render(MyComponent, { props });
 *   await userEvent.click(screen.getByRole('button', { name: 'Save' }));
 *   await expectNoA11yViolations(container);
 */
export {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/svelte';
export { default as userEvent } from '@testing-library/user-event';
export { expectNoA11yViolations } from './a11y.js';

/**
 * Styling/testing hooks: find an internal element by its `data-smrt-part` name
 * inside the rendered `data-smrt-component` root. Parts are public names (see
 * packages/smrt-ui/agents/styling.md), so tests should target them rather than
 * generated class names.
 *
 *   const tab = getByPart('Tabs', 'tab', container);
 */
export function getByPart(
  component: string,
  part: string,
  container: ParentNode = document.body,
): HTMLElement {
  const matches = findByPart(component, part, container);
  if (matches.length !== 1) {
    throw new Error(
      `getByPart(${JSON.stringify(component)}, ${JSON.stringify(part)}) found ${matches.length} elements; expected exactly 1`,
    );
  }
  return matches[0];
}

/** Like getByPart, but returns null when nothing matches (throws on several). */
export function queryByPart(
  component: string,
  part: string,
  container: ParentNode = document.body,
): HTMLElement | null {
  const matches = findByPart(component, part, container);
  if (matches.length > 1) {
    throw new Error(
      `queryByPart(${JSON.stringify(component)}, ${JSON.stringify(part)}) found ${matches.length} elements; expected at most 1`,
    );
  }
  return matches[0] ?? null;
}

function findByPart(
  component: string,
  part: string,
  container: ParentNode,
): HTMLElement[] {
  const quote = (value: string) => value.replace(/["\\]/g, '\\$&');
  const roots = container.querySelectorAll<HTMLElement>(
    `[data-smrt-component="${quote(component)}"]`,
  );
  const found = new Set<HTMLElement>();
  for (const root of Array.from(roots)) {
    // Only parts whose nearest component root is this root: a nested component's
    // part with the same name belongs to that component, not to this one.
    for (const el of Array.from(
      root.querySelectorAll<HTMLElement>(`[data-smrt-part="${quote(part)}"]`),
    )) {
      if (el.closest('[data-smrt-component]') === root) found.add(el);
    }
  }
  return [...found];
}
