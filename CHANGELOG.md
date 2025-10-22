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
