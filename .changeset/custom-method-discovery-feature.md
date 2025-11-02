---
"@happyvertical/smrt-cli": minor
"@happyvertical/smrt-core": minor
"@happyvertical/smrt-accounts": patch
"@happyvertical/smrt-agents": patch
"@happyvertical/smrt-assets": patch
"@happyvertical/smrt-config": patch
"@happyvertical/smrt-content": patch
"@happyvertical/smrt-dev-mcp": patch
"@happyvertical/smrt-docs-mcp": patch
"@happyvertical/smrt-events": patch
"@happyvertical/smrt-gnode": patch
"@happyvertical/smrt-places": patch
"@happyvertical/smrt-products": patch
"@happyvertical/smrt-profiles": patch
"@happyvertical/smrt-svelte": patch
"@happyvertical/smrt-tags": patch
"@happyvertical/smrt-types": patch
---

- feat(core): add getMethods() API to ObjectRegistry for custom method discovery
- feat(cli): automatically discover and generate CLI commands for custom methods defined on SMRT objects

Custom methods defined on SMRT objects are now automatically discovered at build time and exposed through the CLI generator. This eliminates the need for manual CLI command configuration for custom methods.

Example:
```typescript
@smrt({ cli: { include: ['list', 'get', 'research'] } })
class Agent extends SmrtObject {
  async research(options: { query: string, depth?: number }) {
    // Custom method automatically gets CLI command:
    // smrt agent:research <id> --query "topic" --depth 5
  }
}
```
