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
