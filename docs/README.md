# SMRT documentation site

The Docusaurus site combines authored guides in [`content`](./content/) with every workspace package README, including nested workspaces.

## Development

```bash
pnpm --dir docs install
pnpm --dir docs dev
```

`predev` and `prebuild` run `scripts/copy-readmes.js`. The script discovers packages from `pnpm-workspace.yaml` and copies their READMEs into the generated `content/packages/` directory; there is no hand-maintained package allowlist. Repository-local links are rewritten to canonical GitHub source URLs so they remain valid after the README moves. The sidebar autogenerates package navigation from that directory.

Validate the repository README system before building the site:

```bash
pnpm check:readmes
pnpm docs:site:build
```
