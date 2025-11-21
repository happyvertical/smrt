---
"@happyvertical/smrt-agents": patch
"@happyvertical/smrt-assets": patch
"@happyvertical/smrt-events": patch
"@happyvertical/smrt-gnode": patch
"@happyvertical/smrt-places": patch
"@happyvertical/smrt-profiles": patch
"@happyvertical/smrt-svelte": patch
"@happyvertical/smrt-tags": patch
"@happyvertical/smrt-docs-mcp": patch
---

feat(build): auto-generate test-manifest-stub.ts from dist/manifest.json

Ensures test manifest stubs stay in sync with generated manifests.
Fixes #373 - Event.seriesId now correctly marked as optional.
