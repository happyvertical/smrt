---
"@happyvertical/smrt-assets": patch
"@happyvertical/smrt-assets-local": patch
"@happyvertical/smrt-assets-ergot": patch
"@happyvertical/smrt-content": patch
---

Add first-class asset metadata/external reference fields plus local and Ergot capability adapters. Existing deployments must run the SMRT migration flow so the `assets` table includes `metadata` and `external_refs` before processors persist synced asset state.

Expose a focused content governance tool wrapper and section-hiding support for docked content workflows.
