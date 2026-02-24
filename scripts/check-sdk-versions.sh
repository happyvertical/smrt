#!/usr/bin/env bash
# Ensures all @happyvertical SDK packages in the pnpm catalog use the same version.
# Standalone packages (ocr, pdf, spider) are versioned independently and excluded.
set -euo pipefail

WORKSPACE_FILE="pnpm-workspace.yaml"
STANDALONE_PACKAGES="ocr|pdf|spider"

# Extract SDK catalog versions (exclude standalone packages)
versions=$(grep "^  '@happyvertical/" "$WORKSPACE_FILE" \
  | grep -vE "/(${STANDALONE_PACKAGES})'" \
  | awk -F': ' '{print $2}')

unique=$(echo "$versions" | sort -u)
count=$(echo "$unique" | wc -l | tr -d ' ')

if [ "$count" -ne 1 ]; then
  echo "ERROR: SDK packages in pnpm-workspace.yaml catalog have mismatched versions:"
  echo ""
  grep "^  '@happyvertical/" "$WORKSPACE_FILE" | grep -vE "/(${STANDALONE_PACKAGES})'"
  echo ""
  echo "All SDK packages must use the same version. Found:"
  echo "$unique"
  exit 1
fi

echo "OK: All SDK packages at ${unique}"
