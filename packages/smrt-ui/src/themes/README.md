# SMRT Svelte Themes

A comprehensive, multi-theme system for SMRT Svelte with support for Material Design, Apple Glass, Google AI Studio, and the SMRT instrument-panel aesthetic. All themes include both light and dark modes.

## Features

- **4 Theme Presets**: Material (improved M3), Glass (Apple-style), Studio (Google AI Studio flat), SMRT (dark-first amber instrument panel)
- **Light & Dark Modes**: Automatic system detection with manual override
- **Runtime Theme Switching**: Change themes without page reload
- **CSS Custom Properties**: Full theming via CSS variables
- **Persistence**: Theme preferences saved to localStorage
- **Type-Safe**: Full TypeScript support

## Installation

```bash
npm install @happyvertical/smrt-ui
```

## Creating Custom Themes

You can create your own themes and use them alongside or instead of the built-in themes.

### Simple Custom Theme (Recommended)

```typescript
// src/lib/themes/brand.ts
import { createTheme, registerTheme } from '@happyvertical/smrt-ui/themes';

const brandTheme = createTheme({
  id: 'brand',
  name: 'Brand Theme',
  light: {
    primary: '#ff6b35',
    background: '#fafafa',
    surface: '#ffffff',
    // ... other colors (auto-generated if not specified)
  },
  dark: {
    primary: '#ff8c5a',
    background: '#0a0a0a',
    surface: '#1a1a1a',
    // ... other colors
  },
  fontFamily: 'Inter, system-ui, sans-serif',
});

// Register for use with ThemeProvider
registerTheme(brandTheme);

export { brandTheme };
```

```svelte
<!-- +layout.svelte -->
<script>
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
  import '@happyvertical/smrt-ui/themes/styles/all.css';
  import '$lib/themes/brand'; // Import to register
</script>

<ThemeProvider preset="brand" colorScheme="system">
  {@render children()}
</ThemeProvider>
```

### Theme from a Single Color

```typescript
import { createThemeFromColor, registerTheme } from '@happyvertical/smrt-ui/themes';

const autoTheme = createThemeFromColor('#6366f1', 'indigo', 'Indigo Theme');
registerTheme(autoTheme);
```

### Full Custom Theme with All Options

```typescript
import { createTheme, registerTheme } from '@happyvertical/smrt-ui/themes';

const completeTheme = createTheme({
  id: 'fintech',
  name: 'Fintech Pro',
  
  // Extend an existing theme as a base
  extend: 'material',
  
  // Light mode colors (required)
  light: {
    primary: '#0066ff',
    onPrimary: '#ffffff',
    primaryContainer: '#e6f0ff',
    onPrimaryContainer: '#001a4d',
    secondary: '#00c853',
    onSecondary: '#000000',
    background: '#f8fafc',
    surface: '#ffffff',
    surfaceVariant: '#f1f5f9',
    error: '#dc2626',
    success: '#22c55e',
    warning: '#f59e0b',
    outline: '#e2e8f0',
  },
  
  // Dark mode colors (optional, auto-generated if not provided)
  dark: {
    primary: '#4d94ff',
    onPrimary: '#001a4d',
    primaryContainer: '#0047b3',
    onPrimaryContainer: '#e6f0ff',
    background: '#0f172a',
    surface: '#1e293b',
    // ... etc
  },
  
  // Custom typography (optional)
  typography: {
    displayLarge: {
      size: '4rem',
      lineHeight: '1.1',
      weight: '700',
      tracking: '-0.02em',
    },
    // ... other type scales
  },
  
  // Custom elevation (optional)
  elevation: {
    1: '0 2px 4px rgba(0,0,0,0.05)',
    2: '0 4px 8px rgba(0,0,0,0.08)',
    // ... etc
  },
  
  // Custom font
  fontFamily: '"SF Pro Display", Inter, system-ui, sans-serif',
  
  // Glass effects (optional)
  glass: {
    blur: '24px',
    saturation: '200%',
    borderOpacity: '0.2',
    backgroundOpacity: '0.8',
  },
});

registerTheme(completeTheme);
```

### Using Custom Themes Without Registration

If you don't want to register a theme globally, you can pass it directly to ThemeProvider:

```svelte
<script>
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
  import { materialTheme } from '@happyvertical/smrt-ui/themes';
  
  // Create a one-off theme by extending
  const myOneOffTheme = {
    ...materialTheme,
    id: 'custom',
    name: 'Custom',
    light: {
      ...materialTheme.light,
      primary: '#custom-color',
    },
  };
</script>

<!-- Note: This requires the theme CSS to be loaded manually -->
<ThemeProvider preset="material" overrides={{
  '--smrt-color-primary': '#custom-color'
}}>
  {@render children()}
</ThemeProvider>
```

