# @happyvertical/smrt-template-sveltekit

SvelteKit project template with SMRT framework integration. Scaffolds a full-stack app with auto-generated REST API routes, TypeScript, and SQLite.

## What This Template Provides

- SvelteKit 2.x with Svelte 5 and TypeScript
- `smrtPlugin()` Vite integration for automatic REST API route generation
- Example `@smrt()` object (`Item.ts`) with barrel export
- Server-side SMRT initialization (`src/lib/server/smrt.ts`)
- `smrt.config.ts` with SQLite database and optional AI provider
- `.env.example` with starter environment variables

## Prerequisites

- Node.js 18+
- pnpm (recommended) or npm

## Usage

### With smrt CLI (recommended)

```bash
smrt gnode create my-app --template sveltekit
cd my-app
npm install
npm run dev
```

### Programmatic usage

```javascript
import { copyTemplate } from '@happyvertical/smrt-template-sveltekit';

copyTemplate('./my-new-project', {
  name: 'my-app',
  overwrite: false,
});
```

## Getting Started (after scaffolding)

```bash
cd my-app
npm install
cp .env.example .env    # Edit with your values
npm run dev             # Start dev server at http://localhost:5173
```

## Environment Variables

Defined in `.env.example`:

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Database path (default: `./data/app.db`) |
| `DATABASE_TYPE` | Yes | Database engine (default: `sqlite`) |
| `PUBLIC_SITE_NAME` | No | Display name for the site |
| `PUBLIC_SITE_URL` | No | Public URL (default: `http://localhost:5173`) |
| `OPENAI_API_KEY` | No | OpenAI API key for AI features |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (alternative AI provider) |

## Template Structure

```
template/
├── .env.example            # Environment variable defaults
├── .gitignore
├── package.json            # Dependencies (smrt-core, SvelteKit)
├── smrt.config.ts          # SMRT configuration (DB, AI, schema migration)
├── svelte.config.js        # SvelteKit config (adapter-auto)
├── tsconfig.json
├── vite.config.ts          # Vite + smrtPlugin() for API route generation
└── src/
    ├── app.d.ts            # SvelteKit type declarations
    ├── app.html            # HTML shell
    ├── lib/
    │   ├── objects/
    │   │   ├── index.ts    # Barrel export
    │   │   └── Item.ts     # Example @smrt() object
    │   └── server/
    │       └── smrt.ts     # Server-side SMRT initialization
    └── routes/
        └── +page.svelte    # Home page
```

## Exports

This package exposes three things for programmatic use:

- `getTemplatePath()` -- returns the absolute path to the `template/` directory
- `copyTemplate(destination, options)` -- copies template files with project name substitution in `package.json`
- `templateInfo` -- metadata object describing the template

## Placeholder Substitution

During `smrt gnode create`, these placeholders are replaced in template files:

| Placeholder | Value |
|-------------|-------|
| `{{PROJECT_NAME}}` | Project name from CLI |
| `{{PACKAGE_NAME}}` | Lowercase, hyphenated package name |

## Related

- [SMRT Framework](https://github.com/happyvertical/smrt)
- [SvelteKit](https://kit.svelte.dev/)
