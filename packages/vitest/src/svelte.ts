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
