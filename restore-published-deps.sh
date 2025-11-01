#!/usr/bin/env bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔄 Restoring Published Dependencies${NC}"
echo ""

# SDK packages to unlink
SDK_PACKAGES=(
  "ai"
  "files"
  "geo"
  "logger"
  "sql"
  "utils"
)

SMRT_ROOT=$(pwd)

# Unlink from each SMRT package
for smrt_pkg in packages/*; do
  if [ -d "$smrt_pkg" ] && [ -f "$smrt_pkg/package.json" ]; then
    pkg_name=$(basename "$smrt_pkg")

    # Check if this package uses any SDK packages
    uses_sdk=false
    for sdk_pkg in "${SDK_PACKAGES[@]}"; do
      if grep -q "@happyvertical/$sdk_pkg" "$smrt_pkg/package.json" 2>/dev/null; then
        uses_sdk=true
        break
      fi
    done

    if [ "$uses_sdk" = true ]; then
      echo -e "${YELLOW}→${NC} Unlinking SDK packages from $pkg_name..."
      cd "$smrt_pkg"

      for sdk_pkg in "${SDK_PACKAGES[@]}"; do
        if grep -q "@happyvertical/$sdk_pkg" "package.json" 2>/dev/null; then
          pnpm unlink @happyvertical/$sdk_pkg 2>/dev/null || true
          echo -e "  ${GREEN}✓${NC} Unlinked @happyvertical/$sdk_pkg"
        fi
      done

      cd "$SMRT_ROOT"
    fi
  fi
done

echo ""
echo -e "${BLUE}📦 Reinstalling from registry...${NC}"
pnpm install --force
echo ""

echo -e "${GREEN}✨ Published dependencies restored!${NC}"
echo ""
echo -e "${YELLOW}Note:${NC} SDK packages are now installed from GitHub Package Registry"
echo ""
echo "To use local SDK again, run: ${BLUE}./setup-local-dev.sh${NC}"
echo ""
