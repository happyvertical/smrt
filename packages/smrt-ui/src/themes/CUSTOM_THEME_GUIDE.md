# Custom Theme Guide

This guide shows how to create and use custom themes in your own project repository.

## Project Structure

```
my-project/
├── src/
│   ├── lib/
│   │   └── themes/
│   │       ├── brand.ts          # TypeScript theme definition
│   │       ├── brand.css         # CSS override file
│   │       └── index.ts          # Export and registration
│   ├── routes/
│   │   └── +layout.svelte        # Use your theme
│   └── app.html                  # Set data attributes
├── static/
│   └── themes/                   # Static CSS files (optional)
└── package.json
```

## Method 1: TypeScript Theme (Recommended)

### 1. Create Theme Definition

```typescript
// src/lib/themes/brand.ts
import { createTheme, registerTheme } from '@happyvertical/smrt-ui/themes';
import type { Theme } from '@happyvertical/smrt-ui/themes';

export const brandTheme: Theme = createTheme({
  id: 'brand',
  name: 'My Brand',
  
  // Start from Material as a base
  extend: 'material',
  
  // Define your brand colors
  light: {
    primary: '#6366f1',        // Indigo
    secondary: '#8b5cf6',      // Purple
    tertiary: '#ec4899',       // Pink
    background: '#fafafa',
    surface: '#ffffff',
    error: '#ef4444',
    success: '#10b981',
    warning: '#f59e0b',
  },
  
  // Define dark mode (or let it auto-generate)
  dark: {
    primary: '#818cf8',
    secondary: '#a78bfa',
    tertiary: '#f472b6',
    background: '#0f172a',
    surface: '#1e293b',
  },
  
  // Use your brand font
  fontFamily: '"Inter var", "Inter", system-ui, sans-serif',
  
  // Optional: Custom border radius
  borderRadius: {
    none: '0',
    sm: '0.25rem',
    md: '0.5rem',
    lg: '0.75rem',
    xl: '1rem',
    '2xl': '1.25rem',
    '3xl': '1.5rem',
    full: '9999px',
  },
});

// Auto-register when imported
registerTheme(brandTheme);
```

### 2. Export Theme

```typescript
// src/lib/themes/index.ts
export { brandTheme } from './brand.js';
```

### 3. Use in Layout

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  // Import to register the theme
  import '$lib/themes';
  
  // Import base CSS
  import '@happyvertical/smrt-ui/themes/styles/all.css';
  
  // Your custom theme CSS (optional overrides)
  import '$lib/themes/brand.css';
  
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
</script>

<ThemeProvider preset="brand" colorScheme="system" persist={true}>
  {@render children()}
</ThemeProvider>
```

### 4. Optional CSS Overrides

```css
/* src/lib/themes/brand.css */
/* Fine-tune specific components */

[data-theme="brand"] {
  /* Custom component styles */
  --my-brand-header-height: 64px;
  --my-brand-sidebar-width: 240px;
}

