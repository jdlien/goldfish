#!/bin/bash
# Rebuild the FTS5 memory search index.
# Cron: 15 1 * * * /path/to/goldfish/scripts/index-memory.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GOLDFISH_HOME="${GOLDFISH_HOME:-$(dirname "$SCRIPT_DIR")}"

cd "$GOLDFISH_HOME"
node dist/index.js index-memory