### CSS-Only Custom Themes

For projects that don't use JavaScript theming, create a CSS file:

```css
/* src/styles/my-theme.css */

/* Import base tokens */
@import '@happyvertical/smrt-ui/themes/styles/material.css';

/* Override with custom values */
[data-theme="custom"] {
  --smrt-color-primary: #ff6b35;
  --smrt-color-on-primary: #ffffff;
  --smrt-color-primary-container: #fff0e6;
  --smrt-color-on-primary-container: #cc4a1d;
  
  /* Custom typography */
  --smrt-font-family: 'Inter', system-ui, sans-serif;
  
  /* Custom border radius */
  --smrt-radius-md: 0.75rem;
  --smrt-radius-lg: 1rem;
}

[data-theme="custom"][data-color-scheme="dark"] {
  --smrt-color-primary: #ff8c5a;
  --smrt-color-background: #0a0a0a;
  --smrt-color-surface: #1a1a1a;
}
```

```svelte
<!-- +layout.svelte -->
<script>
  import '../styles/my-theme.css';
</script>

<div data-theme="custom" data-color-scheme="light">
  {@render children()}
</div>
```

## Quick Start

### Option 1: Full Runtime Theming (Recommended)

Best for apps that need theme switching and dynamic color schemes.

```svelte
<!-- +layout.svelte -->
<script>
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
  import '@happyvertical/smrt-ui/themes/styles/all.css';
</script>

<ThemeProvider preset="material" colorScheme="system">
  {@render children()}
</ThemeProvider>
```

### Option 2: Build-Time Theming

Best for static sites or when you want minimal JavaScript overhead.

```svelte
<!-- +layout.svelte -->
<script>
  // Import only the theme you need
  import '@happyvertical/smrt-ui/themes/styles/material.css';
</script>

<!-- Set data attributes for the theme -->
<div data-theme="material" data-color-scheme="light">
  {@render children()}
</div>
```

### Option 3: System-Only (No Runtime JS)

For maximum performance, use CSS only with media queries:

```css
/* In your global CSS */
@import '@happyvertical/smrt-ui/themes/styles/material.css';

/* Override to respect system preference */
@media (prefers-color-scheme: dark) {
  :root {
    --smrt-color-background: #0e0e0e;
    --smrt-color-on-background: #e3e3e3;
    /* ... other dark mode colors */
  }
}
```

## Import CSS

Import the theme styles in your app entry point:

```ts
// Import all themes (for runtime switching)
import '@smrt/svelte/themes/styles/all.css';

// Or import specific theme only
import '@smrt/svelte/themes/styles/material.css';
import '@smrt/svelte/themes/styles/glass.css';
import '@smrt/svelte/themes/styles/studio.css';
```

## ThemeProvider Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `preset` | `'material' \| 'glass' \| 'studio'` | `'material'` | Theme preset |
| `colorScheme` | `'light' \| 'dark' \| 'system'` | `'system'` | Color scheme preference |
| `primaryColor` | `string` | - | Override primary accent color |
| `borderRadius` | `'none' \| 'sm' \| 'md' \| 'lg' \| 'xl' \| 'full'` | `'md'` | Border radius scale |
| `overrides` | `Record<string, string>` | `{}` | Custom CSS variable overrides |
| `persist` | `boolean` | `true` | Persist to localStorage |
| `storageKey` | `string` | `'smrt-theme'` | localStorage key |

## Theme Switching

Use the context to switch themes programmatically:

```svelte
<script>
  import { getThemeContext, ThemeSwitcher } from '@smrt/svelte/themes';
  
  const theme = getThemeContext();
  
  // Switch to glass theme
  function goGlass() {
    theme.setPreset('glass');
  }
  
  // Toggle dark mode
  function toggleDark() {
    theme.toggleColorScheme();
  }
</script>

<!-- Or use the built-in UI components -->
<ThemeSwitcher variant="segmented" />
<ColorSchemeToggle variant="buttons" />
```

## Theme Characteristics

### Material (Default)

Modern Google Material Design 3 with refined colors and typography.

- **Colors**: Vibrant blues, clean neutrals, OLED-friendly dark mode
- **Elevation**: Multi-layer shadows with good depth perception
- **Typography**: Google Sans / Roboto style metrics
- **Use for**: General purpose, Google ecosystem alignment

### Glass

Apple-inspired glass morphism with backdrop blur effects.

- **Colors**: Translucent surfaces, system colors, layered depth
- **Effects**: Backdrop blur, saturation boost, frosted glass
- **Typography**: SF Pro style metrics, tighter tracking
- **Use for**: Premium feel, iOS/macOS alignment, visual depth

**Glass Utility Classes:**

```html
<div class="smrt-glass">Default glass effect</div>
<div class="smrt-glass-thick">Thicker blur</div>
<div class="smrt-glass-thin">Subtle blur</div>
```

