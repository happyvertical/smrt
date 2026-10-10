# `smrt cookbook validate|apply` (#3748)

Code: `src/commands/cookbook.ts` (registration), `src/commands/cookbook/`
(`recipe-index.ts`, `validate.ts`, `apply.ts`). Contract of the document:
[`core/agents/cookbook.md`](../../core/agents/cookbook.md).

## Recipe index

Recipes and the objects policies point at come from each package's published
manifest (`recipes[]`, `objects`), found through its `package.json`
`exports['./manifest']` (`dist/lib/manifest.json` for SvelteKit-library packages such as
products), falling back to `dist/manifest.json`, `dist/lib/manifest.json`, `manifest.json`. Read in order:

1. `--manifests <file|dir>` (repeatable): a manifest, a dir of manifests, or a dir of package dirs.
2. The SMRT workspace around the target (`packages/*`).
3. `node_modules/@happyvertical/smrt-*` walking up from the target.
4. The package's registry, resolved as npm does (`@scope:registry` from the `.npmrc` chain or `npm config`,
   then `npm_config_registry`, then npmjs; an `_authToken` for that host is sent). `@happyvertical` resolves to
   npm.happyvertical.com, since npmjs lags. Only for
   packages still unresolved: `@happyvertical/smrt-<recipe-id prefix>` and the
   packages named by `features`/`policies`. The tarball is fetched and only
   the manifest is extracted; nothing is installed. `--no-registry` skips it.
   A cookbook cannot choose what is fetched: only names matching
   `@happyvertical/smrt-<name>` are looked up (a package of another scope must
   already be installed locally), the fetched manifest must name the package that
   was asked for, the registry version must be a plain semver, the token is sent
   only to the registry's own origin (a foreign tarball host gets none; foreign
   plain-http is refused), `dist.integrity` is verified when given, and a tarball
   is capped at 300 MB (a cookbook URL at 2 MB).

`validate` fails (exit 1, `--json` for machines) on: structural errors (core's
`validateCookbook`), unknown recipe ids, a `requires` id missing from the
cookbook, a `requiresAny` group with none present, a `features`/`policies`
object that is not in its package's manifest, or a policy field the object lacks.

## `apply <file|url> [dir]`

- **New project** (default): `[dir]` (or the slug of `cookbook.name`) must be absent or empty. The template is
  copied (`--template <path|github:owner/repo[#ref]|git URL>`, default
  `github:happyvertical/smrt-start`, unpinned; a remote template is shallow-fetched, `.git` dropped,
  and its commit printed). A local template that is a git checkout contributes only tracked plus
  untracked-but-unignored files (`git ls-files -co --exclude-standard`), so git-ignored generated output
  (e.g. a stale `src/routes/api/notes`) never reaches the project; uncommitted edits still apply, which
  `git archive HEAD` would drop. A non-git directory is copied whole minus `.git`/`node_modules`.
  `package.json` `name` becomes the slug of `cookbook.name` when set, else of the target directory's
  basename (never the template's name: the runtime derives the app identity, hence the OS data
  directory, from it).
- **Existing project**: `--into [dir]`, or re-running on a directory that already holds `smrt.cookbook.json`.
- **Writes**: missing packages (from the recipes, features and policies) into `dependencies`,
  sorted; `smrt.cookbook.json` (the validated, normalized cookbook). Nothing else. No sample data.
- **Versions**: the cookbook carries none (epic #3747). A new dependency takes the range the project already
  uses for `@happyvertical/smrt-core` (smrt packages release as one group), else `^<this CLI's version>`.
  Already-declared packages are never changed. Removing a recipe does not remove its package.
- **Idempotent**: re-applying leaves an identical project untouched; an edited cookbook updates the
  config file and adds packages without rewriting anything else.
- `--dry-run` prints the plan (no writes; a remote template is still fetched to a temp dir).
  `--no-install` skips `<pm> install` (pnpm, or npm/yarn by lockfile). `--json` prints the plan.
- Next steps printed: install if skipped, then the project's `app:setup` and `app:doctor` scripts
  (else `npx smrt app setup` / `npx smrt doctor`).

## Intake contract (smrt-start#4, app shell #3749)

`smrt.cookbook.json` at the project root is the cookbook, verbatim v1. An app reads it at
startup/setup to select recipes, apply policies and layout/theme. The CLI only places
dependencies and the file; the project is responsible for acting on it.
