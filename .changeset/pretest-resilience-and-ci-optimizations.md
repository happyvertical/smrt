---
"@happyvertical/smrt-accounts": patch
"@happyvertical/smrt-assets": patch
"@happyvertical/smrt-events": patch
"@happyvertical/smrt-gnode": patch
"@happyvertical/smrt-tags": patch
"@happyvertical/smrt-svelte": patch
"@happyvertical/smrt-docs-mcp": patch
"@happyvertical/smrt-profiles": patch
---

Make pretest scripts resilient to CLI not being built yet

The pretest script now checks if `../cli/dist/index.js` exists before trying to run it, allowing tests to pass in scenarios where packages aren't built yet (like the cascade handler workflow). This uses the pattern `[ -f file ] && command || true` which silently succeeds if the CLI isn't available, while still running manifest generation when it is.
