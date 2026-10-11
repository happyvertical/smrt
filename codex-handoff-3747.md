# Handoff to Codex: epic happyvertical/smrt#3747 (planner everywhere / Kitchen)

From Claude Code session 204aeaf1 (coordinator), 2026-10-11. **Re-read #3747 (body and comments, including the reconciliation comment 6102205555) before acting.** Other sessions edit it, and the body changes don't show up as comments.

## Shipped
| Repo | PR | What |
|---|---|---|
| smrt | #3764 → v0.55.11 | Cookbook v1 contract (`@happyvertical/smrt-core/cookbook`, `v1.schema.json`), `smrt cookbook validate/apply` (closes #3748), cookbook app shell `@happyvertical/smrt-svelte/cookbook` (closes #3749), package-model REST hosting for cookbook apps (objectsDir + STI per-class routes, fail-closed api inheritance), standalone `smrt kitchen` (Refs #3750), `@happyvertical/smrt-ui/themes/presets` |
| smrt | #3765 → v0.55.11 | Headless engine `@happyvertical/smrt-core/cookbook/engine` (closes #3753), `smrt kitchen mcp` + `plugins/smrt-kitchen` local plugin + `.agents/plugins/marketplace.json` / `.claude-plugin/marketplace.json` (Refs #3752) |
| smrt | #3771 (unreleased) | Hosted STI subclass routes authorize with the base's permission slugs (closes #3770) |
| smrt | #3772 (unreleased) | Kitchen token moves to the URL fragment `#kitchen=<token>`; it's no longer in `planner.config.json` |
| smrt-planner | #24 | Adapter over the smrt engine, presets, token fragment, `@happyvertical/smrt-planner` packaging (still `"private": true`); closes #22. #23 stays open (needs sdk#1393/#1394) |
| smrt-start | #5 | Cookbook intake, optional Notes, preferences, package-model entry pages; closes #4 |

## Open, in order
1. **Release smrt 0.55.12** (#3771 + #3772). The daily Batched Release runs at 07:17 UTC. Before dispatching manually, check whether a run already exists (`gh run list --workflow "Batched Release"`). A run fails on purpose if the merge queue isn't idle. That's benign; re-dispatch after the queue is empty.
2. **Publish `@happyvertical/smrt-planner`. Blocked on Will's approval for repo settings.**
   - **Needed:** a `release` environment on happyvertical/smrt-planner that deploys only from `main` (iac#2165 pattern). The org secrets `NPM_HAPPYVERTICAL_PUBLISH_TOKEN` and `NPM_TOKEN` must reach it.
   - **Workflow:** add a single-package publish workflow, main-guarded, that publishes to `https://npm.happyvertical.com/` and mirrors to npmjs best-effort.
   - **Package:** remove `private` and set a version.
   - **Release order:** the planner publishes only with or after smrt 0.55.12, because older CLIs put the token in the config.
   - **Never** publish from a workstation.
3. **#3752 local plugin: Will verifies manually** after the planner is published. The steps are in the #3752 claim comment and the #3765 PR body: ChatGPT desktop personal marketplace, then the Plugins Directory, then "Use SMRT Kitchen to plan an app for my bakery". Check that the tools appear, `apply_plan` needs its confirm code, and no key is asked for. Also check Codex marketplace add (blocked here by `/etc/codex/requirements.toml`) and Claude Code `/plugin marketplace add happyvertical/smrt`. The MCP Apps widget for a local stdio server is unbuilt and unverified. `plugins/smrt-kitchen/mcp.json` pins `@happyvertical/smrt-cli@>=0.55.11 <1`; consider an exact pin.
4. **#3754 remainder:**
   - typed validator diagnostics (it returns strings today);
   - validating layout refs, theme values and overview widgets;
   - hosting the schema at `https://s-m-r-t.dev/schemas/cookbook/v1.json` (via s-m-r-t.dev#307).
5. **#3769:** recipe data gaps in published manifests. The planner drops `ingestion.inbox`, `ingestion.review` and `integrations.webhooks`, and tracks the rest in smrt-planner `tests/upstream-gaps.ts`.
6. **happyvertical/s-m-r-t.dev#307:**
   - **Route:** a `/plan` route (Will chose `/plan`, not `/planner`): the static planner build with `BASE_PATH=/plan` and bring-your-own model plus opt-in WebLLM.
   - **Hosting:** synced to the S3 `plan/` prefix, with a CloudFront fallback for `/plan/*`.
   - **Schema:** the hosted cookbook schema.
   - **Prerequisite:** s-m-r-t.dev pins smrt 0.51, so it needs an upgrade.
7. **happyvertical/happyvertical.com#330:**
   - **Penthouse floor:** a new top floor above Anytown.
   - **Planner:** mount `Planner`, with Happy controlling it through `commandTools` executed in the browser. Server endpoint per smrt-planner `docs/inference-host.md` (host mode, server-owned prompt via `@happyvertical/smrt-planner/core` `buildHostPrompt`/`parseHostReply`).
   - **Model and access:** `gpt-6-astra` (check the live deployment's values), anonymous with rate limits.
   - **Prerequisite:** the site pins smrt 0.51.
8. **Standalone Kitchen "Continue with ChatGPT":** sdk#1394 (auth/session), then sdk#1393 (plan-usage provider), then #3750 and smrt-planner#23 consume it.
9. **#3751** (hosted plugin / connector) is DEFERRED. Don't build plan.s-m-r-t.dev.
10. **After the epic:** approvals #3716 slices 2–6 (slice 1 shipped in #3745).

## Process rules (Will's)
- **Merge queue:** enqueue with `gh pr merge <n> --auto`. Bare `--squash` on a CLEAN PR bypasses the queue via admin bypass. Never update a BEHIND branch, and never rerun or cancel merge_group runs. Capture a failing log before anything else.
- **Merge authority:** granted for this work when the required checks pass. Stop for risky changes. Repo settings changes need Will's explicit yes.
- **Releases:** one release branch per repo per wave, workers test only what they touch, run the full suite once, then one PR per repo. Sibling branches in other repos share the same name.
- **No workarounds** (no `--no-verify`). Drive-by fixes of ten lines or fewer are expected in-branch. File an issue only with a one-line reason it can't ship here.
- **smrt validation:** `pnpm install && pnpm build && pnpm test && pnpm typecheck && pnpm lint && pnpm format-check && pnpm knowledge:check --strict --format markdown && pnpm audit:policy && pnpm check:agents-chain`, plus the CI-only `check-hardcoded-strings` (Monorepo Standards). If the knowledge check is stale after tests, run `pnpm knowledge:graph`.
- **Data dirs:** set `HOME` and `SMRT_DATA_DIR` to scratch dirs for app e2e runs. The runtime writes under `~/Library/Application Support` otherwise.
- **Uncommitted local files:** this coordinator worktree has `.claude/launch.json` and `docs/app-feature-recipes-report.md`; leave them.
