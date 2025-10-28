# @happyvertical/smrt-svelte

Svelte 5 component library with Histoire documentation for the SMRT framework.

## Installation

```bash
npm install @happyvertical/smrt-svelte
```

Or using pnpm:

```bash
pnpm add @happyvertical/smrt-svelte
```

## Components

### Button

A versatile button component that supports multiple variants, sizes, and can render as either a button or link.

**Props:**
- `variant`: 'primary' | 'secondary' | 'ghost' | 'danger' (default: 'primary')
- `size`: 'sm' | 'md' | 'lg' (default: 'md')
- `href`: Optional URL to render as link
- `disabled`: Boolean to disable the button
- `type`: 'button' | 'submit' | 'reset' (default: 'button')

**Usage:**

```svelte
<script>
  import { Button } from '@happyvertical/smrt-svelte';
</script>

<Button variant="primary" size="md">
  Click me
</Button>

<!-- As a link -->
<Button variant="primary" href="/path">
  Navigate
</Button>
```

### Card

A flexible card component with optional header and footer sections.

**Props:**
- `variant`: 'default' | 'outlined' | 'elevated' (default: 'default')
- `padding`: 'none' | 'sm' | 'md' | 'lg' (default: 'md')
- `hoverable`: Boolean to enable hover effects

**Usage:**

```svelte
<script>
  import { Card } from '@happyvertical/smrt-svelte';
</script>

<Card variant="elevated" hoverable>
  {#snippet header()}
    <h3>Card Title</h3>
  {/snippet}

  {#snippet children()}
    <p>Card content goes here.</p>
  {/snippet}

  {#snippet footer()}
    <button>Action</button>
  {/snippet}
</Card>
```

### Badge

A small status indicator component.

**Props:**
- `variant`: 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info' (default: 'default')
- `size`: 'sm' | 'md' (default: 'md')

**Usage:**

```svelte
<script>
  import { Badge } from '@happyvertical/smrt-svelte';
</script>

<Badge variant="success">
  Active
</Badge>
```

### WeatherHeader

A horizontal multi-day weather forecast component with slide-down hourly details panel.

**Props:**
- `forecast`: Array of forecast days (optional)

**Types:**
```typescript
interface HourlyForecast {
  time: string;        // "9a", "12p", "3p"
  hour: number;        // 24-hour format (0-23)
  icon: string;        // Weather emoji
  temperature: number;
  feelsLike: number;
}

interface DayForecast {
  id: string;         // Unique identifier
  dayName: string;    // "Mon", "Tue"
  date: string;       // "27 Oct"
  icon: string;       // Weather emoji
  high: number;
  low: number;
  hourlyData: HourlyForecast[];
}
```

**Usage:**

```svelte
<script>
  import { WeatherHeader } from '@happyvertical/smrt-svelte';
  import type { ForecastDay } from '@happyvertical/smrt-svelte';

  const forecast: ForecastDay[] = [
    {
      day: "Mon",
      icon: "☀️",
      high: 25,
      low: 15,
      periods: [
        {
          name: "Morning (09:00)",
          conditions: "clear sky",
          temperature: 20,
          windSpeed: 10,
          windDirection: 180,
          humidity: 45,
          precipProbability: 0,
          localHour: 9
        }
      ]
    }
  ];
</script>

<WeatherHeader {forecast} />
```

**Features:**
- Horizontal scrollable day cards
- Click to expand hourly forecast panel
- Smooth slide-down animation
- Scroll arrows for hourly data navigation
- Auto-scrolls to 4am for future days
- Falls back to mock data if no forecast provided

### WeatherForecast

An interactive weather forecast component with expandable days, day/night tabs, and temperature charts.

**Props:**
- `forecast`: Array of forecast days (optional)

**Types:**
```typescript
interface ForecastPeriod {
  name: string;
  conditions: string;
  temperature: number;
  windSpeed: number;
  windDirection: number;
  humidity: number;
  precipProbability: number;
}

interface ForecastDay {
  day: string;              // Day abbreviation (e.g., "Mon", "Tue")
  icon: string;             // Weather icon emoji
  high: number;             // High temperature
  low: number;              // Low temperature
  periods: ForecastPeriod[]; // Day/night periods
}
```

**Usage:**

```svelte
<script>
  import { WeatherForecast } from '@happyvertical/smrt-svelte';
  import type { ForecastDay } from '@happyvertical/smrt-svelte';

  const forecast: ForecastDay[] = [
    {
      day: "Mon",
      icon: "☀️",
      high: 25,
      low: 15,
      periods: [
        {
          name: "Morning (09:00)",
          conditions: "clear sky",
          temperature: 20,
          windSpeed: 10,
          windDirection: 180,
          humidity: 45,
          precipProbability: 0
        },
        {
          name: "Evening night (19:00)",
          conditions: "clear sky",
          temperature: 18,
          windSpeed: 8,
          windDirection: 200,
          humidity: 55,
          precipProbability: 0
        }
      ]
    }
  ];
</script>

<WeatherForecast {forecast} />
```

**Features:**
- Accordion-style expandable days
- Day/night period tabs
- Interactive temperature chart
- Wind direction indicators
- Humidity and precipitation data
- Responsive design with horizontal scrolling

## Design Tokens

This library uses CSS custom properties for theming. You can customize the appearance by overriding these tokens:

```css
:root {
  /* Primary colors */
  --color-primary-main: #1976d2;
  --color-primary-light: #e3f2fd;
  --color-primary-dark: #1565c0;

  /* Spacing */
  --spacing-sm: 0.5rem;
  --spacing-md: 1rem;
  --spacing-lg: 1.5rem;

  /* Border radius */
  --radius-md: 0.5rem;
  --radius-full: 9999px;

  /* And more... */
}
```

See `src/styles/tokens.css` for the full list of available design tokens.

## Development

### Testing Components Locally

To view the components in a test app:

```bash
pnpm run dev
```

This will start a Vite dev server with a test app showcasing all components. Open your browser to the URL shown (typically `http://localhost:5173/`).

The test app is located in `test-app/` and demonstrates all component variants and features.

### Building

```bash
pnpm run build
```

This command:
1. Builds the library with Vite
2. Packages the components with svelte-package for distribution

### Testing

```bash
pnpm test
```

## Component Documentation Note

**Svelte 5 Compatibility**: This library uses Svelte 5 with runes syntax ($props, $derived, snippets). As of December 2024:
- **Histoire**: Does not support Svelte 5 (removed from CI testing)
- **Storybook 8**: Internal components use legacy Svelte 4 syntax, incompatible with runes mode
- **Storybook 9+**: Full Svelte 5 support announced but addon ecosystem still catching up

For now, component testing is done via the included test app (`pnpm run dev`). Future versions will integrate Storybook when the ecosystem fully supports Svelte 5.

## License

MIT

## Author

Will Griffin <willgriffin@gmail.com>
