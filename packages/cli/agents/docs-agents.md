# docs:agents in pnpm monorepos

`smrt docs:agents` (and the deprecated `docs:claude`) documents the
`@happyvertical/*` packages a consumer project installs. pnpm installs per
workspace member, so a consumer monorepo's root `node_modules` holds none of
them (#4734). Source: `src/commands/docs-workspace.ts`,
`src/commands/docs-claude.ts`.

## Monorepo roots

- **Root detection.** `resolveDocsRoot({ cwd, here })` walks up from the working
  directory to the nearest `pnpm-workspace.yaml`. That directory is the docs root
  unless its `package.json` is `@happyvertical/smrt` (the smrt repository keeps
  its cwd-relative behaviour). It is deliberately not `detectMonorepoRoot()`,
  which is the smrt repository's own detector. The command lifts only when the
  working directory is that root, a workspace member, or inside a member; a
  directory the workspace does not include stays local. When member glob
  expansion is fatal (over the package/entry budget) no member is known, so a
  member working directory stays local too.
- **Discovery.** `listConsumerWorkspaceInstallRoots(root)` (owned by
  `@happyvertical/smrt-dev-mcp/knowledge`, reusing the #2143/#2275 workspace glob
  expansion) returns the root plus every member. Each one's
  `node_modules/@happyvertical` is read via `discoverScopedPackageDirectories`;
  `collectWorkspacePackages(docsRoot)` returns the merged `packages` and
  `sdkPackages`.
- **Output.** `.agents/smrt-framework.md` (a default output; `--output` stays
  relative to the working directory), `.agents/smrt-knowledge/`, and the skills
  under `.claude/skills` / `.agents/skills` are all written at the docs root; the
  skill's bundle path is relative to it. The chosen root is printed (stderr under
  `--dry-run`).
- **`--here`.** Skips workspace resolution: the working directory alone, exactly
  as before. Outside any workspace nothing changes.

## Version skew

