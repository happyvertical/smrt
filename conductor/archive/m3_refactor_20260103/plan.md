# Plan: Material 3 Refactor for smrt-svelte

This plan covers the refactoring of the `smrt-svelte` library to Material 3 specifications, including a new theme system and foundational interaction logic.

## Phase 1: Foundation & Theme System [checkpoint: 35f9be1]
Goal: Establish the core color generation logic and the `ThemeProvider` to distribute tokens.

- [x] Task: Implement M3 internal color generation logic (seed to palette) <!-- id: ad73d82 -->
- [x] Task: Create `ThemeProvider` component and context <!-- id: 8abc765 -->
- [x] Task: Define and inject M3 Typography and Elevation CSS tokens <!-- id: 8abc765 -->
- [x] Task: Conductor - User Manual Verification 'Phase 1: Foundation & Theme System' (Protocol in workflow.md) <!-- id: 35f9be1 -->

## Phase 2: Core Interaction & Infrastructure [checkpoint: be25781]
Goal: Implement the ripple effect and icon system required for M3 components.

- [x] Task: Implement JS-based `ripple` Svelte action <!-- id: be25781 -->
- [x] Task: Create `SMRTIcon` component for SVG-based icons <!-- id: be25781 -->
- [x] Task: Conductor - User Manual Verification 'Phase 2: Core Interaction & Infrastructure' (Protocol in workflow.md) <!-- id: be25781 -->

## Phase 3: Form Component Refactoring (TDD) [checkpoint: c3da662]
Goal: Redesign form inputs to M3 "Filled" or "Outlined" variants.

- [~] Task: Refactor `SMRTTextInput` (Write Tests -> Implement)
- [x] Task: Refactor `SMRTCheckbox` (Write Tests -> Implement) <!-- id: c3da662 -->
- [x] Task: Refactor `SMRTSelect` (Write Tests -> Implement) <!-- id: c3da662 -->
- [x] Task: Refactor `SMRTTextarea` (Write Tests -> Implement) <!-- id: c3da662 -->
- [x] Task: Conductor - User Manual Verification 'Phase 3: Form Component Refactoring' (Protocol in workflow.md) <!-- id: c3da662 -->

## Phase 4: Layout ## Phase 4: Layout & Display Refactoring (TDD) Display Refactoring (TDD) [checkpoint: 9d1afd5]
Goal: Redesign cards, headers, and state displays.

- [~] Task: Refactor `SummaryCard` (Write Tests -> Implement)
- [x] Task: Refactor `PageHeader` (Write Tests -> Implement) <!-- id: 9d1afd5 -->
- [x] Task: Refactor `EmptyState` (Write Tests -> Implement) <!-- id: 9d1afd5 -->
- [x] Task: Conductor - User Manual Verification 'Phase 4: Layout - [ ] Task: Conductor - User Manual Verification 'Phase 4: Layout & Display Refactoring' (Protocol in workflow.md) Display Refactoring' (Protocol in workflow.md) <!-- id: 9d1afd5 -->

## Phase 5: Finalization ## Phase 5: Finalization & Polish Polish [checkpoint: 61fe4e7]
Goal: Refactor remaining components and ensure overall library cohesion.

- [x] Task: Refactor remaining components in `src/components/nav`, `feedback`, etc. <!-- id: 61fe4e7 -->
- [x] Task: Audit all components for accessibility (A11y) and responsive behavior <!-- id: 61fe4e7 -->
- [x] Task: Final library-wide verification and documentation update <!-- id: 61fe4e7 -->
- [x] Task: Conductor - User Manual Verification 'Phase 5: Finalization - [ ] Task: Conductor - User Manual Verification 'Phase 5: Finalization & Polish' (Protocol in workflow.md) Polish' (Protocol in workflow.md) <!-- id: 61fe4e7 -->
