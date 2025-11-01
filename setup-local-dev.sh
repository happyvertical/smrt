#!/usr/bin/env bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🔗 SMRT Local Development Setup${NC}"
echo ""

# Check for SDK path
SDK_PATH="${SDK_PATH:-../sdk}"

if [ ! -d "$SDK_PATH" ]; then
  echo -e "${RED}❌ SDK repository not found at: $SDK_PATH${NC}"
  echo ""
  echo "Please either:"
  echo "  1. Clone the SDK repo: git clone git@github.com:happyvertical/sdk.git ../sdk"
  echo "  2. Set SDK_PATH environment variable: export SDK_PATH=/path/to/sdk"
  echo ""
  exit 1
fi

echo -e "${GREEN}✓${NC} Found SDK repository at: $SDK_PATH"
echo ""

# SDK packages to link
SDK_PACKAGES=(
  "ai"
  "files"
  "geo"
  "logger"
  "sql"
  "utils"
)

# Step 1: Build SDK packages
echo -e "${BLUE}📦 Building SDK packages...${NC}"
cd "$SDK_PATH"
pnpm install
pnpm run build
echo -e "${GREEN}✓${NC} SDK packages built"
echo ""

# Step 2: Link SDK packages globally
echo -e "${BLUE}🔗 Linking SDK packages globally...${NC}"
for pkg in "${SDK_PACKAGES[@]}"; do
  cd "$SDK_PATH/packages/$pkg"
  pnpm link --global
  echo -e "${GREEN}✓${NC} Linked @happyvertical/$pkg"
done
echo ""

# Step 3: Return to SMRT repo and link packages
cd - > /dev/null
SMRT_ROOT=$(pwd)
echo -e "${BLUE}🔗 Linking SDK packages to SMRT packages...${NC}"

# Link in each SMRT package that uses SDK packages
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
      echo -e "${YELLOW}→${NC} Linking SDK packages in $pkg_name..."
      cd "$smrt_pkg"

      for sdk_pkg in "${SDK_PACKAGES[@]}"; do
        if grep -q "@happyvertical/$sdk_pkg" "package.json" 2>/dev/null; then
          pnpm link --global @happyvertical/$sdk_pkg
          echo -e "  ${GREEN}✓${NC} Linked @happyvertical/$sdk_pkg"
        fi
      done

      cd "$SMRT_ROOT"
    fi
  fi
done

echo ""
echo -e "${GREEN}✨ Local development setup complete!${NC}"
echo ""
echo -e "${YELLOW}Note:${NC} SDK packages are now linked from: $SDK_PATH"
echo -e "${YELLOW}Note:${NC} Changes to SDK packages will be reflected immediately"
echo ""
echo "To restore published packages, run: ${BLUE}./restore-published-deps.sh${NC}"
echo ""