### Studio

Google AI Studio-inspired flat design with minimal aesthetics.

- **Colors**: Monochromatic base, vibrant accent colors
- **Elevation**: Minimal shadows, inset borders, clean lines
- **Typography**: Clean sans-serif, larger body text for readability
- **Use for**: Developer tools, content-heavy apps, minimal aesthetic

**Studio Utility Classes:**

```html
<div class="smrt-flat">Flat bordered surface</div>
<div class="smrt-flat-inset">Inset border effect</div>
<div class="smrt-flat-subtle">Subtle elevation</div>
```

### SMRT

Dark-first "engineering instrument panel" theme adapted from happyvertical.com:
an amber signal accent (`#ff7a1a`) on near-black surfaces, hairline outlines,
deep low shadows, and a Space Grotesk / Inter / JetBrains Mono type stack.

- **Colors**: Near-black engineering surfaces, signal-amber primary, SMRT-violet
  tertiary, cool slate neutrals
- **Elevation**: Deep, soft, low-spread drop shadows with a hairline inset
- **Typography**: Space Grotesk display (tight, negative tracking) over Inter body
- **Use for**: Developer tools, agent dashboards, technical/terminal aesthetics

**Fonts (optional, self-hosted):**

```svelte
<script>
  // Bundled woff2 — Space Grotesk / Inter / JetBrains Mono (SIL OFL). Omit to
  // fall back to system-ui / ui-monospace stacks.
  import '@happyvertical/smrt-ui/themes/styles/fonts.css';
</script>

<ThemeProvider preset="smrt" colorScheme="dark">
  <YourApp />
</ThemeProvider>
```

**SMRT Flourish Utility Classes** (opt-in signature motifs):

```html
<section class="smrt-grid-bg">Faint engineering-grid background</section>
<div class="smrt-accent-wash">Soft amber radial wash</div>
<span class="smrt-livedot"></span> <!-- pulsing amber status dot -->
<span class="smrt-label">// SECTION</span> <!-- mono, uppercase, tracked -->
<div class="smrt-readout"><div class="smrt-readout-row">…</div></div>
<div class="smrt-terminal"><pre>$ smrt …</pre></div>
<div class="smrt-scope"><span class="smrt-scope-fill" style="width:42%"></span></div>
<span class="smrt-glow">amber drop glow</span>
```

## Project Integration Patterns

### SvelteKit App

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { ThemeProvider, ThemeSwitcher, ColorSchemeToggle } from '@happyvertical/smrt-ui/themes';
  import '@happyvertical/smrt-ui/themes/styles/all.css';
</script>

<ThemeProvider preset="glass" colorScheme="system" persist={true}>
  <header>
    <nav>
      <ThemeSwitcher variant="segmented" />
      <ColorSchemeToggle variant="buttons" />
    </nav>
  </header>
  
  <main>
    {@render children()}
  </main>
</ThemeProvider>
```

### SvelteKit with Server-Side Theme

```typescript
// src/routes/+layout.server.ts
export const load = async ({ cookies }) => {
  return {
    theme: {
      preset: cookies.get('theme-preset') || 'material',
      colorScheme: cookies.get('theme-mode') || 'system',
    }
  };
};
```

```svelte
<!-- src/routes/+layout.svelte -->
<script>
  import { ThemeProvider } from '@happyvertical/smrt-ui/themes';
  import '@happyvertical/smrt-ui/themes/styles/all.css';
  
  let { data, children } = $props();
</script>

<ThemeProvider 
  preset={data.theme.preset} 
  colorScheme={data.theme.colorScheme}
  persist={false}
>
  {@render children()}
</ThemeProvider>
```

### Vite/Vanilla JS Project

```javascript
// main.js
import '@happyvertical/smrt-ui/themes/styles/all.css';
import { generateThemeVariables, getTheme } from '@happyvertical/smrt-ui/themes';

// Apply theme
const theme = getTheme('studio');
const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const vars = generateThemeVariables(theme, isDark);

// Set CSS variables
Object.entries(vars).forEach(([key, value]) => {
  document.documentElement.style.setProperty(key, value);
});
```

### Tailwind CSS Integration

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        primary: 'var(--smrt-color-primary)',
        secondary: 'var(--smrt-color-secondary)',
        surface: 'var(--smrt-color-surface)',
        background: 'var(--smrt-color-background)',
        // ... map other tokens
      },
      borderRadius: {
        sm: 'var(--smrt-radius-sm)',
        md: 'var(--smrt-radius-md)',
        lg: 'var(--smrt-radius-lg)',
      },
      boxShadow: {
        1: 'var(--smrt-elevation-1)',
        2: 'var(--smrt-elevation-2)',
        3: 'var(--smrt-elevation-3)',
      },
    },
  },
};
```

