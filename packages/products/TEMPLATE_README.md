# HAVE SMRT Template

A GitHub template for building AI-powered applications with the HAVE SDK ecosystem.

## Quick Start

1. **Use this template**: Click "Use this template" on GitHub
2. **Install dependencies**: `bun install`
3. **Start development**: `bun run dev`

## What's Included

### 🚀 Full Stack Foundation
- **SMRT Objects**: Define your domain models with decorators
- **Auto-generated APIs**: REST, GraphQL, and OpenAPI from objects
- **MCP Tools**: AI-native tools for LLM integration
- **CLI Interface**: Command-line tools for your application
- **Authentication**: Keycloak integration out-of-the-box

### 📦 Example Applications
- **E-commerce**: Product and Category management
- **SvelteKit UI**: Modern frontend with auto-generated forms
- **Microservice**: Complete deployment-ready backend

### 🛠 Development Tools
- **TypeScript**: Full type safety
- **Bun**: Fast package management and runtime
- **Biome**: Code formatting and linting
- **Vitest**: Testing framework

## Project Structure

```
├── packages/
│   ├── smrt-template/          # This template package
│   │   ├── src/
│   │   │   ├── examples/       # Example applications
│   │   │   ├── auth/          # Authentication components
│   │   │   └── microservice.ts # Main orchestration
│   │   └── templates/         # GitHub template files
│   └── sveltekit-template/    # SvelteKit frontend template
└── docs/                      # Documentation and workflows
```

## Usage Patterns

### 1. Define SMRT Objects

```typescript
import { SmrtObject, smrt, text, decimal, boolean } from '@have/smrt';

@smrt({
  api: { exclude: ['delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true
})
class Product extends SmrtObject {
  name = text({ required: true });
  description = text();
  price = decimal({ min: 0, required: true });
  inStock = boolean({ default: true });
}
```

### 2. Create Smart Microservice

```typescript
import { SmartMicroservice } from '@have/smrt-template';

const app = new SmartMicroservice([Product], {
  name: 'my-api',
  generators: ['api', 'mcp', 'cli'],
  database: { type: 'postgres', url: process.env.DATABASE_URL },
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
});

const services = await app.start();
```

### 3. Generate Frontend Components

```typescript
// Auto-generate Svelte forms from SMRT objects
import { generateFromTemplate } from '@have/svelte';

await generateFromTemplate('./src/objects', './src/components');
```

## Templates

### SvelteKit Application
- Modern Svelte 5 with runes
- shadcn-svelte components
- Auto-generated forms from SMRT objects
- TypeScript and Tailwind CSS

### Express API
- REST endpoints from SMRT objects
- OpenAPI documentation
- Authentication middleware
- Health checks and monitoring

### MCP Server
- AI tools generated from objects
- LLM-native function calling
- Type-safe tool definitions
- Claude Desktop integration

### CLI Application
- Interactive prompts
- CRUD operations for objects
- Batch processing commands
- Configuration management

## Deployment

### Docker
```dockerfile
FROM oven/bun:alpine
COPY . /app
WORKDIR /app
RUN bun install
RUN bun run build
CMD ["bun", "start"]
```

### Vercel (SvelteKit)
```bash
# Already configured for Vercel deployment
bun run build
```

### AWS Lambda (Serverless)
```typescript
export const handler = app.generateHandler();
```

### Kubernetes
Helm charts and manifests included in `/k8s` directory.

## Configuration

### Environment Variables
```bash
# Database
DATABASE_URL=postgres://localhost/myapp

# Authentication
KEYCLOAK_URL=http://localhost:8080
KEYCLOAK_CLIENT_ID=my-app

# AI Integration
OPENAI_API_KEY=sk-...
```

### Package Scripts
```json
{
  "dev": "bun run src/index.ts",
  "build": "bun build src/index.ts",
  "start": "bun run build/index.js",
  "test": "vitest",
  "generate": "smrt generate"
}
```

## Examples

See the `/examples` directory for complete applications:
- **E-commerce**: Product catalog with categories
- **Blog**: Posts and comments
- **CRM**: Contacts and companies
- **Inventory**: Items and locations

## Contributing

This template is part of the HAVE SDK ecosystem. Contributions welcome!

1. Fork the repository
2. Create your feature branch
3. Add tests for new functionality
4. Submit a pull request

## License

MIT - Use this template freely for any project.