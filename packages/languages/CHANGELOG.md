# @happyvertical/smrt-languages

## 0.24.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.24.1
  - @happyvertical/smrt-features@0.24.1
  - @happyvertical/smrt-jobs@0.24.1
  - @happyvertical/smrt-prompts@0.24.1
  - @happyvertical/smrt-tenancy@0.24.1
  - @happyvertical/smrt-config@0.24.1

## 1.0.0

### Minor Changes

- bbce581: Add `@happyvertical/smrt-languages` — code-first language strings with file/config + tenant overrides and an AI auto-translation pipeline backed by `smrt-jobs`. Mirrors the architecture of `smrt-prompts`, plus a deterministic-job-ID dedup so concurrent locale misses collapse into one translation. Honors a `smrt-features` kill switch (`smrt-languages.auto_translate`), a per-tenant daily budget, and an optional locale allowlist; never overwrites human-edited rows.

### Patch Changes

- @happyvertical/smrt-config@1.0.0
- @happyvertical/smrt-core@1.0.0
- @happyvertical/smrt-features@1.0.0
- @happyvertical/smrt-jobs@1.0.0
- @happyvertical/smrt-prompts@1.0.0
- @happyvertical/smrt-tenancy@1.0.0
