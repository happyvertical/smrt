---
"@happyvertical/smrt-types": patch
"@happyvertical/smrt-config": patch
"@happyvertical/smrt-core": patch
"@happyvertical/smrt-accounts": patch
"@happyvertical/smrt-agents": patch
"@happyvertical/smrt-assets": patch
"@happyvertical/smrt-cli": patch
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
---

Enable GitHub Package Registry publishing for all SMRT packages

- Add @happyvertical scope to .npmrc for GitHub Package Registry
- Configure authentication with GITHUB_TOKEN
- All packages now publish to https://npm.pkg.github.com/@happyvertical/*
