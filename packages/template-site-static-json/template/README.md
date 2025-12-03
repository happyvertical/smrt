# {{SITE_NAME}}

Local news and community information for {{LOCATION_NAME}}.

## Getting Started

```bash
# Install dependencies
pnpm install

# Initialize data files
pnpm run init-data

# Start development server
pnpm dev
```

## Configuration

Edit `smrt.config.js` to configure:

- **Site identity**: Name, location, navigation
- **Data sources**: Council meeting URLs for Praeco
- **Weather**: Location coordinates for Caelus

## Workflows

```bash
# Fetch weather data
pnpm workflow:caelus

# Generate articles from council meetings
pnpm workflow:praeco
```

## Deployment

```bash
# Build static site
pnpm build

# Preview production build
pnpm preview
```

Deploy the `build/` directory to any static host (S3, Netlify, Vercel, etc.).

## Project Structure

```
├── smrt.config.js      # Site configuration
├── data/               # JSON data storage
├── scripts/            # Utility scripts
└── src/
    ├── site.config.ts  # Config helper
    ├── app.css         # Global styles
    ├── routes/         # SvelteKit pages
    └── lib/            # Shared utilities
```