[data-theme="brand"] .my-brand-button {
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
```

## Method 2: CSS-Only Theme

For simpler cases, you can define a theme entirely in CSS:

```css
/* src/styles/my-theme.css */

/* Import base structure */
@import '@happyvertical/smrt-ui/themes/styles/material.css';

/* Define light mode */
[data-theme="mybrand"][data-color-scheme="light"] {
  /* Primary palette */
  --smrt-color-primary: #0ea5e9;
  --smrt-color-on-primary: #ffffff;
  --smrt-color-primary-container: #e0f2fe;
  --smrt-color-on-primary-container: #075985;
  
  /* Secondary palette */
  --smrt-color-secondary: #64748b;
  --smrt-color-on-secondary: #ffffff;
  --smrt-color-secondary-container: #f1f5f9;
  --smrt-color-on-secondary-container: #334155;
  
  /* Surfaces */
  --smrt-color-surface: #ffffff;
  --smrt-color-surface-variant: #f8fafc;
  --smrt-color-background: #f1f5f9;
  --smrt-color-on-surface: #0f172a;
  
  /* Semantic colors */
  --smrt-color-error: #ef4444;
  --smrt-color-success: #22c55e;
  --smrt-color-warning: #f59e0b;
  
  /* Custom typography */
  --smrt-font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  
  /* Custom spacing (optional) */
  --smrt-spacing-1: 0.25rem;
  --smrt-spacing-2: 0.5rem;
  --smrt-spacing-4: 1rem;
  --smrt-spacing-8: 2rem;
}

/* Define dark mode */
[data-theme="mybrand"][data-color-scheme="dark"] {
  --smrt-color-primary: #38bdf8;
  --smrt-color-on-primary: #0c4a6e;
  --smrt-color-primary-container: #075985;
  --smrt-color-on-primary-container: #e0f2fe;
  
  --smrt-color-surface: #0f172a;
  --smrt-color-surface-variant: #1e293b;
  --smrt-color-background: #020617;
  --smrt-color-on-surface: #f1f5f9;
  
  --smrt-color-error: #f87171;
  --smrt-color-success: #4ade80;
  --smrt-color-warning: #fbbf24;
}
```

## Method 3: Hybrid Approach

Combine TypeScript definition with extensive CSS customization:

```typescript
// src/lib/themes/hybrid.ts
import { createTheme, registerTheme } from '@happyvertical/smrt-ui/themes';

export const hybridTheme = createTheme({
  id: 'hybrid',
  name: 'Hybrid Brand',
  extend: 'material',
  light: {
    primary: '#8b5cf6',
    background: '#fafafa',
  },
  // Let dark mode auto-generate
});

registerTheme(hybridTheme);
```

```css
/* src/lib/themes/hybrid.css */
@import '@happyvertical/smrt-ui/themes/styles/material.css';

[data-theme="hybrid"] {
  /* All the CSS customizations */
  --smrt-typography-display-large-size: 4rem;
  --smrt-typography-display-large-weight: 800;
  
  /* Custom animations */
  --smrt-duration-slow: 400ms;
  --smrt-easing-emphasized: cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Component-specific overrides */
[data-theme="hybrid"] .card {
  border: 1px solid var(--smrt-color-outline);
  transition: transform var(--smrt-duration-normal) var(--smrt-easing-standard);
}

[data-theme="hybrid"] .card:hover {
  transform: translateY(-4px);
}
```

## Sharing Themes Between Projects

### As a Local Package

```bash
# In your theme package
mkdir packages/my-brand-theme
cd packages/my-brand-theme
npm init
```

```json
// packages/my-brand-theme/package.json
{
  "name": "@mycompany/brand-theme",
  "main": "./index.js",
  "exports": {
    ".": {
      "types": "./index.d.ts",
      "default": "./index.js"
    },
    "./styles": "./styles.css"
  }
}
```

```typescript
// packages/my-brand-theme/index.ts
import { createTheme, registerTheme } from '@happyvertical/smrt-ui/themes';

export const myBrandTheme = createTheme({
  id: 'mycompany',
  name: 'MyCompany Brand',
  // ... theme definition
});

registerTheme(myBrandTheme);
export { myBrandTheme as default };
```

```css
/* packages/my-brand-theme/styles.css */
/* CSS version of the theme */
```

Then in your main project:

```bash
npm install ./packages/my-brand-theme
```

```svelte
<script>
  import '@mycompany/brand-theme';
  import '@mycompany/brand-theme/styles';
</script>
```

## Theme Switching with Custom Themes

```svelte
<script>
  import { getThemeContext, ThemeSwitcher } from '@happyvertical/smrt-ui/themes';
  
  // Import your custom themes to register them
  import '$lib/themes/brand';
  import '$lib/themes/corporate';
  
  const theme = getThemeContext();
  
  // Switch between built-in and custom
  function useBrandTheme() {
    theme.setPreset('brand');
  }
  
  function useCorporateTheme() {
    theme.setPreset('corporate');
  }
</script>

<!-- UI shows all available themes including custom ones -->
<ThemeSwitcher variant="segmented" />
```

## Required Tokens

A theme is complete only when it defines every token the components consume. The list below is generated from the `var(--smrt-*)` references in the packages' `.svelte` files; `src/themes/__tests__/required-tokens.test.ts` asserts every preset and `createTheme()` output defines each one.

<!-- smrt-required-tokens:start -->

### Required tokens (generated)

Every theme (presets and `createTheme()` output) must define these names. Generated by
`scripts/generate-smrt-required-tokens.mjs`; do not edit by hand. Component-private
`--smrt-<component>-*` knobs are excluded.

- **color** (40): `--smrt-color-background`, `--smrt-color-error`, `--smrt-color-error-container`, `--smrt-color-inverse-on-surface`, `--smrt-color-inverse-surface`, `--smrt-color-on-background`, `--smrt-color-on-error`, `--smrt-color-on-error-container`, `--smrt-color-on-primary`, `--smrt-color-on-primary-container`, `--smrt-color-on-secondary`, `--smrt-color-on-secondary-container`, `--smrt-color-on-success-container`, `--smrt-color-on-surface`, `--smrt-color-on-surface-variant`, `--smrt-color-on-tertiary`, `--smrt-color-on-tertiary-container`, `--smrt-color-on-warning-container`, `--smrt-color-outline`, `--smrt-color-outline-variant`, `--smrt-color-primary`, `--smrt-color-primary-container`, `--smrt-color-scrim`, `--smrt-color-secondary`, `--smrt-color-secondary-container`, `--smrt-color-shadow`, `--smrt-color-success`, `--smrt-color-success-container`, `--smrt-color-surface`, `--smrt-color-surface-container`, `--smrt-color-surface-container-high`, `--smrt-color-surface-container-highest`, `--smrt-color-surface-container-low`, `--smrt-color-surface-container-lowest`, `--smrt-color-surface-dim`, `--smrt-color-surface-variant`, `--smrt-color-tertiary`, `--smrt-color-tertiary-container`, `--smrt-color-warning`, `--smrt-color-warning-container`
- **duration** (6): `--smrt-duration-fast`, `--smrt-duration-medium1`, `--smrt-duration-normal`, `--smrt-duration-short2`, `--smrt-duration-short3`, `--smrt-duration-short4`
- **easing** (2): `--smrt-easing-emphasized-decelerate`, `--smrt-easing-standard`
- **elevation** (5): `--smrt-elevation-1`, `--smrt-elevation-2`, `--smrt-elevation-3`, `--smrt-elevation-4`, `--smrt-elevation-5`
- **font** (2): `--smrt-font-family`, `--smrt-font-family-mono`
- **radius** (11): `--smrt-radius-2xl`, `--smrt-radius-extra-large`, `--smrt-radius-extra-small`, `--smrt-radius-full`, `--smrt-radius-large`, `--smrt-radius-lg`, `--smrt-radius-md`, `--smrt-radius-medium`, `--smrt-radius-sm`, `--smrt-radius-small`, `--smrt-radius-xl`
- **spacing** (19): `--smrt-spacing-0_5`, `--smrt-spacing-1`, `--smrt-spacing-10`, `--smrt-spacing-11`, `--smrt-spacing-12`, `--smrt-spacing-1_5`, `--smrt-spacing-2`, `--smrt-spacing-2xl`, `--smrt-spacing-3`, `--smrt-spacing-3xl`, `--smrt-spacing-4`, `--smrt-spacing-5`, `--smrt-spacing-6`, `--smrt-spacing-8`, `--smrt-spacing-lg`, `--smrt-spacing-md`, `--smrt-spacing-sm`, `--smrt-spacing-xl`, `--smrt-spacing-xs`
- **touch** (1): `--smrt-touch-target-min`
- **typography** (56): `--smrt-typography-body-large-font`, `--smrt-typography-body-large-line-height`, `--smrt-typography-body-large-size`, `--smrt-typography-body-large-tracking`, `--smrt-typography-body-medium-font`, `--smrt-typography-body-medium-line-height`, `--smrt-typography-body-medium-size`, `--smrt-typography-body-medium-tracking`, `--smrt-typography-body-medium-weight`, `--smrt-typography-body-small-font`, `--smrt-typography-body-small-line-height`, `--smrt-typography-body-small-size`, `--smrt-typography-body-small-weight`, `--smrt-typography-display-medium-line-height`, `--smrt-typography-display-medium-size`, `--smrt-typography-display-small-size`, `--smrt-typography-headline-large-line-height`, `--smrt-typography-headline-large-size`, `--smrt-typography-headline-large-weight`, `--smrt-typography-headline-medium-line-height`, `--smrt-typography-headline-medium-size`, `--smrt-typography-headline-medium-weight`, `--smrt-typography-headline-small-font`, `--smrt-typography-headline-small-line-height`, `--smrt-typography-headline-small-size`, `--smrt-typography-headline-small-weight`, `--smrt-typography-label-large-font`, `--smrt-typography-label-large-size`, `--smrt-typography-label-large-tracking`, `--smrt-typography-label-large-weight`, `--smrt-typography-label-medium-font`, `--smrt-typography-label-medium-size`, `--smrt-typography-label-medium-tracking`, `--smrt-typography-label-medium-weight`, `--smrt-typography-label-small-font`, `--smrt-typography-label-small-line-height`, `--smrt-typography-label-small-size`, `--smrt-typography-label-small-tracking`, `--smrt-typography-label-small-weight`, `--smrt-typography-title-large-font`, `--smrt-typography-title-large-line-height`, `--smrt-typography-title-large-size`, `--smrt-typography-title-medium-font`, `--smrt-typography-title-medium-font-family`, `--smrt-typography-title-medium-line-height`, `--smrt-typography-title-medium-size`, `--smrt-typography-title-medium-tracking`, `--smrt-typography-title-medium-weight`, `--smrt-typography-title-small-font`, `--smrt-typography-title-small-size`, `--smrt-typography-title-small-tracking`, `--smrt-typography-title-small-weight`, `--smrt-typography-weight-bold`, `--smrt-typography-weight-medium`, `--smrt-typography-weight-normal`, `--smrt-typography-weight-semibold`
- **z** (7): `--smrt-z-index-dialog`, `--smrt-z-index-dropdown`, `--smrt-z-index-modal`, `--smrt-z-index-overlay`, `--smrt-z-index-sticky`, `--smrt-z-index-toast`, `--smrt-z-index-tooltip`

<!-- smrt-required-tokens:end -->

## Best Practices

1. **Extend a base theme**: Start with `extend: 'material'` or another base to get sensible defaults
2. **Define both modes**: Always provide both light and dark colors, or let the system auto-generate dark mode
3. **Test contrast**: Ensure your colors meet WCAG contrast requirements
4. **Use semantic naming**: Map your brand colors to semantic tokens (primary, secondary, error, etc.)
5. **Document your theme**: Create a demo page showing all colors and components

## Troubleshooting

### Theme not appearing in ThemeSwitcher
Make sure you import the file that calls `registerTheme()` before using the component.

### Colors not applying
Check that you've imported the base CSS files and your custom CSS.

### TypeScript errors
Ensure your custom theme implements the full `Theme` type or use `createTheme()` which handles this.

### Flash of unstyled content
Use server-side rendering or inline critical CSS in your `app.html`.
