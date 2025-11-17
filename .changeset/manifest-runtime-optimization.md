---
'@happyvertical/smrt-core': patch
---

refactor(manifest): eliminate runtime introspection and optimize manifest generation

- Remove all runtime reflection/introspection from manifest code
- Manifest generation now relies purely on AST-based static analysis
- Import generator from source in scripts for better development workflow
- Address code quality improvements from automated review
