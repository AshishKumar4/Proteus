#!/bin/bash
# Verify Proteus Lean 4 formal specification.
# Usage: ./scripts/verify-lean.sh
#
# Prerequisites: elan + lean 4 (install via: curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh)

set -euo pipefail

LEAN_DIR="$(cd "$(dirname "$0")/../lean" && pwd)"

echo "=== Proteus Lean 4 Verification ==="
echo "Directory: $LEAN_DIR"

# Check lean is installed
if ! command -v lean &> /dev/null; then
  echo "ERROR: lean not found. Install via:"
  echo "  curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh"
  exit 1
fi

echo "Lean version: $(lean --version)"

# Build
cd "$LEAN_DIR"
echo ""
echo "Building..."
lake build

# Count theorems and axioms
THEOREMS=$(grep -rn '^theorem ' Proteus/ --include='*.lean' | wc -l)
AXIOMS=$(grep -rn '^axiom ' Proteus/ --include='*.lean' | wc -l)
SORRIES=$(grep -rn '\bsorry\b' Proteus/ --include='*.lean' | grep -v '^\-\-' | grep -v 'comment' | grep -v '0 sorry' | wc -l)

echo ""
echo "=== Results ==="
echo "Theorems: $THEOREMS"
echo "Axioms:   $AXIOMS (Float IEEE 754)"
echo "Sorries:  $SORRIES"
echo ""

if [ "$SORRIES" -gt 0 ]; then
  echo "WARNING: $SORRIES sorry found!"
  grep -rn '\bsorry\b' Proteus/ --include='*.lean' | grep -v '^\-\-' | grep -v 'comment' | grep -v '0 sorry'
  exit 1
else
  echo "All proofs verified. Zero sorry."
fi
