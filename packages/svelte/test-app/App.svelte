<script lang="ts">
  import Button from '../src/lib/components/ui/Button.svelte';
  import Card from '../src/lib/components/ui/Card.svelte';
  import Badge from '../src/lib/components/ui/Badge.svelte';
  import WeatherForecast from '../src/lib/components/weather/WeatherForecast.svelte';
  import WeatherHeader from '../src/lib/components/weather/WeatherHeader.svelte';
  import type { ForecastDay } from '../src/lib/components/weather/WeatherForecast.svelte';

  // Import sample weather data
  import sampleWeather from '../data/sample-weather.json';
  const forecast: ForecastDay[] = sampleWeather;

  function scrollToSection(id: string) {
    const element = document.getElementById(id);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
</script>

<nav class="component-nav">
  <div class="nav-container">
    <h1 class="nav-title">SMRT Svelte Components</h1>
    <div class="nav-links">
      <button onclick={() => scrollToSection('buttons')}>Buttons</button>
      <button onclick={() => scrollToSection('cards')}>Cards</button>
      <button onclick={() => scrollToSection('badges')}>Badges</button>
      <button onclick={() => scrollToSection('weather-header')}>Weather Header</button>
      <button onclick={() => scrollToSection('weather-forecast')}>Weather Forecast</button>
    </div>
  </div>
</nav>

<main>
  <section id="buttons">
    <h2>Buttons</h2>
    <div class="examples">
      <Button variant="primary">Primary Button</Button>
      <Button variant="secondary">Secondary Button</Button>
      <Button variant="ghost">Ghost Button</Button>
      <Button variant="danger">Danger Button</Button>
    </div>

    <h3>Sizes</h3>
    <div class="examples">
      <Button variant="primary" size="sm">Small</Button>
      <Button variant="primary" size="md">Medium</Button>
      <Button variant="primary" size="lg">Large</Button>
    </div>

    <h3>Disabled</h3>
    <div class="examples">
      <Button variant="primary" disabled>Disabled</Button>
    </div>
  </section>

  <section id="cards">
    <h2>Cards</h2>
    <div class="examples cards">
      <Card variant="default">
        {#snippet children()}
          <p>Default card with some content</p>
        {/snippet}
      </Card>

      <Card variant="outlined">
        {#snippet children()}
          <p>Outlined card</p>
        {/snippet}
      </Card>

      <Card variant="elevated">
        {#snippet children()}
          <p>Elevated card with shadow</p>
        {/snippet}
      </Card>

      <Card variant="default" hoverable>
        {#snippet header()}
          <h3 style="margin: 0;">Card with Header</h3>
        {/snippet}
        {#snippet children()}
          <p>Hover over this card to see effects</p>
        {/snippet}
        {#snippet footer()}
          <div style="display: flex; gap: 1rem;">
            <button>Action 1</button>
            <button>Action 2</button>
          </div>
        {/snippet}
      </Card>
    </div>
  </section>

  <section id="badges">
    <h2>Badges</h2>
    <div class="examples">
      <Badge variant="default">Default</Badge>
      <Badge variant="primary">Primary</Badge>
      <Badge variant="success">Success</Badge>
      <Badge variant="warning">Warning</Badge>
      <Badge variant="error">Error</Badge>
      <Badge variant="info">Info</Badge>
    </div>

    <h3>Sizes</h3>
    <div class="examples">
      <Badge variant="primary" size="sm">Small</Badge>
      <Badge variant="primary" size="md">Medium</Badge>
    </div>
  </section>

  <section id="weather-header">
    <h2>Weather Header</h2>
    <div class="weather-container">
      <WeatherHeader {forecast} />
    </div>
  </section>

  <section id="weather-forecast">
    <h2>Weather Forecast</h2>
    <div class="weather-container">
      <WeatherForecast {forecast} />
    </div>
  </section>
</main>

<style>
  :global(body) {
    margin: 0;
    padding: 0;
  }

  .component-nav {
    position: sticky;
    top: 0;
    z-index: 100;
    background: var(--color-neutral-white);
    border-bottom: 2px solid var(--color-neutral-gray300);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.05);
  }

  .nav-container {
    max-width: 1200px;
    margin: 0 auto;
    padding: var(--spacing-md) var(--spacing-lg);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--spacing-lg);
  }

  .nav-title {
    margin: 0;
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-bold);
    color: var(--color-text-primary);
  }

  .nav-links {
    display: flex;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }

  .nav-links button {
    background: none;
    border: none;
    padding: var(--spacing-xs) var(--spacing-md);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    color: var(--color-text-secondary);
    cursor: pointer;
    border-radius: var(--border-radius-sm);
    transition: all 0.2s ease;
  }

  .nav-links button:hover {
    background: var(--color-neutral-gray100);
    color: var(--color-text-primary);
  }

  main {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
  }

  section {
    margin-bottom: 3rem;
    scroll-margin-top: 100px; /* Account for sticky nav */
  }

  h2 {
    margin-bottom: 1rem;
    border-bottom: 2px solid var(--color-neutral-gray200);
    padding-bottom: 0.5rem;
  }

  h3 {
    margin-top: 1.5rem;
    margin-bottom: 0.75rem;
  }

  .examples {
    display: flex;
    gap: 1rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .examples.cards {
    flex-direction: column;
    align-items: stretch;
  }

  .examples.cards > :global(*) {
    max-width: 400px;
  }

  .weather-container {
    background: var(--color-neutral-white);
    border-radius: var(--border-radius-md);
    padding: var(--spacing-md);
  }

  /* Responsive nav */
  @media (max-width: 768px) {
    .nav-container {
      flex-direction: column;
      align-items: flex-start;
      padding: var(--spacing-sm) var(--spacing-md);
    }

    .nav-title {
      font-size: var(--font-size-lg);
    }

    .nav-links {
      width: 100%;
      justify-content: flex-start;
    }

    .nav-links button {
      font-size: var(--font-size-xs);
      padding: var(--spacing-xs) var(--spacing-sm);
    }

    section {
      scroll-margin-top: 140px;
    }
  }
</style>
