# SMRT context map

SMRT is a multi-context monorepo. Use this map to find the package-level contracts and any domain glossaries relevant to a change. Context-specific `CONTEXT.md` files and ADR directories are added lazily as terminology and decisions are resolved.

| Context | Packages | Domain sources |
| --- | --- | --- |
| Framework foundations | `core`, `config`, `cli`, `types`, `scanner`, `tenancy`, `vitest` | Package `AGENTS.md` files |
| Agent runtime, identity, and communications | `agents`, `jobs`, `users`, `profiles`, `personas`, `messages`, `chat`, `secrets` | [`packages/messages/CONTEXT.md`](packages/messages/CONTEXT.md), package `AGENTS.md` files, [`docs/adr/0001-persona-scoped-messaging.md`](docs/adr/0001-persona-scoped-messaging.md) |
| Content and media | `content`, `assets`, `images`, `video`, `voice`, `social` | Package `AGENTS.md` files |
| Business capabilities | `commerce`, `products`, `ads`, `affiliates`, `ledgers`, `analytics`, `reports`, `subscriptions` | Package `AGENTS.md` files |
| Domain capabilities | `events`, `places`, `facts`, `sites`, `properties`, `tags` | Package `AGENTS.md` files |
| Mobile | `smrt-mobile`, `smrt-android`, `smrt-ios`, `smrt-mobile-contract` | Package `AGENTS.md` files |
| Web and application tooling | `smrt-web`, `smrt-svelte`, `smrt-ui`, `smrt-app-cli`, `smrt-dev-mcp`, `smrt-app-mcp`, templates | Package `AGENTS.md` files |
| Admin Shell | `smrt-svelte` workspace and shell surfaces | Root `CONTEXT.md` |

For cross-context work, read every affected row. System-wide decisions belong in root `docs/adr/`; context-local decisions should live beside the relevant context.
