<script lang="ts">
import { Badge, Button, Card } from '@happyvertical/smrt-svelte';
import {
  ColorSchemeToggle,
  getThemeContext,
  ThemeSwitcher,
} from '@happyvertical/smrt-svelte/themes';

const theme = getThemeContext();

// Sample colors to display
const colorTokens = [
  {
    name: 'Primary',
    bg: '--smrt-color-primary',
    text: '--smrt-color-on-primary',
  },
  {
    name: 'Secondary',
    bg: '--smrt-color-secondary',
    text: '--smrt-color-on-secondary',
  },
  {
    name: 'Tertiary',
    bg: '--smrt-color-tertiary',
    text: '--smrt-color-on-tertiary',
  },
  { name: 'Error', bg: '--smrt-color-error', text: '--smrt-color-on-error' },
  {
    name: 'Success',
    bg: '--smrt-color-success',
    text: '--smrt-color-on-success',
  },
  {
    name: 'Warning',
    bg: '--smrt-color-warning',
    text: '--smrt-color-on-warning',
  },
];

const surfaceTokens = [
  {
    name: 'Surface',
    bg: '--smrt-color-surface',
    text: '--smrt-color-on-surface',
  },
  {
    name: 'Surface Variant',
    bg: '--smrt-color-surface-variant',
    text: '--smrt-color-on-surface-variant',
  },
  {
    name: 'Surface Container',
    bg: '--smrt-color-surface-container',
    text: '--smrt-color-on-surface',
  },
  {
    name: 'Background',
    bg: '--smrt-color-background',
    text: '--smrt-color-on-background',
  },
];
</script>

<svelte:head>
  <title>Themes - SMRT Svelte</title>
</svelte:head>

