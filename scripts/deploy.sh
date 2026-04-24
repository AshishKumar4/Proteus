#!/usr/bin/env bash
# Unified Proteus + Nimbus deploy pipeline.
#
# Deploys Nimbus FIRST (Proteus binds to it via service binding
# `script_name: "nimbus"`), then Proteus, then verifies both.
#
# Usage:
#   bash scripts/deploy.sh                     # sibling ../nimbus path
#   NIMBUS_PATH=/path/to/nimbus scripts/deploy.sh
#   CLOUDFLARE_ACCOUNT_ID=... scripts/deploy.sh
#   SKIP_E2E=1 scripts/deploy.sh               # skip pre-deploy verification
#   SKIP_NIMBUS=1 scripts/deploy.sh            # deploy Proteus only
#
# Idempotent: safe to re-run. Exits on first failure.
set -uo pipefail

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# ── Locate Proteus root + Nimbus path ────────────────────────────
PROTEUS_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROTEUS_ROOT" || { echo -e "${RED}Cannot cd to Proteus root${NC}"; exit 1; }

NIMBUS_PATH="${NIMBUS_PATH:-$PROTEUS_ROOT/../nimbus}"
# Resolve to absolute path for clarity in logs
if [ -d "$NIMBUS_PATH" ]; then
  NIMBUS_PATH="$(cd "$NIMBUS_PATH" && pwd)"
fi

export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-f44999d1ddda7012e9a87729eba250f1}"

# Captured during deploy for final summary
NIMBUS_URL=""
NIMBUS_VERSION=""
PROTEUS_URL="https://proteus.ashishkumarsingh.com/"
PROTEUS_VERSION=""

# Temp log files — declared early so the trap can clean them regardless of
# where we fail (including SIGINT).
NIMBUS_DEPLOY_LOG=""
PROTEUS_DEPLOY_LOG=""
cleanup() {
  [ -n "$NIMBUS_DEPLOY_LOG" ] && rm -f "$NIMBUS_DEPLOY_LOG"
  [ -n "$PROTEUS_DEPLOY_LOG" ] && rm -f "$PROTEUS_DEPLOY_LOG"
}
trap cleanup EXIT INT TERM

echo -e "${BOLD}Proteus + Nimbus Deploy Pipeline${NC}"
echo "================================="
echo "Proteus root: $PROTEUS_ROOT"
echo "Nimbus path:  $NIMBUS_PATH"
echo "Account:      $CLOUDFLARE_ACCOUNT_ID"
echo ""

# ── Pre-flight: verify npx + wrangler auth ───────────────────────
if ! command -v npx >/dev/null 2>&1; then
  echo -e "${RED}npx not found — install Node.js${NC}"
  exit 1
fi
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo -e "${RED}Wrangler not authenticated.${NC}"
  echo "Run: npx wrangler login"
  exit 1
fi

# ── Pre-flight: verify Nimbus path ───────────────────────────────
if [ "${SKIP_NIMBUS:-0}" != "1" ]; then
  if [ ! -d "$NIMBUS_PATH" ]; then
    echo -e "${RED}NIMBUS_PATH does not exist: $NIMBUS_PATH${NC}"
    echo ""
    echo "Nimbus must be deployed before Proteus (Proteus binds it via"
    echo "service binding \`script_name: \"nimbus\"\`)."
    echo ""
    echo "Clone Nimbus to a sibling directory:"
    echo "  git clone https://github.com/AshishKumar4/Nimbus.git $NIMBUS_PATH"
    echo ""
    echo "Or point NIMBUS_PATH at an existing checkout:"
    echo "  NIMBUS_PATH=/path/to/nimbus bash scripts/deploy.sh"
    echo ""
    echo "Or skip Nimbus deploy (Proteus only):"
    echo "  SKIP_NIMBUS=1 bash scripts/deploy.sh"
    exit 1
  fi
  if [ ! -f "$NIMBUS_PATH/wrangler.jsonc" ]; then
    echo -e "${RED}$NIMBUS_PATH/wrangler.jsonc not found — not a Nimbus repo${NC}"
    exit 1
  fi
  # Verify it declares "name": "nimbus"
  if ! grep -q '"name"[[:space:]]*:[[:space:]]*"nimbus"' "$NIMBUS_PATH/wrangler.jsonc"; then
    echo -e "${RED}$NIMBUS_PATH/wrangler.jsonc does not declare worker name \"nimbus\"${NC}"
    echo "This script assumes the Nimbus Worker is deployed as \"nimbus\" so Proteus"
    echo "can bind it via \`script_name: \"nimbus\"\`. Adjust Nimbus's wrangler.jsonc"
    echo "or set the name to match."
    exit 1
  fi
