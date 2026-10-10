#!/usr/bin/env bash
# Verify SDK version alignment, including immutable repository-local archives.
set -euo pipefail
exec node "$(dirname "$0")/check-sdk-versions.mjs"