Identical name+version across members is one entry. A package at several
versions is listed once; the table cell reads `1.2.0 (apps/a), 1.3.0 (apps/b)`
(ascending semver, sorted member paths, `.` for the root). The highest version's
AGENTS.md and knowledge page are exported. In `bundle.json` that package's entry
keeps `version` (the highest, equal to the page's `package_version`) and gains
`versions` (all, ascending); the field is absent without skew, so single-version
bundles are byte-identical to before. `checkOkfBundleFreshness` takes
`installRoots` (the dev-mcp knowledge check passes the same list) and compares
the page against the highest installed version.

## Managed AGENTS.md block (#4878)

After the bundle and skills, `docs:agents` maintains one section in the docs
root's `AGENTS.md` (`src/commands/docs-agents-block.ts`), delimited by
`<!-- smrt:agents:begin -->` / `<!-- smrt:agents:end -->`. AGENTS.md is the
user's file, so:

- **Only the marked text changes.** Everything outside survives byte for byte:
  BOM, LF or CRLF (the dominant ending is used for the block), a missing final
  newline. Hand edits between the markers are replaced, by design.
- **Placement.** Directly after the first H1 (ATX or one-line setext, outside
  code fences and frontmatter); with no H1, at the top, after a leading YAML
  frontmatter block and BOM.
- **Refusal.** A begin without an end, an end without a begin, an end before the
  begin, or more than one of either: nothing is written and a warning is
  printed; the exit status is unchanged. Only a marker alone on its own line and
  outside a fenced code block is structural; one mentioned inline in prose or
  shown inside a fence is ignored (an unclosed fence runs to the end of the
  file), so text between such look-alikes is never overwritten. Markers
  indented four or more spaces (or by a tab) are indented code, not structure.
- **Idempotent.** An unchanged result is not written (mtime stable).
- **Content** (at most 15 lines, harness-neutral): the installed
  `@happyvertical/smrt-cli` (else `smrt-core`) version, the relative paths of
  the framework reference and `<bundle>/intents/index.md` (omitted with a note
  when no intents were exported), the framework-first rule, `smrt docs:agents`,
  and `smrt-dev-mcp review --directory . --format summary`. Paths are relative
  to AGENTS.md's directory, forward slashes.
- **Files.** A missing AGENTS.md is created (`# <root package name>` + block);
  `CLAUDE.md` containing `@AGENTS.md` is created only beside a freshly created
  AGENTS.md and only when absent. An existing CLAUDE.md without an `@AGENTS.md`
  import (a symlink to AGENTS.md counts as importing) gets a warning and is
  never edited. Writes use `containedPath`/`assertNotSymlink`; a symlinked
  AGENTS.md is refused.
- **Options.** `--no-agents-block` skips it; `--dry-run` reports on stderr
  (stdout carries the framework document) and writes nothing.
- **Reuse.** Exports: `renderAgentsBlock`, `mergeAgentsBlock`,
  `applyAgentsBlock`, `checkAgentsBlock(root)` (`present | missing | refused`,
  for `smrt doctor`) and the marker constants.

## Freshness in the app lifecycle (#4878)

`refreshAgentDocs(options)` (`src/commands/docs-refresh.ts`) is the whole of the
`docs:agents` handler as a function: it returns `{ status, root, warnings,
failure? }` with `status` one of `written | skipped-fresh | skipped-disabled |
skipped-nothing-installed | failed` and never calls `process.exit`. The command
maps `skipped-nothing-installed` and `failed` (stale cross-package graph) to its
historical `exit(1)`. `mode: 'write'` always writes; `mode: 'if-stale'` writes
only when the bundle is missing or `bundle.json` no longer matches the installed
versions (`checkOkfBundleFreshness`, with the docs root's `installRoots`; age
alone is not staleness). `safeRefreshAgentDocs` catches everything and reports a
`failed` result plus one `log.err` line. `inspectAgentDocs(cwd)` is read-only:
`{ root, installed, bundle: missing|stale|fresh, block: present|missing|refused,
skills: [{ name, dir, present }] }`.

`src/app/agent-docs.ts` wires it into `smrt app`. Agent docs never fail or delay
an operation, never touch stdout or an exit status, and report as plain text
lines on stderr (not the JSON error envelope):

- `install`: `write` mode, after the local-operation check and before the lock.
- `dev`: `if-stale` mode before Vite starts. Skipped when `CI` is any value except
  empty, `0` or `false`, or when `SMRT_AGENT_DOCS=off`.
- `build`: never writes. One warning line (naming `smrt docs:agents`) when the
  bundle is missing or stale; silent under `SMRT_AGENT_DOCS=off`.
- Where no `@happyvertical/smrt*` package is installed (same root resolution as
  `docs:agents`) all of this is skipped quietly.
- `smrt doctor` "Agent knowledge" (`src/commands/doctor-agent-knowledge.ts`):
  warnings, never issues, for a missing or stale bundle, a missing or unusable
  AGENTS.md block, and a missing `smrt-catalog` skill under `.claude/skills` and
  `.agents/skills` (each its own warning). `SMRT_AGENT_DOCS=off` does not silence it.
- Test seams: `dependencies.agentDocs` (`refresh`, `inspect`, `env`) and
  `dependencies.launchVite` on `runAppCommand`.

## Scaffolds and templates (#4878)

Both starter templates (`template-sveltekit`, `template-site-static-json`) ship
`template/AGENTS.md` with the block directly after the H1, rendered without a
version (a template cannot know it; the first `smrt docs:agents` fills it in),
and a `docs:agents` script. `scaffold-agent-docs.test.ts` fails when a template's
block drifts from `renderAgentsBlock`. `smrt cookbook apply` (not `--dry-run`)
and `smrt init` call `refreshScaffoldedProject(dir)`
(`src/commands/scaffold-agent-docs.ts`) from their handlers: `write` mode via
`safeRefreshAgentDocs`, all messages on stderr, never a failure or exit change.
With nothing installed yet it prints one hint to run `smrt docs:agents` after
installing. Test seam: `scaffoldAgentDocs.refresh`.
