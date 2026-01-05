# Spec: Material 3 Refactor for smrt-svelte

## Overview
This track involves a comprehensive redesign of the `smrt-svelte` component library to align with the Material 3 (M3) design specifications. The goal is to provide a modern, visually cohesive, and highly functional set of components without relying on external UI libraries. Key additions include a `ThemeProvider` for dynamic styling and a custom ripple effect system.

## Functional Requirements

### 1. Theme Management (`ThemeProvider`)
- **System Preference:** Automatically detect and apply light or dark mode based on the user's OS settings.
- **Manual Overrides:** Allow users to explicitly set 'light', 'dark', or 'system' modes.
- **Dynamic Color Generation:** Implement a minimal internal generator (inspired by Material Color Utilities) to derive a full M3 color palette (Primary, Secondary, Tertiary, Surface, etc.) from a single seed color.
- **CSS Variable Injection:** Colors and tokens must be delivered to components via CSS Custom Properties (e.g., `--md-sys-color-primary`).

### 2. Foundational Systems
- **Ripple Controller:** A custom JavaScript-based ripple effect that responds to touch/click locations, managing timing and multiple concurrent ripples.
- **Icon System:** A custom SVG-based icon component system to avoid external font or library dependencies.
- **Typography:** Implementation of M3 typography tokens (Display, Headline, Title, Body, Label) using CSS variables.

### 3. Component Refactoring
Refactor all existing components in `packages/smrt-svelte/src/components` to adhere to M3 visual and behavioral guidelines:
- **Forms:** `SMRTTextInput`, `SMRTCheckbox`, `SMRTSelect`, `SMRTTextarea`, etc.
- **Layout/Display:** `SummaryCard`, `PageHeader`, `EmptyState`.
- **Navigation:** Existing navigation components (e.g., in `src/components/nav`).
- **Feedback:** Progress indicators, dialogs, etc.

## Non-Functional Requirements
- **Zero External Dependencies:** No third-party UI libraries or heavy utility libraries for color/icons.
- **Type Safety:** Full TypeScript support for all theme tokens and component props.
- **Performance:** Efficient CSS variable updates and minimal overhead from the JS ripple controller.
- **Responsive Design:** All components must be mobile-friendly and accessible.

## Acceptance Criteria
1. `ThemeProvider` correctly applies light/dark modes and generates palettes from a seed color.
2. Components react dynamically to theme changes via CSS variables.
3. The ripple effect starts at the point of interaction and animates correctly.
4. All existing components are visually updated to M3 specs (elevation, rounded corners, color usage).
5. No new external `dependencies` added to `package.json`.

## Out of Scope
- Integration with external icon libraries (e.g., FontAwesome, Material Icons font).
- Complex motion/transition animations beyond standard M3 ripples and basic state changes.
