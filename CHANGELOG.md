## [1.3.1](https://github.com/happyvertical/smrt/compare/v1.3.0...v1.3.1) (2025-10-29)


### Bug Fixes

* **core:** replace SQLite-specific INSERT OR REPLACE with portable upsert ([#100](https://github.com/happyvertical/smrt/issues/100)) ([e37b706](https://github.com/happyvertical/smrt/commit/e37b706bb4c840ca1d9f76362490a32d924f6292)), closes [#99](https://github.com/happyvertical/smrt/issues/99)

# [1.3.0](https://github.com/happyvertical/smrt/compare/v1.2.4...v1.3.0) (2025-10-28)


### Bug Fixes

* **cli:** prevent spinner crash in non-TTY environments ([#81](https://github.com/happyvertical/smrt/issues/81)) ([f19ab7b](https://github.com/happyvertical/smrt/commit/f19ab7bf31ae6ac74269908e727209c5433c8e0b)), closes [#80](https://github.com/happyvertical/smrt/issues/80)
* **core:** add fallback chain for slug generation ([#94](https://github.com/happyvertical/smrt/issues/94)) ([490cea3](https://github.com/happyvertical/smrt/commit/490cea39de178ce37db035f003a1abe60dfc1dcd))
* **core:** add schema/utils export to package.json ([4df0dc4](https://github.com/happyvertical/smrt/commit/4df0dc4f1ac05ffb3b09576acb8b0663e74eb01f))
* **core:** always use plural collection names in virtual modules ([a84cc49](https://github.com/happyvertical/smrt/commit/a84cc490bb5dcbe5dd6cdec7f634df15d92cbbf0)), closes [#66](https://github.com/happyvertical/smrt/issues/66)
* **core:** DuckDB schema transformation and connection sharing ([#91](https://github.com/happyvertical/smrt/issues/91)) ([d2877fe](https://github.com/happyvertical/smrt/commit/d2877fe92229db9fd3fd93a94bd0bfb30380192b)), closes [#89](https://github.com/happyvertical/smrt/issues/89)
* **core:** exclude base class properties from schema to prevent circular serialization ([#76](https://github.com/happyvertical/smrt/issues/76)) ([54389ad](https://github.com/happyvertical/smrt/commit/54389adc1ddcf3d9edea917f67528825fa418de6)), closes [#75](https://github.com/happyvertical/smrt/issues/75)
* **core:** generate and export manifest files during package builds ([89b66f7](https://github.com/happyvertical/smrt/commit/89b66f714c83a527c0a7593bbaeb4d3358a7b1ae)), closes [#65](https://github.com/happyvertical/smrt/issues/65) [#65](https://github.com/happyvertical/smrt/issues/65)
* **core:** handle readonly properties in loadDataFromDb ([ed4940f](https://github.com/happyvertical/smrt/commit/ed4940fc9968f263843f56a3e1718b4c7207124b)), closes [#62](https://github.com/happyvertical/smrt/issues/62) [#61](https://github.com/happyvertical/smrt/issues/61)
* **core:** handle readonly properties in object initialization ([72e6e01](https://github.com/happyvertical/smrt/commit/72e6e01cf409e3aecacc96cfc3b812d7d47e347f))
* **core:** prevent node:crypto from bundling in federation builds ([80bfdda](https://github.com/happyvertical/smrt/commit/80bfddab9c389fd50293a513a4412c6758d19564)), closes [#58](https://github.com/happyvertical/smrt/issues/58)
* **core:** simplify system tables initialization tracking ([#77](https://github.com/happyvertical/smrt/issues/77)) ([1900d31](https://github.com/happyvertical/smrt/commit/1900d31f61a99764ade4a736d849fef98126b581)), closes [#308](https://github.com/happyvertical/smrt/issues/308) [#309](https://github.com/happyvertical/smrt/issues/309) [#310](https://github.com/happyvertical/smrt/issues/310) [#35](https://github.com/happyvertical/smrt/issues/35) [#35](https://github.com/happyvertical/smrt/issues/35) [#35](https://github.com/happyvertical/smrt/issues/35)
* **core:** use schema-based detection for inherited Date fields ([#88](https://github.com/happyvertical/smrt/issues/88)) ([9098346](https://github.com/happyvertical/smrt/commit/90983461336b6d99448498dbc15b96458f4c9cc1)), closes [#87](https://github.com/happyvertical/smrt/issues/87)
* enable rollupTypes to preserve type-only exports in builds ([44ea125](https://github.com/happyvertical/smrt/commit/44ea12543c732d01438a0a373d8e57c4223faa3b)), closes [#56](https://github.com/happyvertical/smrt/issues/56)
* **github-actions:** correct package name in triage workflow ([751dbbf](https://github.com/happyvertical/smrt/commit/751dbbf35582fce36dafc5af5e85934587647b30)), closes [#70](https://github.com/happyvertical/smrt/issues/70)
* **places:** add explicit name field to PlaceType model ([bfca923](https://github.com/happyvertical/smrt/commit/bfca923767d4a8151b7e4929581fe8cde1311c11)), closes [#57](https://github.com/happyvertical/smrt/issues/57)
* **places:** update PlaceType test to use async generateSchema from schema/utils ([3f3c35a](https://github.com/happyvertical/smrt/commit/3f3c35a3aaf5cf92bff540be3de8a64f940cb377))
* **svelte:** resolve SSR errors in layout and weather components ([#95](https://github.com/happyvertical/smrt/issues/95)) ([b0c02a1](https://github.com/happyvertical/smrt/commit/b0c02a1f42888502cad116cdd39c762f4313bec5))
* **vite-plugin:** correct virtual module type generation ([fc054d1](https://github.com/happyvertical/smrt/commit/fc054d1b9b755ab3f3dc64d22424fcb982bc4de7)), closes [#66](https://github.com/happyvertical/smrt/issues/66)
* **vite-plugin:** restore backward-compatible API signatures ([#74](https://github.com/happyvertical/smrt/issues/74)) ([922f8c5](https://github.com/happyvertical/smrt/commit/922f8c5a71d9a6d71991eb748237d6af4b36d090)), closes [#67](https://github.com/happyvertical/smrt/issues/67)


### Features

* add SMRT MCP server for intelligent documentation queries ([#84](https://github.com/happyvertical/smrt/issues/84)) ([f136a34](https://github.com/happyvertical/smrt/commit/f136a34628ba17a63067e8432dcced881e5e9d1a)), closes [#83](https://github.com/happyvertical/smrt/issues/83)
* **generators:** Three-tier MCP architecture with static generation ([#86](https://github.com/happyvertical/smrt/issues/86)) ([9601e8b](https://github.com/happyvertical/smrt/commit/9601e8b9a3db8d29e96375605400f970598856bd)), closes [#85](https://github.com/happyvertical/smrt/issues/85) [#85](https://github.com/happyvertical/smrt/issues/85) [#85](https://github.com/happyvertical/smrt/issues/85) [#85](https://github.com/happyvertical/smrt/issues/85)
* **infra:** migrate to Turborepo with GitHub Actions caching ([#97](https://github.com/happyvertical/smrt/issues/97)) ([88cd9b2](https://github.com/happyvertical/smrt/commit/88cd9b23ac13d67c384779e0941cad22f6e57225)), closes [#96](https://github.com/happyvertical/smrt/issues/96) [#96](https://github.com/happyvertical/smrt/issues/96) [#96](https://github.com/happyvertical/smrt/issues/96) [#96](https://github.com/happyvertical/smrt/issues/96) [#96](https://github.com/happyvertical/smrt/issues/96) [#96](https://github.com/happyvertical/smrt/issues/96) [#96](https://github.com/happyvertical/smrt/issues/96) [#96](https://github.com/happyvertical/smrt/issues/96)
* **svelte:** add Svelte 5 component library ([#93](https://github.com/happyvertical/smrt/issues/93)) ([669a7b5](https://github.com/happyvertical/smrt/commit/669a7b5463ea1f66c292d3c63722b6d8341cb466))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**Note**: This project intentionally uses 0.x.x versioning to indicate pre-1.0 maturity. Version 1.0.0 will be released when the API is considered stable and production-ready.

## [0.4.0] - 2025-10-22

### Changed

- **Version Reset**: Reset version from 1.2.4 back to 0.4.0 to accurately reflect pre-1.0 maturity status
- Removed all 1.x.x releases and tags from Git history
- Updated semantic-release configuration to maintain 0.x.x versioning until API stability

### Context

The framework was inadvertently bumped to 1.x.x versions through automated releases. Since the framework is still in active development with potential breaking changes, we've reset to 0.x.x versioning. This better reflects the current state of the project and follows semantic versioning conventions for pre-release software.

All functionality from versions 1.0.0 through 1.2.4 has been preserved - only the version number has changed to align with project maturity.

### Recent Features (preserved from 1.x releases)

- Fixed schema inheritance, browser exports, aliasing, and exports in core and profiles packages
- Resolved TypeScript type errors across multiple packages
- Improved documentation build process and deployment workflow
- Enhanced CI/CD pipeline reliability
- Fixed conditional exports in Vite configuration
- Updated package naming to @happyvertical/* namespace
- Configured GitHub Packages publishing
- Added workflow SOPs and code review automation
- Implemented comprehensive testing standards

---

*For version history prior to the reset, see Git commit history before tag v0.4.0.*
