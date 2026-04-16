#!/usr/bin/env bash
# Proteus deployment script.
# Runs e2e verification, deploys to Cloudflare, then verifies the live site.
set -uo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

cd "$(dirname "$0")/.." || exit 1

echo -e "${BOLD}Proteus Deploy Pipeline${NC}"
echo "========================"
echo ""

# ── Step 1: Pre-deploy verification ──────────────────────────────
echo -e "${BOLD}Step 1: Pre-deploy verification${NC}"
if bash scripts/e2e-test.sh; then
  echo ""
  echo -e "${GREEN}Pre-deploy checks passed.${NC}"
else
  echo ""
  echo -e "${RED}Pre-deploy checks failed. Fix issues before deploying.${NC}"
  exit 1
fi

# ── Step 2: Deploy ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}Step 2: Deploying to Cloudflare${NC}"
cd packages/cf-backend || exit 1

# CLOUDFLARE_ACCOUNT_ID can be set in env or hardcoded for this project
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-f44999d1ddda7012e9a87729eba250f1}"

echo "Account: $CLOUDFLARE_ACCOUNT_ID"
echo "Running: npx wrangler deploy"
echo ""

if npx wrangler deploy; then
  echo ""
  echo -e "${GREEN}Deploy succeeded.${NC}"
else
  echo ""
  echo -e "${RED}Deploy failed.${NC}"
  exit 1
fi

cd ../..

# ── Step 3: Post-deploy verification ─────────────────────────────
echo ""
echo -e "${BOLD}Step 3: Post-deploy verification${NC}"
LIVE_URL="https://proteus.ashishkumarsingh.com/"

echo "Waiting 10s for deployment to propagate..."
sleep 10

LIVE_STATUS=$(curl -so /dev/null -w '%{http_code}' --max-time 15 "$LIVE_URL" 2>/dev/null || echo "000")
if [ "$LIVE_STATUS" = "200" ]; then
  echo -e "${GREEN}✅ Live site returns 200${NC}"
else
  echo -e "${RED}❌ Live site returns $LIVE_STATUS${NC}"
  exit 1
fi

LIVE_HTML=$(curl -s --max-time 15 "$LIVE_URL" 2>/dev/null)
if echo "$LIVE_HTML" | grep -qi 'proteus'; then
  echo -e "${GREEN}✅ Live site serves Proteus app${NC}"
else
  echo -e "${RED}❌ Live site content missing 'Proteus'${NC}"
  exit 1
fi

# Check WebSocket endpoint
WS_STATUS=$(curl -so /dev/null -w '%{http_code}' --max-time 5 "${LIVE_URL}agents/OrchestratorAgent/test" 2>/dev/null || echo "000")
echo "Agent endpoint: HTTP $WS_STATUS"

echo ""
echo -e "${GREEN}${BOLD}Deploy complete and verified.${NC}"
