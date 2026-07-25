# smrt-svelte/themes

Module semantics for `src/themes/` + `src/theme/`. Package orientation, the cross-module
invariants, and the traps that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

## Themes

Two theme systems: `src/theme/` (simple ThemeProvider with design tokens) and `src/themes/` (full preset system with material/glass/studio, CSS generation, runtime switching). **`src/themes/` is canonical** — it is the only path that delivers the complete preset-aware `--smrt-*` token surface (colors + typography + spacing + radius + elevation + motion) across material/glass/studio. `src/theme/` is the simpler/legacy provider; it emits the same CSS variable vocabulary from its single built-in scale for backward compatibility, but it does not support preset switching or preset-specific values.

### Design-token vocabulary (issue #1431)

Components consume a Material-3 vocabulary. To keep one vocabulary that always resolves, the canonical names are emitted **plus** additive aliases — never rename canonical tokens:

- **Radius**: canonical `none|sm|md|lg|xl|2xl|3xl|full`; aliases `extra-small|small|medium|large|extra-large`.
- **Spacing**: canonical numeric scale `0…24`; aliases `xs|sm|md|lg|xl|2xl|3xl` mapped onto numeric values.
- **Motion**: canonical `instant|fast|normal|slow|slower`; aliases `short1…long4` (M3 ms scale).
- **Typography**: per-variant `-size|-line-height|-weight|-tracking|-font-family` **plus** a `-font` CSS-shorthand alias (`weight size/line-height family`).
- **Helpers**: `--smrt-font-family-mono`, named `--smrt-typography-weight-{normal,medium,semibold,bold}`, and `--smrt-z-index-{dropdown…tooltip}` (incl. `dialog`).

Single source of truth: `src/themes/shared.ts` (alias maps) → emitted by `src/themes/css-generator.ts` (JS `ThemeProvider`), mirrored into the static preset CSS (`src/themes/styles/*.css`) and the simple provider (`src/theme/tokens.ts`). `scripts/check-svelte-tokens.mjs` (CI + `pnpm check:svelte-tokens`) fails on any consumed-but-unemitted `--smrt-*` token; `src/themes/__tests__/token-aliases.test.ts` pins the emitted set. Don't introduce new `--smrt-*` names in components without emitting them from a delivery path.

### Design-token vocabulary (issue #1431)

Components consume a Material-3 vocabulary. To keep one vocabulary that always resolves, the canonical names are emitted **plus** additive aliases — never rename canonical tokens:

- **Radius**: canonical `none|sm|md|lg|xl|2xl|3xl|full`; aliases `extra-small|small|medium|large|extra-large`.
- **Spacing**: canonical numeric scale `0…24`; aliases `xs|sm|md|lg|xl|2xl|3xl` mapped onto numeric values.
- **Motion**: canonical `instant|fast|normal|slow|slower`; aliases `short1…long4` (M3 ms scale).
- **Typography**: per-variant `-size|-line-height|-weight|-tracking|-font-family` **plus** a `-font` CSS-shorthand alias (`weight size/line-height family`).
- **Helpers**: `--smrt-font-family-mono`, named `--smrt-typography-weight-{normal,medium,semibold,bold}`, and `--smrt-z-index-{dropdown…tooltip}` (incl. `dialog`).

Single source of truth: `src/themes/shared.ts` (alias maps) → emitted by `src/themes/css-generator.ts` (JS `ThemeProvider`), mirrored into the static preset CSS (`src/themes/styles/*.css`) and the simple provider (`src/theme/tokens.ts`). `scripts/check-svelte-tokens.mjs` (CI + `pnpm check:svelte-tokens`) fails on any consumed-but-unemitted `--smrt-*` token; `src/themes/__tests__/token-aliases.test.ts` pins the emitted set. Don't introduce new `--smrt-*` names in components without emitting them from a delivery path.
