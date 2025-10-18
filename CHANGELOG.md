# 1.0.0 (2025-10-18)


### Bug Fixes

* **agents:** fix import sorting in agent.test.ts ([2dc606d](https://github.com/happyvertical/smrt/commit/2dc606dad02ec5264fcdae3689592452e56148b6))
* apply Biome formatting to resolve CI errors ([ca73664](https://github.com/happyvertical/smrt/commit/ca7366406646b414d713a3793d5c4fa5fafd6b14))
* apply Biome formatting to resolve CI errors ([af9e447](https://github.com/happyvertical/smrt/commit/af9e44724e49b9d88ec319e7551f1f91d2e8f0da))
* apply Biome formatting to resolve CI errors ([b982ecc](https://github.com/happyvertical/smrt/commit/b982ecc7d4a8b452727402bcaa193102427584e9))
* **ci:** add all SDK packages to pnpm overrides ([e8470b2](https://github.com/happyvertical/smrt/commit/e8470b2860cea293ddbdcb6a7db258720ed18fd6))
* **ci:** add checkout steps before using local action ([75669bc](https://github.com/happyvertical/smrt/commit/75669bc129e68dd14e51f37f4c9b7dd852891779))
* **ci:** add SDK packages to workspace for automatic build ([b993c55](https://github.com/happyvertical/smrt/commit/b993c55e87fdd90e94b6659c291c63a5b123372b))
* **ci:** build only SDK packages directory, exclude docs ([bb4ef09](https://github.com/happyvertical/smrt/commit/bb4ef093b97a41d3ba456a32f5fbec84bf430afd))
* **ci:** build SDK packages and add missing @have/config override ([c1c3664](https://github.com/happyvertical/smrt/commit/c1c3664c53363f03f2aecebd1749ba6a4f28b420))
* **ci:** checkout SDK repository for file: path dependencies ([b1f44d1](https://github.com/happyvertical/smrt/commit/b1f44d170ef44ec18dd8c7e5c6b713af2b1257da))
* **ci:** checkout SDK to parent directory for correct path resolution ([a314989](https://github.com/happyvertical/smrt/commit/a314989e6615d112fb893234383d2be8b1bec5a5))
* **ci:** configure biome ci to only fail on errors, not warnings ([11d4ad2](https://github.com/happyvertical/smrt/commit/11d4ad2cb1c9b348f73d06b263137a4292bf162e))
* **ci:** exclude generated static-manifest files from version control ([dbdb267](https://github.com/happyvertical/smrt/commit/dbdb267f551d78b3e0e5d6955678b29e29fedf68))
* **ci:** ignore generated static-manifest files in biome checks ([effbbfd](https://github.com/happyvertical/smrt/commit/effbbfd6b76a5c579aa0351d53c7576be4c00e0e))
* **ci:** install SDK dependencies before building ([15c3090](https://github.com/happyvertical/smrt/commit/15c309059f2b5c9265556a32137b3dc3e7030c8e))
* **ci:** remove pnpm overrides conflicting with workspace ([0847beb](https://github.com/happyvertical/smrt/commit/0847beb00f7a68f515189ff9f09ad3028736d676))
* **ci:** simplify Playwright browser installation to match SDK approach ([ae46cb3](https://github.com/happyvertical/smrt/commit/ae46cb3b5d9f312884ac7ea4f0aaa095015a223f))
* **ci:** simplify SDK build - dependencies already installed ([1ee885a](https://github.com/happyvertical/smrt/commit/1ee885abd0a0e3487962c84db9e7b37a2c99170b))
* **ci:** skip commit-msg hook in CI to allow semantic-release commits ([bcb153c](https://github.com/happyvertical/smrt/commit/bcb153cafe3a41af524badfccb644b4e073d6554))
* **ci:** skip Playwright browser install if not available ([9659a6e](https://github.com/happyvertical/smrt/commit/9659a6e6614eabee65a44098c658a3d4a8a07ca8))
* **ci:** use --no-frozen-lockfile when SDK workspace is present ([92085d8](https://github.com/happyvertical/smrt/commit/92085d80d27da48badf1f7dc068953a8866be6a1))
* **ci:** use CI-specific pnpm overrides for SDK workspace resolution ([901c415](https://github.com/happyvertical/smrt/commit/901c415bfa3f5b27c772e9cfb3c1af3d93e86f05))
* **ci:** use double quotes and positional filter for SDK build ([5977c83](https://github.com/happyvertical/smrt/commit/5977c836f2cbed6ba81cb02710941471d1e34bf9))
* **ci:** use package.json pnpm.overrides instead of .pnpmrc ([1306ad1](https://github.com/happyvertical/smrt/commit/1306ad158c33178d48b679b2fdc0c5b4c7830832))
* **ci:** use SDK as subdirectory for GitHub Actions compatibility ([d436025](https://github.com/happyvertical/smrt/commit/d436025f8d2e576e7ab3ae47874ae75bd8cf5c69))
* **codebase:** fix local build issues and update versions to SDK fork point ([481c79a](https://github.com/happyvertical/smrt/commit/481c79a911f4256433ec5f33a721aef3d94c289a))
* **config:** enable skipLibCheck for SDK workspace packages ([406d78a](https://github.com/happyvertical/smrt/commit/406d78a7addb3148ebed660ce4f3d60245752b2f)), closes [#9](https://github.com/happyvertical/smrt/issues/9)
* convert camelCase field names to snake_case in WHERE and ORDER BY clauses (closes [#17](https://github.com/happyvertical/smrt/issues/17)) ([3643645](https://github.com/happyvertical/smrt/commit/3643645c60d08afac946cbba82b48edb937d3f6c))
* **core:** add prebuild/cli export to package.json ([8d8fd44](https://github.com/happyvertical/smrt/commit/8d8fd447b3caf1bf1884659246c79bce99c19498))
* **core:** correct condition logic in setupTableFromClass ([fc8be06](https://github.com/happyvertical/smrt/commit/fc8be065312cbd6f2d5e079daa41fdf4d3e70eaa)), closes [#9](https://github.com/happyvertical/smrt/issues/9)
* **core:** fix setupTableFromClass cache check and remove duplicate index ([760cdbd](https://github.com/happyvertical/smrt/commit/760cdbd9a8e9b5c7f59cb742c41567aafe304a42))
* **core:** replace @have/types imports with @smrt/types ([485104e](https://github.com/happyvertical/smrt/commit/485104efc0cdadfa7ce229d2b3599d2367a67d84))
* **core:** resolve TypeScript build errors for CI compatibility ([b58281e](https://github.com/happyvertical/smrt/commit/b58281e5dbe3d70b4a28e0a80065f082189255e9))
* **core:** update Collection.create() type constraint for protected constructor ([069064f](https://github.com/happyvertical/smrt/commit/069064f257db8465758948a11e34052865f113b8))
* **deps:** add @have/logger dependency and workspace overrides ([9da235d](https://github.com/happyvertical/smrt/commit/9da235d69803417ea4a13185b429a541ced7fad3)), closes [#9](https://github.com/happyvertical/smrt/issues/9)
* **deps:** replace file: SDK paths with version specifiers ([9079944](https://github.com/happyvertical/smrt/commit/907994461ad3c5f953a00aa7483b001c01f09021))
* exclude protected properties from database schema (resolves [#13](https://github.com/happyvertical/smrt/issues/13)) ([57af720](https://github.com/happyvertical/smrt/commit/57af72024b717dd7b1b850387f4d37341278ec97))
* format homepage features component ([0154024](https://github.com/happyvertical/smrt/commit/0154024a1dd9e2b82b09865b67656a34cb5a6a15))
* pass sourceFile parameter to TypeScript AST getText() calls in scanner ([6da62cb](https://github.com/happyvertical/smrt/commit/6da62cbe110cb925ed8dab8ec79c9c2e821a1bd8))
* quote SQL column names in schema generation to handle reserved keywords (closes [#19](https://github.com/happyvertical/smrt/issues/19)) ([8a58ba9](https://github.com/happyvertical/smrt/commit/8a58ba962e3d909d8b35248b2e445c45a89aa80c))
* remove unsupported regex from Biome naming convention rule ([8cfc7a4](https://github.com/happyvertical/smrt/commit/8cfc7a48ecb281eaecf0d1feeb76fdf1ef1f85a3))
* replace protected constructor usage in accounts package ([f574a4a](https://github.com/happyvertical/smrt/commit/f574a4a77ab6bc7591bb8672b3b54de15a303b76)), closes [#9](https://github.com/happyvertical/smrt/issues/9)
* resolve all Biome linting violations across packages ([eaffc63](https://github.com/happyvertical/smrt/commit/eaffc6382b8a3cf35ce9811d0292743fbf50499c)), closes [#13](https://github.com/happyvertical/smrt/issues/13)
* resolve all remaining TypeScript build errors ([789ee60](https://github.com/happyvertical/smrt/commit/789ee60bd673e5c53f2267de7e5be9ecbdcf176f))
* resolve TypeScript build errors in core and accounts packages ([b4b8ff1](https://github.com/happyvertical/smrt/commit/b4b8ff1e2bfc5805e7d11168fc4f472c7d50b2df))
* resolve workspace dependency issues and update package references ([69e16f8](https://github.com/happyvertical/smrt/commit/69e16f8a21c44b9f7fa86f3febf3515af31b66a0))
* **test:** restore test files broken by lint autofix ([e3ae311](https://github.com/happyvertical/smrt/commit/e3ae311720737484ce1704a35a1bc2a9b0b77918))
* update domain packages for Phase 2 compatibility ([590a315](https://github.com/happyvertical/smrt/commit/590a3159a4ddac1c048458dfc511a06f2edc3740)), closes [#9](https://github.com/happyvertical/smrt/issues/9)


### Features

* add Docusaurus documentation site ([cdf1208](https://github.com/happyvertical/smrt/commit/cdf1208a91063b8affd42d1acdc65a2b8b1bd2e7))
* adopt SDK v0.42.0 naming conventions and style guide ([511923f](https://github.com/happyvertical/smrt/commit/511923fa130d19d8fa6ca9cd17bdfea96e7fff21))
* capture table name in decorator to survive minification (Phase 1) ([f63cb3a](https://github.com/happyvertical/smrt/commit/f63cb3a3eb886fe0bdd9ea29e25004d153a905b3)), closes [#9](https://github.com/happyvertical/smrt/issues/9) [#9](https://github.com/happyvertical/smrt/issues/9)
* **ci:** add Playwright packages to devDependencies to match SDK stack ([cea07cf](https://github.com/happyvertical/smrt/commit/cea07cff1c34acd0e3874410f9227fe4e41c6f73))
* **core:** complete Phase 2 & 4 of schema management refactor ([#9](https://github.com/happyvertical/smrt/issues/9)) ([1bf8e13](https://github.com/happyvertical/smrt/commit/1bf8e1358ad3e9863ffd05deb8a6925e55027688))
* initialize SMRT framework monorepo ([a9763cb](https://github.com/happyvertical/smrt/commit/a9763cb3f4ba3ad51bfcb1e1ccef39c70528ce80))
* migrate to [@smrt](https://github.com/smrt) namespace and remove SDK packages ([ce84f82](https://github.com/happyvertical/smrt/commit/ce84f8213f5804b831b2e035f7466e5b2ad9723c))


### BREAKING CHANGES

* - Renamed ISignalAdapter → SignalAdapter throughout codebase

Additional changes:
- Added STYLE_GUIDE.md from SDK repository
- Updated Biome config with useNamingConvention rule to enforce
  interface naming without "I" prefix
- Updated all references in source files and tests
- Regenerated dist files with updated interface names

Tests: 873 passed (4 pre-existing failures unrelated to this change)
