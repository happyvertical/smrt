# SMRT Framework

SMRT is a framework for building vertical AI applications from shared domain models, generated interfaces, and reusable application surfaces. This glossary records project-specific language that should stay stable across packages and consumer apps.

## Language

**Admin Shell**:
A reusable outer chrome contract for SMRT admin web apps.
_Avoid_: WASD shell, app wrapper

**Workspace Primitive**:
A generic, domain-agnostic building block for composing admin workspaces.
_Avoid_: app-specific shell, product shell

**First-Generation Workspace Family**:
The existing workspace components that predate AdminShell, including WorkspaceShell, RoleShell, NavTree, Breadcrumbs, and ToolsDock.
_Avoid_: current shell, old shell

**SMRT-Fed Shell Content**:
Optional shell content sourced from SMRT manifests, runtime status, or app-provided endpoints.
_Avoid_: built-in domain coupling, hardcoded framework panel

**Hidden Edge**:
A shell edge omitted by app configuration.
_Avoid_: user-collapsed edge, closed panel

**Panel Coordination Policy**:
The app-level rule that decides whether expanded shell panels can remain open together.
_Avoid_: hardcoded mutual exclusion, drawer rule

**Exclusivity Group**:
A named set of shell edges where expanding one member closes the other expanded members.
_Avoid_: global drawer lock, vertical-only lock

**Panel Presentation**:
The app-level choice of whether an expanded edge pushes body layout or overlays it.
_Avoid_: user layout preference, drawer mode

**Shell Settings Delta**:
The persisted subset of shell preferences explicitly changed by a user.
_Avoid_: resolved settings snapshot, persisted app defaults

**Physical Hotkey**:
A keyboard shortcut stored as a `KeyboardEvent.code` physical key position.
_Avoid_: character hotkey, localized key label

**Focus Tool**:
A tool contributed to the Focus edge for the active route, selection, or record.
_Avoid_: inspector tab, dock item

**Tool Identity**:
The stable identifier and optional subject metadata used to address a Focus Tool.
_Avoid_: component name, label lookup

**Shell Activity**:
A client-side representation of background work owned by a shell scope.
_Avoid_: server job, SSE event

**System Panel**:
An operational shell panel backed by app-provided runtime data such as jobs, schedules, dispatch, or connection status.
_Avoid_: activity list, server job mirror

**Activity Toasts**:
Optional notifications rendered from shell activity lifecycle events.
_Avoid_: mandatory registry behavior, built-in job alerts

**Responsive Shell Presentation**:
The small-screen rendering of the same Admin Shell state model as sheets and drawers.
_Avoid_: mobile shell, separate phone shell

## Relationships

- The `@happyvertical/smrt-svelte/workspace` public surface exports the **Admin Shell** family.
- An **Admin Shell** may reuse **Workspace Primitives**, but it is not merely a wrapper around them.
- The **First-Generation Workspace Family** is a migration source for **Admin Shell**, not a constraint on the new shell contract.
- **SMRT-Fed Shell Content** may appear inside an **Admin Shell**, but it is not owned by the shell's core contract.
- A **Hidden Edge** does not participate in normal user panel preference persistence.
- A **Panel Coordination Policy** applies to configured shell edges and can allow independent panels or enforce mutual exclusion.
- An **Exclusivity Group** is the concrete form of a **Panel Coordination Policy**.
- **Panel Presentation** is configured by the app, not persisted as a user setting.
- A **Shell Settings Delta** is resolved against framework and app defaults at runtime.
- Shell hotkeys use **Physical Hotkeys** by default.
- A **Focus Tool** may be registered imperatively or declaratively, with declarative Svelte registration preferred for app UI.
- A **Tool Identity** is stable within a shell instance and may include route or record subject metadata.
- A **Shell Activity** may be mirrored from server jobs or live update streams, but it is not itself a transport protocol.
- A **System Panel** can mirror selected runtime items into **Shell Activities**, but the concepts are distinct.
- **Activity Toasts** subscribe to **Shell Activity** events; they are not required for the activity registry to work.
- **Responsive Shell Presentation** is part of the **Admin Shell**, not a separate shell implementation.

## Example dialogue

> **Dev:** "Should the **Admin Shell** read jobs and tenant permissions directly?"
> **Domain expert:** "No. Those are **SMRT-Fed Shell Content** concerns; the shell owns the reusable chrome contract and consumers wire their own data."

> **Dev:** "Can the **Admin Shell** be forced through the **First-Generation Workspace Family** APIs for compatibility?"
> **Domain expert:** "No. Those components are migration sources; the new shell should improve or replace their patterns where needed."

## Flagged ambiguities

- "WASD shell" is an informal nickname for the **Admin Shell**, not the canonical project term.
- Existing workspace-shell docs describe `AdminShell` as a deferred wrapper, but the resolved term means a separate admin chrome contract that can reuse primitives without being constrained by their layout.
- "current shell" means the **First-Generation Workspace Family** unless a narrower component is named.
- "hidden" means a **Hidden Edge** configured out of the shell, not a user-collapsed panel.
- "mutually exclusive drawers" is an optional **Panel Coordination Policy**, not the default shell state model.