```html
<!-- Use with Tailwind -->
<button class="bg-primary text-on-primary rounded-md shadow-2">
  Click me
</button>
```

## CSS Custom Properties

All themes expose CSS custom properties:

```css
/* Colors */
--smrt-color-primary
--smrt-color-surface
--smrt-color-background
/* ... and 60+ more color tokens */

/* Typography */
--smrt-typography-body-large-size
--smrt-typography-body-large-line-height
--smrt-typography-body-large-weight
/* ... for all type scales */

/* Spacing */
--smrt-spacing-1  /* 0.25rem */
--smrt-spacing-2  /* 0.5rem */
/* ... 0-24 scale */

/* Border Radius */
--smrt-radius-md  /* 0.5rem */
--smrt-radius-lg  /* 0.75rem */
/* ... sm, md, lg, xl, full */

/* Elevation */
--smrt-elevation-1
--smrt-elevation-2
/* ... 0-5 scale */

/* Animation */
--smrt-duration-normal
--smrt-easing-standard
```

## Advanced Usage

### Build-Time Theming

For SSR or static sites, import CSS directly and set data attributes:

```html
<html data-theme="material" data-color-scheme="light">
```

### Custom Theme Overrides

```svelte
<ThemeProvider
  preset="material"
  overrides={{
    '--smrt-color-primary': '#ff5722',
    '--smrt-radius-md': '1rem'
  }}
>
  <YourApp />
</ThemeProvider>
```

### Programmatic Configuration

```svelte
<script>
  import { getThemeContext } from '@smrt/svelte/themes';
  
  const theme = getThemeContext();
  
  // Update multiple settings at once
  theme.updateConfig({
    preset: 'studio',
    colorScheme: 'dark',
    borderRadius: 'lg'
  });
</script>
```

### Access Theme State

```svelte
<script>
  import { getThemeContext } from '@smrt/svelte/themes';
  
  const theme = getThemeContext();
  
  // Reactive state
  $: currentPreset = theme.state.preset;
  $: isDark = theme.state.isDark;
  $: themeConfig = theme.state.config;
</script>

<p>Current theme: {currentPreset}</p>
<p>Dark mode: {isDark ? 'On' : 'Off'}</p>
```

## Migration from Legacy Theme

The legacy theme system (`@smrt/svelte/theme`) is still available but deprecated. To migrate:

1. Import from `@smrt/svelte/themes` instead
2. Wrap app with new `<ThemeProvider>` from themes
3. Import theme CSS files
4. Update any theme context usage to new API

```diff
- import { ThemeProvider } from '@smrt/svelte/theme';
+ import { ThemeProvider } from '@smrt/svelte/themes';
+ import '@smrt/svelte/themes/styles/all.css';
```

## Troubleshooting

### CSS variables not applying

Make sure you've imported the CSS files:

```typescript
// In your main entry file (+layout.svelte, main.ts, etc.)
import '@happyvertical/smrt-ui/themes/styles/all.css';
// or specific theme
import '@happyvertical/smrt-ui/themes/styles/material.css';
```

### Theme flashes on load (FOUC)

For SSR apps, set the theme on the server and inline critical CSS:

```svelte
<!-- +layout.svelte -->
<svelte:head>
  {@html `<style>
    :root {
      --smrt-color-background: ${data.theme.isDark ? '#0e0e0e' : '#ffffff'};
      /* ... other critical vars */
    }
  </style>`}
</svelte:head>
```

### Glass theme not showing blur

The glass theme requires `backdrop-filter` support. For browsers that don't support it, the theme gracefully degrades to solid colors. To check support:

```css
@supports not (backdrop-filter: blur(20px)) {
  .glass-card {
    background: rgba(255, 255, 255, 0.95) !important;
  }
}
```

### TypeScript errors with CSS imports

If you get TypeScript errors importing CSS files, add a type declaration:

```typescript
// src/app.d.ts or types/css.d.ts
declare module '*.css' {
  const content: string;
  export default content;
}
```

### Customizing a theme

You can extend any theme by overriding CSS variables after import:

```css
/* In your global CSS, AFTER theme import */
@import '@happyvertical/smrt-ui/themes/styles/material.css';

[data-theme="material"] {
  --smrt-color-primary: #your-brand-color;
  --smrt-radius-md: 0.75rem;
}
```

## Browser Support

- **Material & Studio**: All modern browsers (Chrome 80+, Firefox 75+, Safari 13+, Edge 80+)
- **Glass**: Requires browsers with `backdrop-filter` support
  - Chrome 76+
  - Firefox 103+
  - Safari 9+
  - Edge 79+

## Contributing

Contributions are welcome! Please read the [Contributing Guide](../../CONTRIBUTING.md) for details.

## License

MIT