fi

# ── Step 1: Pre-deploy verification ──────────────────────────────
echo -e "${BOLD}Step 1: Pre-deploy verification${NC}"
if [ "${SKIP_E2E:-0}" = "1" ]; then
  echo -e "${YELLOW}SKIP_E2E=1 — skipping E2E suite${NC}"
else
  if bash scripts/e2e-test.sh; then
    echo ""
    echo -e "${GREEN}Pre-deploy checks passed.${NC}"
  else
    echo ""
    echo -e "${RED}Pre-deploy checks failed. Fix issues before deploying.${NC}"
    echo "(Re-run with SKIP_E2E=1 to bypass, e.g. for a doc-only or config-only deploy.)"
    exit 1
  fi
fi

# ── Step 2: Deploy Nimbus ────────────────────────────────────────
if [ "${SKIP_NIMBUS:-0}" = "1" ]; then
  echo ""
  echo -e "${YELLOW}SKIP_NIMBUS=1 — skipping Nimbus deploy${NC}"
else
  echo ""
  echo -e "${BOLD}Step 2: Deploying Nimbus${NC}"
  echo "cwd: $NIMBUS_PATH"
  pushd "$NIMBUS_PATH" >/dev/null || { echo -e "${RED}cannot cd to $NIMBUS_PATH${NC}"; exit 1; }

  # Install deps if missing (bun preferred, falls back to npm).
  if [ ! -d node_modules ] || [ ! -d node_modules/wrangler ]; then
    echo "Installing Nimbus dependencies (node_modules missing)..."
    if command -v bun >/dev/null 2>&1; then
      bun install || { echo -e "${RED}bun install failed in Nimbus${NC}"; popd >/dev/null; exit 1; }
    else
      npm install || { echo -e "${RED}npm install failed in Nimbus${NC}"; popd >/dev/null; exit 1; }
    fi
  else
    echo "Nimbus node_modules present — skipping install."
  fi

  # Deploy. Capture output for logging + version extraction; trap cleans up.
  NIMBUS_DEPLOY_LOG="$(mktemp -t nimbus-deploy.XXXXXX.log)"
  echo "Running: npx wrangler deploy (log → $NIMBUS_DEPLOY_LOG)"
  echo ""
  if npx wrangler deploy 2>&1 | tee "$NIMBUS_DEPLOY_LOG"; then
    echo ""
    echo -e "${GREEN}Nimbus deploy succeeded.${NC}"
  else
    echo ""
    echo -e "${RED}Nimbus deploy failed — see log above.${NC}"
    popd >/dev/null
    exit 1
  fi

  # Extract deployed URL + version ID from wrangler output.
  NIMBUS_URL="$(grep -oE 'https://nimbus\.[a-zA-Z0-9.-]+\.workers\.dev' "$NIMBUS_DEPLOY_LOG" | head -1)"
  if [ -z "$NIMBUS_URL" ]; then
    NIMBUS_URL="$(grep -oE 'https://[^ ]*\.workers\.dev' "$NIMBUS_DEPLOY_LOG" | head -1)"
  fi
  NIMBUS_VERSION="$(grep -oE 'Version ID:[[:space:]]*[a-f0-9-]+' "$NIMBUS_DEPLOY_LOG" | head -1 | awk '{print $NF}')"

  popd >/dev/null

  if [ -n "$NIMBUS_URL" ]; then
    echo "Nimbus URL:     $NIMBUS_URL"
  fi
  if [ -n "$NIMBUS_VERSION" ]; then
    echo "Nimbus version: $NIMBUS_VERSION"
  fi
fi

# ── Step 3: Deploy Proteus ───────────────────────────────────────
echo ""
echo -e "${BOLD}Step 3: Deploying Proteus${NC}"
cd "$PROTEUS_ROOT/packages/cf-backend" || { echo -e "${RED}cannot cd to cf-backend${NC}"; exit 1; }

# Install deps + build static assets.
if [ ! -d "$PROTEUS_ROOT/node_modules" ]; then
  echo "Installing Proteus dependencies (root node_modules missing)..."
  (cd "$PROTEUS_ROOT" && bun install) || { echo -e "${RED}bun install failed in Proteus${NC}"; exit 1; }
fi

# Build the client bundle into dist/client (used by wrangler's assets directive).
if [ -f ./node_modules/.bin/vite ]; then
  echo "Running: vite build"
  ./node_modules/.bin/vite build || { echo -e "${RED}vite build failed${NC}"; exit 1; }
