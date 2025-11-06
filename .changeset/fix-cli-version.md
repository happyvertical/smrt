---
"@happyvertical/smrt-cli": patch
---

fix(cli): read version from package.json instead of hardcoded '1.0.0'

The CLI was showing version '1.0.0' regardless of the actual package version. Now it reads the version dynamically from package.json using pure ESM (readFileSync + fileURLToPath), so `smrt version` will correctly show the actual package version (currently 0.12.0).
