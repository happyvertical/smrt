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
  the release-bundled `bundled:sveltekit`; an explicit remote template is shallow-fetched, `.git` dropped,
  and its commit printed). A local template that is a git checkout contributes only tracked plus
  untracked-but-unignored files (`git ls-files -co --exclude-standard`), so git-ignored generated output
  (e.g. a stale `src/routes/api/notes`) never reaches the project; uncommitted edits still apply, which
  `git archive HEAD` would drop. A non-git directory is copied whole minus `.git`/`node_modules`.
  Whatever the source, the template repository's own metadata at its root (`.agents/`, `.github/`,
  `AGENTS.md`, `CLAUDE.md`, `renovate.json`) is not copied: it names the template's tracker, forge and CI,
  so an agent in the new project would work against the template repository (#4239). The plan lists it
  as `skippedTemplateFiles`.
  `package.json` `name` becomes the slug of `cookbook.name` when set, else of the target directory's
  basename (never the template's name: the runtime derives the app identity, hence the OS data
  directory, from it), under the template's npm scope, else `@smrt-app` (`scopedProjectName`): SMRT
  refuses to scan an unscoped project, so a template with its own models needs one (#4061).
- **Existing project**: `--into [dir]`, or re-running on a directory that already holds `smrt.cookbook.json`.
- **Writes**: missing packages (from the recipes, features and policies) into `dependencies`,
  sorted; `smrt.cookbook.json` (the validated, normalized cookbook); for a new project, the smrt pin
  below. The bundled host also prepares customization subclasses and its verified lazy snapshot during its automatic build. No sample data.
- **Versions**: the cookbook carries none (epic #3747). smrt releases in lockstep, so a **new project**
  runs this CLI's release, not the template's (#4055; the default template pinned the 0.55 line that
  GHSA-gq3p-p48q-9q54 covers): every `@happyvertical/smrt-*` registry range in the template's
  `dependencies`/`devDependencies`/`optionalDependencies`, and every package a recipe adds, is set to
  exactly the CLI's version (`cliVersion()` in `cookbook/shared.ts`). Non-smrt dependencies, peer ranges and
  protocol/path specs (`workspace:`, `link:`, `file:`, `npm:` aliases, git) are left alone. When anything
  was repinned, the template's lockfile (`pnpm-lock.yaml`, `package-lock.json`, `npm-shrinkwrap.json`,
  `yarn.lock`, `bun.lock[b]`) is dropped so neither this install nor a later frozen one restores the old
  versions; the package manager is still chosen from it. A CLI whose version is not a plain `x.y.z`
  release (a prerelease, or `0.0.0` from an unresolved dev build) keeps the template's ranges and lockfile
  and prints a warning (`warnings[]` in `--json`). The plan reports `smrtVersion`, `repinnedDependencies`
  and `removedLockfiles`.
  An **existing project** (`--into`, re-apply) is never repinned: a new dependency takes the range the
  project already uses for `@happyvertical/smrt-core`, else the CLI's version (exact for a release).
  Already-declared packages are never changed there. Removing a recipe does not remove its package.
- **Idempotent**: re-applying leaves an identical project untouched; an edited cookbook updates the
  selection and adds packages, preserving existing app models, policies and source edits.
- `--dry-run` prints the plan (no writes; a remote template is still fetched to a temp dir).
  `--no-install` skips `<pm> install` (pnpm, or npm/yarn by lockfile). `--json` prints the plan.
- **Agent docs** (#4878): after a non-dry-run apply (new or `--into`) the handler runs the
  `docs:agents` refresh at the project (after the install). Stderr only, so `--json` on stdout stays
  intact; it never fails the command. With `--no-install` nothing is installed yet: one hint, run
  `smrt docs:agents` after installing. See [`docs-agents.md`](docs-agents.md).
- Next steps printed: install if skipped, then the project's `app:setup` and `app:doctor` scripts
  (else `npx smrt app setup` / `npx smrt doctor`).

## Intake contract (smrt-start#4, app shell #3749)

`smrt.cookbook.json` at the project root is the cookbook, verbatim v1. An app reads it at
startup/setup to select recipes, apply policies and layout/theme. The bundled host is wired by apply and built automatically after install; explicit custom templates remain responsible for consuming it.

## Complete local cookbook host (D2)

The default is now `bundled:sveltekit`, shipped inside the CLI release at
`dist/templates/cookbook`. CLI build copies the canonical template and its
`template-sveltekit/cookbook-template` overlay; it never maintains a second
hand-authored base template or fetches an unpinned starter. Explicit local/git
`--template` sources retain their existing copy behavior.

The bundled host mounts `createCookbookApplication`, local owner setup and
launch-secret sign-in, Connect AI, settings, assistant, MCP, cookbook preferences,
sections and model screens. `cookbookHostVite` prepares the verified snapshot,
generates same-name customization subclasses with exclusive-create writes,
exposes the installed recipe superset and enables lazy activation. Provider API
restrictions still cap generated routes. Apply installs and builds this host;
`--no-install` explicitly defers those operations. No provider account is needed.

Recipe validation/resolution now follows manifests' `smrtDependencies`. These
model providers become direct app dependencies so the complete lazy reference
graph can resolve cross-package models. The bundled host's own provider closure
is included in its generated package.json too, derived from authored runtime
package dependencies so cold parallel builds cannot omit providers whose
manifests have not been generated yet. Registry resolution remains the
existing authenticated, integrity-checked implementation.

Reapply preserves `models` in its entirety. Existing policies win by
`(objectRef, fieldName)`; incoming policies fill only unconfigured fields.
Generated subclasses are never overwritten, including files the person edited.
`--dry-run --json` reports `plan.cookbookDiff.before` and `.after` without writes;
it also retains the package addition/pin preview. A host marked
`smrt.cookbookHost: true` rebuilds after apply so newly installed providers get
AOT routes. Custom templates without that marker keep their prior lifecycle.

`SMRT_ROOT` is the only checkout switch. The shipped pnpm hook delegates to
`@happyvertical/smrt-cli/source-checkout` (bootstrapped from the selected checkout
before dependencies exist). It links every framework package through a stable,
ignored `.smrt-local` path. The app also links the SQL SDK already installed for
checkout core, preserving SDK identity and avoiding starter-range registry lookups;
an uninstalled checkout is refused. Without the variable it returns pnpm's published
configuration unchanged. `smrt source build` forwards the app/workspace framework
closure to Turbo using the existing active-Node package-manager runner. It is a
no-op without a checkout. No machine path belongs in a committed lockfile.

`template-sveltekit/__tests__/cookbookApply.test.ts` creates a second host for each
bundled fixture with the real installer and apply-owned build, then
boots adapter-node's SvelteKit Server in process. It checks health, anonymous
denial, launch-secret rejection, owner sign-in, Customer REST/model page,
settings and rendered cookbook sections. It opens no port. The existing apply
suite covers dry-run, customization retention and idempotency; the template
subclass suite checks exclusive-create preservation and path confinement.


The workspace prepack hook builds the CLI dependency closure through Turbo, then
builds and verifies the CLI with the shared package prepack script.
The CLI bundle ships only `gitignore.template`, never a literal nested `.gitignore`
(which pnpm pack would use to drop authored API routes). The overlay copier adds
exceptions for every authored cookbook API route so generated apps track them.
The real CLI tarball regression checks both packed routes and these exceptions.
