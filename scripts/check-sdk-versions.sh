#!/usr/bin/env bash
# Ensures all @happyvertical SDK packages in the pnpm catalog and workspace
# overrides use the same version. Standalone packages (ocr, pdf, spider) are
# versioned independently and excluded.
set -euo pipefail

WORKSPACE_FILE="pnpm-workspace.yaml"
STANDALONE_PACKAGES="ocr|pdf|spider"

if [ ! -f "$WORKSPACE_FILE" ]; then
  echo "ERROR: $WORKSPACE_FILE not found."
  exit 1
fi

extract_section_entries() {
  local section=$1
  awk -v header="${section}:" '
    $0 == header { in_section = 1; next }
    in_section && /^[^[:space:]#]/ { exit }
    in_section && /^  '\''@happyvertical\// { print }
  ' "$WORKSPACE_FILE"
}

# Extract only the catalog block; pnpm 11 also stores overrides in this file.
catalog_entries=$(extract_section_entries catalog)
catalog_versions=$(printf '%s\n' "$catalog_entries" \
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
  printf '%s\n' "$catalog_entries" | grep -vE "/(${STANDALONE_PACKAGES})'"
  echo ""
  echo "All SDK packages must use the same version. Found:"
  echo "$unique_catalog"
  exit 1
fi

echo "OK: Catalog SDK packages at ${unique_catalog}"

# Also check SDK entries in the pnpm 11 workspace overrides block.
override_entries=$(extract_section_entries overrides \
  | grep -vE "'@happyvertical/(smrt-|ocr|pdf|spider)" || true)
override_versions=$(printf '%s\n' "$override_entries" \
  | awk -F': ' 'NF > 1 {print $2}' || true)

if [ -n "$override_versions" ]; then
  unique_overrides=$(echo "$override_versions" | sort -u)
  override_count=$(echo "$unique_overrides" | wc -l | tr -d ' ')

  if [ "$override_count" -ne 1 ]; then
    echo "ERROR: SDK packages in $WORKSPACE_FILE overrides have mismatched versions:"
    echo ""
    printf '%s\n' "$override_entries"
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

echo "OK: All SDK versions aligned."
