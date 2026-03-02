# @happyvertical/smrt-template-site-static-json

Template for static community news sites with JSON-based data storage. Generates a SvelteKit static site with weather integration (Caelus) and council meeting scraping (Praeco).

## What This Template Provides

- SvelteKit with `adapter-static` for static site generation
- JSON file-based data storage in `data/`
- Config-driven site identity, navigation, categories, and theming via `smrt.config.js`
- Weather forecasts via Caelus (Environment Canada)
- Council meeting scraping and article generation via Praeco
- Typed site config helper (`initSiteConfig()`/`getSite()`)
- Pre-built routes: home, about, contact
- Markdown utility for content rendering

## Prerequisites

- Node.js 18+
- pnpm (recommended)
- Gemini API key (for Praeco article generation)

## Usage

```bash
smrt gnode create my-town-site --template site-static-json \
  --location "My Town, AB" \
  --lat 53.5 --lon -113.5

cd my-town-site
pnpm install
cp .env.example .env      # Add your GEMINI_API_KEY
pnpm run init-data        # Initialize data directory
pnpm dev                  # Start dev server
```

## Environment Variables

Defined in `.env.example`:

| Variable | Required | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | Yes | Google Gemini API key for Praeco article generation |
| `PUBLIC_GTM_ID` | No | Google Tag Manager container ID |
| `CUSTOM_DOMAIN` | No | Custom domain for deployment |

## Configuration

Edit `smrt.config.js` to customize. Key sections:

- **`site`** -- name, description, location, navigation links, theme colors
- **`categories`** -- content categories for routing (e.g., `politics/local`)
- **`modules.praeco`** -- council meeting sources and report configurations
- **`modules.caelus`** -- weather location (set automatically from `--lat`/`--lon` flags)

## Available Scripts

| Script | Description |
|--------|-------------|
| `pnpm dev` | Start development server |
| `pnpm build` | Build static site to `./build` |
| `pnpm preview` | Preview the built site |
| `pnpm run init-data` | Initialize JSON data files |
| `pnpm run workflow:caelus` | Fetch weather data |
| `pnpm run workflow:praeco` | Scrape council meetings |
| `pnpm run validate:json` | Validate JSON data files |
| `pnpm run validate:slugs` | Validate content slugs |

## Template Structure

```
template/
├── .env.example              # Environment variables
├── .gitignore
├── package.json              # Scripts and dependency placeholders
├── smrt.config.js            # Site identity, modules, theme
├── svelte.config.js          # SvelteKit with adapter-static
├── tsconfig.json
├── vite.config.ts
├── data/                     # JSON data storage directory
├── scripts/
│   └── init-data.ts          # Data initialization script
└── src/
    ├── app.css               # Global styles
    ├── app.d.ts              # SvelteKit type declarations
    ├── app.html              # HTML shell
    ├── site.config.ts        # Typed config helper (initSiteConfig/getSite)
    ├── lib/
    │   └── utils/
    │       └── markdown.ts   # Markdown rendering utility
    └── routes/
        ├── +layout.server.ts # Loads site config for all routes
        ├── +layout.svelte    # Root layout
        ├── +page.server.ts   # Home page data
        ├── +page.svelte      # Home page
        ├── about/            # About page
        └── contact/          # Contact page
```

## Placeholder Substitution

During `smrt gnode create`, placeholders like `{{SITE_NAME}}`, `{{LOCATION_NAME}}`, `{{LATITUDE}}`, `{{LONGITUDE}}`, and `{{TIMEZONE}}` are replaced from CLI flags. See `template.config.js` for the full mapping.

## Deployment

This template uses SvelteKit's static adapter. Build and deploy to any static host:

```bash
pnpm build
# Deploy ./build to S3, Netlify, Vercel, Cloudflare Pages, etc.
```

## Related

- [SMRT Framework](https://github.com/happyvertical/smrt)
- [SvelteKit](https://kit.svelte.dev/)