<div class="themes-page">
  <header class="page-header">
    <h1>🎨 Theme System</h1>
    <p class="subtitle">Three beautiful themes with light & dark modes</p>
  </header>

  <section class="current-theme">
    <h2>Current Theme</h2>
    <div class="theme-info">
      <div class="info-card">
        <span class="label">Preset</span>
        <span class="value capitalize">{theme.state.preset}</span>
      </div>
      <div class="info-card">
        <span class="label">Mode</span>
        <span class="value capitalize">{theme.state.resolvedScheme}</span>
      </div>
      <div class="info-card">
        <span class="label">Name</span>
        <span class="value">{theme.state.theme.name}</span>
      </div>
    </div>
  </section>

  <section class="controls-section">
    <h2>Theme Controls</h2>
    <div class="controls-grid">
      <div class="control-card">
        <h3>Theme Preset</h3>
        <ThemeSwitcher variant="segmented" showIcons={true} />
      </div>
      <div class="control-card">
        <h3>Color Scheme</h3>
        <ColorSchemeToggle variant="segmented" showLabels={true} />
      </div>
    </div>
  </section>

  <section class="theme-showcase">
    <h2>Theme Showcase</h2>
    
    <div class="showcase-grid">
      <!-- Color Palette -->
      <Card class="showcase-card">
        <h3 slot="header">Accent Colors</h3>
        <div class="color-grid">
          {#each colorTokens as token}
            <div class="color-swatch">
              <div 
                class="color-block"
                style="background-color: var({token.bg}); color: var({token.text});"
              >
                Aa
              </div>
              <span class="color-name">{token.name}</span>
            </div>
          {/each}
        </div>
      </Card>

      <!-- Surface Colors -->
      <Card class="showcase-card">
        <h3 slot="header">Surface Colors</h3>
        <div class="surface-list">
          {#each surfaceTokens as token}
            <div 
              class="surface-item"
              style="background-color: var({token.bg}); color: var({token.text});"
            >
              {token.name}
            </div>
          {/each}
        </div>
      </Card>

      <!-- Buttons -->
      <Card class="showcase-card">
        <h3 slot="header">Buttons</h3>
        <div class="button-showcase">
          <div class="button-row">
            <Button variant="primary">Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="tertiary">Tertiary</Button>
          </div>
          <div class="button-row">
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
          </div>
          <div class="button-row">
            <Button disabled>Disabled</Button>
          </div>
        </div>
      </Card>

      <!-- Badges -->
      <Card class="showcase-card">
        <h3 slot="header">Badges</h3>
        <div class="badge-showcase">
          <div class="badge-row">
            <Badge variant="primary">Primary</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="success">Success</Badge>
          </div>
          <div class="badge-row">
            <Badge variant="warning">Warning</Badge>
            <Badge variant="error">Error</Badge>
            <Badge variant="info">Info</Badge>
          </div>
        </div>
      </Card>

      <!-- Typography -->
      <Card class="showcase-card full-width">
        <h3 slot="header">Typography</h3>
        <div class="typography-showcase">
          <p class="display-large">Display Large</p>
          <p class="display-medium">Display Medium</p>
          <p class="display-small">Display Small</p>
          <p class="headline-large">Headline Large</p>
          <p class="headline-medium">Headline Medium</p>
          <p class="headline-small">Headline Small</p>
          <p class="title-large">Title Large</p>
          <p class="title-medium">Title Medium</p>
          <p class="title-small">Title Small</p>
          <p class="body-large">Body Large - The quick brown fox jumps over the lazy dog.</p>
          <p class="body-medium">Body Medium - The quick brown fox jumps over the lazy dog.</p>
          <p class="body-small">Body Small - The quick brown fox jumps over the lazy dog.</p>
        </div>
      </Card>

      <!-- Elevation -->
      <Card class="showcase-card full-width">
        <h3 slot="header">Elevation</h3>
        <div class="elevation-showcase">
          {#each [0, 1, 2, 3, 4, 5] as level}
            <div class="elevation-box" style="box-shadow: var(--smrt-elevation-{level});">
              Level {level}
            </div>
          {/each}
        </div>
      </Card>

      <!-- Glass Effects (only visible in glass theme) -->
      {#if theme.state.preset === 'glass'}
        <Card class="showcase-card full-width">
          <h3 slot="header">Glass Effects</h3>
          <div class="glass-showcase" style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 2rem;">
            <div class="smrt-glass" style="padding: 2rem; border-radius: var(--smrt-radius-lg);">
              <h4>Glass Surface</h4>
              <p>This card uses the glass effect with backdrop blur and translucency.</p>
            </div>
          </div>
        </Card>
      {/if}
    </div>
  </section>

  <section class="theme-comparison">
    <h2>Theme Characteristics</h2>
    <div class="comparison-grid">
      <div class="comparison-card" class:active={theme.state.preset === 'material'}>
        <h3>🔷 Material</h3>
        <ul>
          <li>Modern Google Material Design 3</li>
          <li>Vibrant primary colors</li>
          <li>Multi-layer shadows</li>
          <li>OLED-friendly dark mode</li>
          <li>Google Sans / Roboto typography</li>
        </ul>
      </div>
      <div class="comparison-card" class:active={theme.state.preset === 'glass'}>
        <h3>💎 Glass</h3>
        <ul>
          <li>Apple-inspired glass morphism</li>
          <li>Backdrop blur effects</li>
          <li>Translucent surfaces</li>
          <li>Layered depth perception</li>
          <li>SF Pro style typography</li>
        </ul>
      </div>
      <div class="comparison-card" class:active={theme.state.preset === 'studio'}>
        <h3>◻️ Studio</h3>
        <ul>
          <li>Google AI Studio flat design</li>
          <li>Minimal shadows</li>
          <li>Monochromatic + accents</li>
          <li>Clean, developer-focused</li>
          <li>Clean sans-serif typography</li>
        </ul>
      </div>
    </div>
  </section>
</div>

<style>
  .themes-page {
    max-width: 1200px;
    margin: 0 auto;
  }

  .page-header {
    margin-bottom: 2rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--smrt-color-outline);
  }

  .page-header h1 {
    font-size: var(--smrt-typography-display-small-size);
    font-weight: var(--smrt-typography-display-small-weight);
    margin-bottom: 0.5rem;
  }

  .subtitle {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size);
  }

  section {
    margin-bottom: 2.5rem;
  }

  section h2 {
    font-size: var(--smrt-typography-headline-small-size);
    font-weight: var(--smrt-typography-headline-small-weight);
    margin-bottom: 1rem;
    color: var(--smrt-color-on-surface);
  }

  .theme-info {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
  }

  .info-card {
    background: var(--smrt-color-surface-container);
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-lg);
    padding: 1rem 1.5rem;
    min-width: 120px;
  }

  .info-card .label {
    display: block;
    font-size: var(--smrt-typography-label-medium-size);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.25rem;
  }

  .info-card .value {
    display: block;
    font-size: var(--smrt-typography-title-large-size);
    font-weight: var(--smrt-typography-title-large-weight);
    color: var(--smrt-color-on-surface);
  }

  .capitalize {
    text-transform: capitalize;
  }

  .controls-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1rem;
  }

  .control-card {
    background: var(--smrt-color-surface-container);
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-lg);
    padding: 1.5rem;
  }

  .control-card h3 {
    font-size: var(--smrt-typography-title-medium-size);
    font-weight: var(--smrt-typography-title-medium-weight);
    margin-bottom: 1rem;
    color: var(--smrt-color-on-surface);
  }

  .showcase-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 1.5rem;
  }

  .showcase-card :global(.card-header) {
    font-size: var(--smrt-typography-title-medium-size);
    font-weight: var(--smrt-typography-title-medium-weight);
  }

  .full-width {
    grid-column: 1 / -1;
  }

  .color-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
    gap: 1rem;
  }

  .color-swatch {
    text-align: center;
  }

  .color-block {
    width: 60px;
    height: 60px;
    border-radius: var(--smrt-radius-lg);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    margin: 0 auto 0.5rem;
  }

  .color-name {
    font-size: var(--smrt-typography-label-small-size);
    color: var(--smrt-color-on-surface-variant);
  }

  .surface-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .surface-item {
    padding: 1rem;
    border-radius: var(--smrt-radius-md);
    border: 1px solid var(--smrt-color-outline);
  }

  .button-showcase {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .button-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .badge-showcase {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .badge-row {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .typography-showcase {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .typography-showcase p {
    margin: 0;
    padding: 0.25rem 0;
  }

  .display-large { font: var(--smrt-typography-display-large-size)/var(--smrt-typography-display-large-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-display-large-weight); }
  .display-medium { font: var(--smrt-typography-display-medium-size)/var(--smrt-typography-display-medium-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-display-medium-weight); }
  .display-small { font: var(--smrt-typography-display-small-size)/var(--smrt-typography-display-small-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-display-small-weight); }
  .headline-large { font: var(--smrt-typography-headline-large-size)/var(--smrt-typography-headline-large-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-headline-large-weight); }
  .headline-medium { font: var(--smrt-typography-headline-medium-size)/var(--smrt-typography-headline-medium-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-headline-medium-weight); }
  .headline-small { font: var(--smrt-typography-headline-small-size)/var(--smrt-typography-headline-small-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-headline-small-weight); }
  .title-large { font: var(--smrt-typography-title-large-size)/var(--smrt-typography-title-large-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-title-large-weight); }
  .title-medium { font: var(--smrt-typography-title-medium-size)/var(--smrt-typography-title-medium-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-title-medium-weight); }
  .title-small { font: var(--smrt-typography-title-small-size)/var(--smrt-typography-title-small-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-title-small-weight); }
  .body-large { font: var(--smrt-typography-body-large-size)/var(--smrt-typography-body-large-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-body-large-weight); }
  .body-medium { font: var(--smrt-typography-body-medium-size)/var(--smrt-typography-body-medium-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-body-medium-weight); }
  .body-small { font: var(--smrt-typography-body-small-size)/var(--smrt-typography-body-small-line-height) var(--smrt-font-family); font-weight: var(--smrt-typography-body-small-weight); }

  .elevation-showcase {
    display: flex;
    gap: 1.5rem;
    flex-wrap: wrap;
  }

  .elevation-box {
    width: 100px;
    height: 100px;
    background: var(--smrt-color-surface);
    border-radius: var(--smrt-radius-md);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--smrt-typography-label-large-size);
    color: var(--smrt-color-on-surface);
  }

  .glass-showcase {
    border-radius: var(--smrt-radius-lg);
  }

  .comparison-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: 1rem;
  }

  .comparison-card {
    background: var(--smrt-color-surface-container);
    border: 2px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-lg);
    padding: 1.5rem;
    transition: all 0.2s;
  }

  .comparison-card.active {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-primary-container);
  }

  .comparison-card h3 {
    font-size: var(--smrt-typography-title-large-size);
    margin-bottom: 1rem;
    color: var(--smrt-color-on-surface);
  }

  .comparison-card ul {
    list-style: none;
  }

  .comparison-card li {
    padding: 0.25rem 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size);
  }

  .comparison-card li::before {
    content: "✓ ";
    color: var(--smrt-color-primary);
    font-weight: bold;
  }
</style>
