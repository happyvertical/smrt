# @happyvertical/smrt-template-sveltekit

SvelteKit project template with SMRT framework integration.

## Features

- SvelteKit 2.x with Svelte 5
- Auto-generated REST API routes
- SMRT CLI integration
- TypeScript support
- SQLite database (configurable to PostgreSQL)

## Usage

### With smrt CLI (recommended)

```bash
smrt gnode create my-app --template sveltekit
cd my-app
npm install
npm run dev
```

### With smrt init (existing project)

```bash
cd existing-sveltekit-project
smrt init
```

### Manual copy

```bash
npx degit happyvertical/smrt/packages/template-sveltekit/template my-app
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

## Template Structure

```
template/
├── src/
│   ├── lib/
│   │   ├── objects/       # SMRT objects
│   │   └── server/        # Server configuration
│   └── routes/
│       └── +page.svelte   # Home page
├── smrt.config.ts         # SMRT configuration
├── vite.config.ts         # Vite + SMRT plugin
├── svelte.config.js       # SvelteKit config
├── tsconfig.json          # TypeScript config
├── package.json           # Dependencies
└── README.md              # Project docs
```

## Related

- [SMRT Framework](https://github.com/happyvertical/smrt)
- [SvelteKit](https://kit.svelte.dev/)
