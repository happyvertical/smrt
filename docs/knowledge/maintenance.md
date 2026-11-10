---
type: Playbook
title: "Knowledge maintenance and evidence policy"
description: "How the s-m-r-t knowledge bundle is generated, checked and refreshed, and how evidence labels and exports are governed."
tags:
  - knowledge
  - maintenance
status: draft
generated:
  by: claude/smrt-4688
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
sources:
  - id: okf
    resource: https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/ad30107c31c06aec8a7d5636e0d1058118604e6f/SPEC.md
    title: "OKF v0.2 specification"
  - id: generator
    resource: https://github.com/happyvertical/smrt/blob/main/scripts/knowledge-okf.ts
    path: scripts/knowledge-okf.ts
    title: "Generator library: page format, source_revision, evidence levels, bundle check"
  - id: import
    resource: https://github.com/happyvertical/happyvertical.com/blob/4da258f6ebd103338e7d0055e98fe2da100a256c/docs/knowledge/ecosystem/maintenance.md
    path: docs/knowledge/ecosystem/maintenance.md
    source_revision: 4da258f6ebd103338e7d0055e98fe2da100a256c
    title: "Imported from happyvertical.com docs/knowledge/ecosystem/maintenance.md (commit 4da258f6eb); the refresh workflow is rewritten for the generated bundle"
---

# Format

This bundle targets Open Knowledge Format v0.2: Markdown concepts with YAML frontmatter, path-based concept IDs, indexes for discovery, and sources for provenance.[^okf]

The bundle root is `docs/knowledge/`. A concept ID is the path from the root with a leading slash, such as `/components/smrt-jobs.md`, and cross-page links use that absolute ID. Only `type` is universally required by OKF. This bundle additionally records titles, descriptions, lifecycle, generation, freshness and internal audience as a local authoring convention. `audience`, `evidence_level`, `package_version` (stamped on hand-authored pages and, at export time, on exported component pages; never on in-repo generated pages, because a version changes on every release), `source_revision`, `stale_after` and `previous_ids` are local extensions, not standardized OKF fields.

# Page kinds

| Kind | Location | Written by | Freshness |
| --- | --- | --- | --- |
| Components | `/components/<name>.md`, `<name>` is the unscoped package name | `pnpm knowledge:okf` | pinned by `source_revision` |
| Generated indexes | `/index.md`, `/components/index.md` | `pnpm knowledge:okf` | regenerated with the pages |
| Intents | `/intents/*.md` | humans and agents | `stale_after` |
| Solutions, capability map | `/solutions/*.md` | humans and agents | `stale_after` |
| This page | `/maintenance.md` | humans and agents | `stale_after` |

Never edit a generated page by hand: `knowledge:check` compares each one with the generator's output and fails on any difference.

# Evidence labels

- **Founder direction:** an attributed intention or positioning decision. Human-only.
- **Manifest-described:** package metadata establishes identity and advertised purpose; implementation not individually validated. The generator emits this when a page has only manifest facts.
- **Source-inspected:** named exports or implementation substantiate the specific capability; not a runtime acceptance test. The generator emits this when the scanner derived models, MCP tools or agent-surface entries from source for the package.
- **Release-verified:** requires a named published version and a checked registry or release artifact. A version in a manifest is insufficient. Human-only.
- **Deployment-verified:** requires a named deployment and dated operational evidence. Human-only.
- **Proposed composition:** an inference about components that could be assembled; not a delivered product. Human-only; used by the solution recipes.

The generator can only ever emit `manifest-described` or `source-inspected`. The other four labels record human decisions and must never appear on a generated page. Do not infer one level from another. Documents remain `draft` until reviewed. Do not add human verification for agent-authored text. `verified` records an actual confirmation event; document lifecycle and product maturity are separate.

# Refresh workflow

Generated component pages, their indexes and the root index are refreshed by tooling, not by hand.

1. Build first (`pnpm build`). The generator reads the built knowledge artifacts, so run it only after a full `pnpm build` (which ends with `knowledge:graph`); a partial build produces different pages.
2. Run `pnpm knowledge:okf` to regenerate `/components/*.md`, `/components/index.md` and `/index.md`. It adds pages for new workspace packages and removes pages for packages that no longer exist. It never touches `intents/`, `solutions/` or other hand-authored pages.
3. Read the diff. Each page carries `source_revision: sha256:...`, a content pin over the package manifest facts, the package `AGENTS.md` and linked `agents/*.md` module docs, the scanner-derived models, MCP tools and agent-surface entries, and the generator format version. A pin moves only when something the page renders changes, so a moving `HEAD` alone changes nothing. `generated.at` is rewritten only when the pin moves.
4. Run `pnpm knowledge:check --strict --format markdown`. It fails when a generated page is missing, stale (pin mismatch), hand-edited or without a workspace package, when a generated index is out of date, when any page has unparseable frontmatter or an empty `type`, and when any absolute link in a hand-authored page does not resolve to a page in the bundle.
5. Commit the regenerated pages with the change that caused them.

To correct a generated page's content, fix its source: the package `AGENTS.md`, the package manifest, or the scanner and generator. Package behaviour that is not derivable from source or the manifest belongs in that package's `AGENTS.md`, from which the page is generated.

# Hand-authored pages

Intents, solutions and this page are written by people and agents and are not covered by the pin.

- Keep OKF frontmatter, `status: draft` until reviewed, and an `audience`.
- Set `stale_after` to a deliberate next review deadline (90 days is the default horizon at authoring time). It is a backstop, not a promise of stability, and `knowledge:check` does not yet enforce it: review the date when you touch the page, and do not roll it forward without re-inspecting the sources.
- Record `sources` with the repository path and the commit inspected (`path`, `source_revision`). Use committed source, excluding unrelated working-tree edits.
- Link components by generated ID (`/components/<name>.md`). A page that names a package that does not exist fails the check.
- When a concept ID changes, list the old one in `previous_ids` so external references can be redirected, and keep a replacement link rather than deleting the old page silently.
- Update `generated.at` after meaningful edits. Review factual claims and mark only the verified scope.

# Scope and limits

This is a bounded snapshot of the packages in this workspace. Package manifests can include tooling and private packages; neither is silently treated as a client feature. SDK components, consumer applications, commercial material, deployment guidance and ecosystem references are documented in the happyvertical.com bundle, not here. No production probes, offline acceptance runs, or customer outcome measurements are implied.

# Public export

The bundle is internal (`audience: internal`). A consumer-facing export needs an explicit allowlist of pages and a content review; metadata alone cannot prevent disclosure. Runtime loading, search tools and Happy evaluation are separate implementation work.

[^okf]: Open Knowledge Format specification at the pinned source revision.
