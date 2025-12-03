# Static Site Template (JSON Data)

A template for creating static community news sites with JSON-based data storage.

## Features

- **Static Site Generation**: Pre-renders all pages for fast hosting
- **JSON Data Storage**: Simple file-based data in `data/*.json`
- **Weather Integration**: Environment Canada forecasts via Caelus
- **Meeting Scraping**: Automated council meeting coverage via Praeco
- **Config-Driven**: Site identity, navigation, and theming via `smrt.config.js`

## Usage

```bash
# Create a new site
smrt gnode create my-town-site --template site-static-json \
  --location "My Town, AB" \
  --lat 53.5 --lon -113.5

# Navigate to project
cd my-town-site

# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env

# Initialize data files
pnpm run init-data

# Start development server
pnpm dev
```

## Configuration

Edit `smrt.config.js` to customize:

### Site Identity

```javascript
site: {
  name: 'My Town Alberta',
  shortName: 'My Town',
  description: 'Local news for My Town',
  location: { name: 'My Town', latitude: 53.5, longitude: -113.5 },
  navigation: { primary: [...], footer: [...] },
  theme: { primaryColor: '#1976d2' },
}
```

### Data Sources (Praeco)

```javascript
modules: {
  praeco: {
    sources: [
      {
        type: 'documents',
        council: 'my-council',
        url: 'https://example.com/meetings',
      },
    ],
  },
}
```

## Project Structure

```
my-town-site/
├── smrt.config.js      # Site configuration
├── data/               # JSON data storage
├── scripts/
│   └── init-data.ts    # Data initialization
└── src/
    ├── site.config.ts  # Site config helper
    ├── routes/         # SvelteKit pages
    └── lib/
        └── utils/      # Shared utilities
```

## Deployment

This template uses SvelteKit's static adapter. Build and deploy to any static host:

```bash
pnpm build
# Deploy ./build to S3, Netlify, Vercel, etc.
```

## License

MIT