else
  echo "Running: bunx vite build"
  bunx vite build || { echo -e "${RED}vite build failed${NC}"; exit 1; }
fi

PROTEUS_DEPLOY_LOG="$(mktemp -t proteus-deploy.XXXXXX.log)"
echo ""
echo "Running: npx wrangler deploy (log → $PROTEUS_DEPLOY_LOG)"
echo ""
if npx wrangler deploy 2>&1 | tee "$PROTEUS_DEPLOY_LOG"; then
  echo ""
  echo -e "${GREEN}Proteus deploy succeeded.${NC}"
else
  echo ""
  echo -e "${RED}Proteus deploy failed — see log above.${NC}"
  exit 1
fi

PROTEUS_VERSION="$(grep -oE 'Version ID:[[:space:]]*[a-f0-9-]+' "$PROTEUS_DEPLOY_LOG" | head -1 | awk '{print $NF}')"

# Verify wrangler echoed the NIMBUS_SESSION binding (proves it was picked up).
# Hard failure when SKIP_NIMBUS!=1: a silently-missing binding would let Proteus
# go live without Nimbus access, which is precisely what this script exists to
# prevent.
if [ "${SKIP_NIMBUS:-0}" != "1" ]; then
  if grep -q 'NIMBUS_SESSION' "$PROTEUS_DEPLOY_LOG"; then
    echo -e "${GREEN}✅ Proteus bound NIMBUS_SESSION${NC}"
  else
    echo -e "${RED}❌ wrangler output did not mention NIMBUS_SESSION — binding is missing${NC}"
    echo "   Check that packages/cf-backend/wrangler.jsonc includes:"
    echo "     { \"class_name\": \"NimbusSession\", \"name\": \"NIMBUS_SESSION\", \"script_name\": \"nimbus\" }"
    echo "   (Re-run with SKIP_NIMBUS=1 to deploy Proteus without the Nimbus binding.)"
    exit 1
  fi
fi

cd "$PROTEUS_ROOT" || exit 1

# ── Step 4: Post-deploy smoke test ───────────────────────────────
echo ""
echo -e "${BOLD}Step 4: Post-deploy smoke test${NC}"
echo "Waiting 10s for deployments to propagate..."
sleep 10

SMOKE_FAIL=0

# Proteus (production route).
LIVE_STATUS=$(curl -so /dev/null -w '%{http_code}' --max-time 15 "$PROTEUS_URL" 2>/dev/null || echo "000")
if [ "$LIVE_STATUS" = "200" ]; then
  echo -e "${GREEN}✅ Proteus live site returns 200${NC} ($PROTEUS_URL)"
else
  echo -e "${RED}❌ Proteus live site returns $LIVE_STATUS${NC} ($PROTEUS_URL)"
  SMOKE_FAIL=1
fi

LIVE_HTML=$(curl -s --max-time 15 "$PROTEUS_URL" 2>/dev/null)
if echo "$LIVE_HTML" | grep -qi 'proteus'; then
  echo -e "${GREEN}✅ Proteus live site serves Proteus app${NC}"
else
  echo -e "${RED}❌ Proteus live site content missing 'Proteus'${NC}"
  SMOKE_FAIL=1
fi

# Nimbus (workers.dev URL).
if [ "${SKIP_NIMBUS:-0}" != "1" ] && [ -n "$NIMBUS_URL" ]; then
  NIMBUS_STATUS=$(curl -so /dev/null -w '%{http_code}' --max-time 15 "$NIMBUS_URL" 2>/dev/null || echo "000")
  if [ "$NIMBUS_STATUS" = "200" ]; then
    echo -e "${GREEN}✅ Nimbus live site returns 200${NC} ($NIMBUS_URL)"
  else
    echo -e "${RED}❌ Nimbus live site returns $NIMBUS_STATUS${NC} ($NIMBUS_URL)"
    SMOKE_FAIL=1
  fi
fi

if [ "$SMOKE_FAIL" -ne 0 ]; then
  echo ""
  echo -e "${RED}Smoke test failed.${NC}"
  exit 1
fi

# ── Step 5: Summary ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}Deploy complete.${NC}"
echo "================================="
if [ "${SKIP_NIMBUS:-0}" != "1" ]; then
  echo "Nimbus:   ${NIMBUS_URL:-(URL not captured)}"
  echo "          version ${NIMBUS_VERSION:-unknown}"
fi
echo "Proteus:  $PROTEUS_URL"
echo "          version ${PROTEUS_VERSION:-unknown}"
echo ""
echo -e "${GREEN}✅ Both Workers deployed and verified.${NC}"
