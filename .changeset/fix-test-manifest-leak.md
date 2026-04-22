---
'@happyvertical/smrt-core': patch
---

Fix test manifest loading so downstream consumers do not register core-only test classes, and skip `SmrtCollection` manifest stubs when building test database schemas.
