# @happyvertical/smrt-svelte

Svelte 5 component library for the SMRT framework with modern runes-based reactivity.

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

## Layout Components

### Container

A responsive container component that centers content with configurable max widths.

**Props:**
- `maxWidth`: 'sm' | 'md' | 'lg' | 'xl' | 'full' (default: 'lg')

**Usage:**

```svelte
<script>
  import { Container } from '@happyvertical/smrt-svelte';
</script>

<Container maxWidth="lg">
  <p>Centered content with max-width: 1024px</p>
</Container>
```

### Grid

A responsive grid layout component with automatic or fixed columns.

**Props:**
- `columns`: number | 'auto' (default: 'auto')
- `gap`: 'sm' | 'md' | 'lg' | 'xl' (default: 'md')

**Usage:**

```svelte
<script>
  import { Grid } from '@happyvertical/smrt-svelte';
</script>

<!-- Auto-fill grid (responsive) -->
<Grid columns="auto" gap="lg">
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</Grid>

<!-- Fixed 3-column grid -->
<Grid columns={3} gap="md">
  <div>Item 1</div>
  <div>Item 2</div>
  <div>Item 3</div>
</Grid>
```

### Header

A site header component with logo and navigation sections.

**Props:**
- `logo`: Snippet (optional)
- `nav`: Snippet (optional)

**Usage:**

```svelte
<script>
  import { Header } from '@happyvertical/smrt-svelte';
</script>

<Header>
  {#snippet logo()}
    <h1><a href="/">Site Name</a></h1>
  {/snippet}

  {#snippet nav()}
    <a href="/">Home</a>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
  {/snippet}
</Header>
```

### Footer

A site footer component with copyright and optional links.

**Usage:**

```svelte
<script>
  import { Footer } from '@happyvertical/smrt-svelte';
</script>

<Footer>
  {#snippet children()}
    <a href="/privacy">Privacy</a>
    <a href="/terms">Terms</a>
  {/snippet}
</Footer>
```

### Masthead

A newspaper-style masthead with date, location, and navigation.

**Props:**
- `date`: string (default: current date)
- `location`: string (default: '')
- `nav`: Snippet (optional)

**Usage:**

```svelte
<script>
  import { Masthead } from '@happyvertical/smrt-svelte';
</script>

<Masthead location="Bentley, Alberta">
  {#snippet nav()}
    <a href="/news">News</a>
    <a href="/events">Events</a>
  {/snippet}
</Masthead>
```

## Content Components

### Markdown

A simple markdown renderer component.

**Props:**
- `content`: string (markdown content)

**Usage:**

```svelte
<script>
  import { Markdown } from '@happyvertical/smrt-svelte';

  const markdownContent = `
# Heading 1
## Heading 2

This is **bold** and this is *italic*.

- List item 1
- List item 2
`;
</script>

<Markdown content={markdownContent} />
```

**Supported Markdown:**
- Headings (H1-H3)
- Bold (**text**)
- Italic (*text*)
- Lists (- item)
- Paragraphs

### ArticleCard

A card component for displaying article previews.

**Props:**
- `article`: Article object
- `showExcerpt`: boolean (default: true)
- `showDate`: boolean (default: true)
- `showAuthor`: boolean (default: true)
- `showTags`: boolean (default: false)

**Types:**
```typescript
interface Article {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  publish_date: string | null;
  author: string | null;
  tags: string;
}
```

**Usage:**

```svelte
<script>
  import { ArticleCard } from '@happyvertical/smrt-svelte';

  const article = {
    id: '1',
    slug: 'my-article',
    title: 'Article Title',
    description: 'A brief description...',
    publish_date: '2024-01-01',
    author: 'John Doe',
    tags: 'news,local'
  };
</script>

<ArticleCard {article} showTags />
```

### ArticleList

A grid layout for displaying multiple articles.

**Props:**
- `articles`: Article[] (array of articles)
- `columns`: number | 'auto' (default: 'auto')
- `showExcerpt`: boolean (default: true)
- `showDate`: boolean (default: true)
- `showAuthor`: boolean (default: true)
- `showTags`: boolean (default: false)
- `emptyMessage`: string (default message for empty state)

**Usage:**

```svelte
<script>
  import { ArticleList } from '@happyvertical/smrt-svelte';

  const articles = [
    { id: '1', slug: 'article-1', title: 'First Article', ... },
    { id: '2', slug: 'article-2', title: 'Second Article', ... }
  ];
</script>

<ArticleList {articles} columns={3} showTags />
```

## Weather Components

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
