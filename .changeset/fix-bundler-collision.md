---
"@happyvertical/smrt-core": patch
---

Fix class name collision in bundled contexts (Vite/SvelteKit)

When bundlers like Vite duplicate module code into multiple chunks, the same class
can be registered multiple times with different source file paths (e.g., different
chunk files). This caused false collision errors for legitimate re-registrations.

The fix detects bundled contexts by checking if the source file is in a build
output directory (.svelte-kit/output, dist, build, .next, .nuxt) and allows
re-registration if the existing entry came from a known package manifest.
