# Track Plan: Comprehensive Audit and Unification of Manifest Generation Logic

## Phase 1: Discovery and Analysis [checkpoint: 58b4d54]
- [x] Task: Audit codebase for manifest generation logic
  - [x] Subtask: Search for `ManifestGenerator` usages and related keywords
  - [x] Subtask: Identify all locations where `manifest.json` (or similar) is written or read
  - [x] Subtask: Document the differences between CLI, test, and runtime usage
- [x] Task: Conductor - User Manual Verification 'Discovery and Analysis' (Protocol in workflow.md)

## Phase 2: Design and Prototyping [checkpoint: 6fb366c]
- [x] Task: Design unified manifest architecture
  - [x] Subtask: Define the single source of truth for manifest location
  - [x] Subtask: Design the `ManifestManager` (or similar) class interface
  - [x] Subtask: Create a migration plan for existing consumers
- [x] Task: Conductor - User Manual Verification 'Design and Prototyping' (Protocol in workflow.md)

## Phase 3: Implementation (Refactoring) [checkpoint: 67c4723]
- [x] Task: Implement unified `ManifestManager`
  - [x] Subtask: Write tests for the new manager
  - [x] Subtask: Implement the core generation and loading logic
- [x] Task: Refactor `@smrt/cli` to use `ManifestManager`
  - [x] Subtask: Remove inline generation logic
  - [x] Subtask: Switch to the new manager
- [x] Task: Refactor `@smrt/core` (runtime) to use `ManifestManager`
  - [x] Subtask: Update `SmrtApp` or equivalent bootstrapper
- [x] Task: Refactor tests to use `ManifestManager`
  - [x] Subtask: Update test helpers
- [x] Task: Conductor - User Manual Verification 'Implementation (Refactoring)' (Protocol in workflow.md)

## Phase 4: Cleanup and Verification [checkpoint: ad687d3]
- [x] Task: Remove dead code
  - [x] Subtask: Delete old generation logic
  - [x] Subtask: Remove unused dependencies related to old logic
- [x] Task: Verify feature parity
  - [x] Subtask: Run full test suite
  - [x] Subtask: Manually verify a sample app (CLI generation -> Runtime execution)
- [x] Task: Conductor - User Manual Verification 'Cleanup and Verification' (Protocol in workflow.md)
