# smrt-svelte/component testing

Module semantics for `src/test-support/` + `__tests__/`. Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Component testing (golden tests)

Component test harness (sweep L4, #1423): `@testing-library/svelte` + `@testing-library/jest-dom` + `@testing-library/user-event` + `axe-core`, wired through `src/test-support/setup.ts` (jest-dom matchers, Testing Library auto-cleanup, a jsdom `<dialog>` `showModal`/`close` polyfill). The smrt-vitest plugin appends its own setup to `setupFiles` — it merges, so don't remove the entry.

**Golden test pattern** — render → assert role/name/state → drive with `user-event` → prove axe-clean. `src/components/ui/__tests__/Button.test.ts` is the reference:

```ts
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { expectNoA11yViolations } from '../../../test-support/a11y';

render(Component, { props: { /* … */ } });
const el = screen.getByRole('button', { name: 'Save' });
await userEvent.click(el);
expect(el).toHaveAttribute('aria-busy', 'true');
const { container } = render(Component, { props });
await expectNoA11yViolations(container); // axe; color-contrast off (jsdom has no paint)
```

- **Snippet props** (`children`, cell/header renderers): build with `createRawSnippet(() => ({ render: () => '<span>…</span>' }))`.
- **Hook-dependent components** (anything calling `useAppState`/`useSTT`/`useAuth` — they throw outside `<Provider>`): `vi.mock` the hook module with stub defaults. See `src/components/forms/__tests__/Form.test.ts`.
- **Form-input a11y** (programmatic labels, `aria-describedby`, axe-clean for `Input`/`TextInput`/etc.) is L1's deliverable (#1420) on top of this harness — bare primitives like `Input` get behavior tests here, labelled axe coverage there.
- Existing reference suites: Button, Input, Modal, DataTable, Form. The pattern is what sweep S11 (#1416) rolls out repo-wide.
