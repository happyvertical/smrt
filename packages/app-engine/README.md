# @happyvertical/smrt-app-engine

Shared s-m-r-t app engine for definition-driven products. Hosts provide version storage and approval decisions; the engine runs app models in isolated worker threads with migrations, sandboxed methods and reversible drafts.

```ts
import { AppHost, MemoryVersionStore } from '@happyvertical/smrt-app-engine';

const host = await AppHost.open('./app-data', { store: new MemoryVersionStore() });
await host.close();
```

The root entry exports the engine API. `./worker` is the worker-thread entry for hosts that supply an explicit worker URL. The package has no shell or SvelteKit dependency. Its name is provisional.

See [engine contracts](agents/engine.md) for approvals, persistence and recovery. Run `pnpm build`, `pnpm typecheck` and `pnpm test` in this package after building workspace dependencies.

Calculated fields use portable SQL expressions evaluated by the database. The shared engine validates dependencies, runs bounded definition reports, loads records atomically, extracts text into referenced models and merges records with reversible reference updates. The browser-safe `./formula` entry exports `formulaWords`, which renders expressions using a host-provided map of field labels; tool schemas are exported for host adapters. See [test design](agents/engine-4916-tests.md).
