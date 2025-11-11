# Standard Workflows - DO NOT EDIT

This directory contains auto-generated workflow files managed by the HappyVertical
standardization script. Manual changes will be overwritten on updates.

## Workflows

- **on-issue-opened.yml** - Automated triage when issues are created
- **on-label-changed.yml** - Label enforcement and agent orchestration
- **on-issue-closed.yml** - Cleanup when issues are closed
- **on-pr-opened.yml** - Pull request automation
- **on-merge-main.yml** - Build pipeline (test → build → publish)

## To Update

Run the standardization script:
```bash
bun scripts/standardize-repo.ts --repo happyvertical/smrt --path ../smrt
```

## To Customize

Edit the repository-specific workflows in the parent directory:
- `../test.yml` - Test execution
- `../build.yml` - Build process
- `../publish.yml` - Publishing

## Source

https://github.com/happyvertical/sdk/.github/workflow-templates/
