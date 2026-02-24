#!/usr/bin/env bash
# Ensures all @happyvertical SDK packages in the pnpm catalog and package.json
# overrides use the same version. Standalone packages (ocr, pdf, spider) are
# versioned independently and excluded.
set -euo pipefail

WORKSPACE_FILE="pnpm-workspace.yaml"
PACKAGE_FILE="package.json"
STANDALONE_PACKAGES="ocr|pdf|spider"

if [ ! -f "$WORKSPACE_FILE" ]; then
  echo "ERROR: $WORKSPACE_FILE not found."
  exit 1
fi

# Extract SDK catalog versions (exclude standalone packages)
catalog_versions=$(grep "^  '@happyvertical/" "$WORKSPACE_FILE" \
  | grep -vE "/(${STANDALONE_PACKAGES})'" \
  | awk -F': ' '{print $2}' || true)

if [ -z "$catalog_versions" ]; then
  echo "ERROR: No SDK packages found in $WORKSPACE_FILE catalog."
  exit 1
fi

unique_catalog=$(echo "$catalog_versions" | sort -u)
catalog_count=$(echo "$unique_catalog" | wc -l | tr -d ' ')

if [ "$catalog_count" -ne 1 ]; then
  echo "ERROR: SDK packages in $WORKSPACE_FILE catalog have mismatched versions:"
  echo ""
  grep "^  '@happyvertical/" "$WORKSPACE_FILE" | grep -vE "/(${STANDALONE_PACKAGES})'"
  echo ""
  echo "All SDK packages must use the same version. Found:"
  echo "$unique_catalog"
  exit 1
fi

echo "OK: Catalog SDK packages at ${unique_catalog}"

# Also check pnpm.overrides in package.json if present
if [ -f "$PACKAGE_FILE" ]; then
  # Extract only lines that look like override entries: "  "@happyvertical/foo": "^x.y.z"
  override_versions=$(grep -E '^\s+"@happyvertical/[^"]+": "\^' "$PACKAGE_FILE" \
    | grep -vE "/(smrt-|ocr|pdf|spider)" \
    | sed 's/.*": *"\(.*\)".*/\1/' || true)

  if [ -n "$override_versions" ]; then
    unique_overrides=$(echo "$override_versions" | sort -u)
    override_count=$(echo "$unique_overrides" | wc -l | tr -d ' ')

    if [ "$override_count" -ne 1 ]; then
      echo "ERROR: SDK packages in $PACKAGE_FILE overrides have mismatched versions:"
      echo ""
      grep -E '^\s+"@happyvertical/[^"]+": "\^' "$PACKAGE_FILE" \
        | grep -vE "/(smrt-|ocr|pdf|spider)"
      echo ""
      echo "Found:"
      echo "$unique_overrides"
      exit 1
    fi

    if [ "$unique_overrides" != "$unique_catalog" ]; then
      echo "ERROR: Override version ($unique_overrides) does not match catalog version ($unique_catalog)."
      exit 1
    fi

    echo "OK: Override SDK packages at ${unique_overrides}"
  fi
fi

echo "OK: All SDK versions aligned."
