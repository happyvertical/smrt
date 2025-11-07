---
"@happyvertical/smrt-core": patch
"@happyvertical/smrt-dev-mcp": patch
"@happyvertical/smrt-assets": patch
---

Fix TypeScript build errors preventing successful compilation

- **core**: Add explicit return type to `mockCollectionConstructors` method to resolve vitest type inference error
- **smrt-dev-mcp**: Use type assertions for MCP tool arguments and remove unused variable
- **assets**: Correct parameter order in `db.upsert` call (unique columns before data)
