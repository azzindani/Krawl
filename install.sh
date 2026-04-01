#!/bin/bash
# install.sh
# Works on: Ubuntu 22.04 VPS, Google Colab
# Usage: bash install.sh

set -e

echo "================================================"
echo "KRAWL — INSTALL"
echo "================================================"

# ── Node.js 20 ────────────────────────────────────────────────────
if ! command -v node &> /dev/null; then
  echo "[1/4] Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  echo "[1/4] Node.js already installed: $(node --version)"
fi

# ── System deps for Playwright Chromium ──────────────────────────
echo "[2/4] Installing system dependencies..."
sudo apt-get install -y -q \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
  libpangocairo-1.0-0 libnspr4 libnss3 libatspi2.0-0 \
  2>/dev/null || true

# ── npm packages ──────────────────────────────────────────────────
echo "[3/4] Installing npm packages..."
npm install

# ── Playwright Chromium ───────────────────────────────────────────
echo "[4/4] Installing Playwright Chromium..."
npx playwright install chromium --with-deps

# ── VPS only: PM2 process manager ────────────────────────────────
if [ "$1" == "--vps" ]; then
  echo "[+] Installing PM2..."
  npm install -g pm2
  pm2 startup || true
  echo ""
  echo "PM2 commands:"
  echo "  pm2 start 'npx tsx krawl.ts --tasks tasks/financial.json' --name krawl"
  echo "  pm2 logs krawl"
  echo "  pm2 stop krawl"
fi

# ── Colab only: expand /dev/shm ──────────────────────────────────
if [ -d "/content" ]; then
  echo "[+] Colab detected — expanding /dev/shm to 2GB..."
  mount -t tmpfs -o size=2g tmpfs /dev/shm 2>/dev/null || true
fi

# ── Smoke test ────────────────────────────────────────────────────
echo ""
echo "Smoke test..."
echo "console.log('krawl ready — node ' + process.version)" | npx tsx -

echo ""
echo "================================================"
echo "INSTALL COMPLETE"
echo "================================================"
echo "Usage:"
echo "  npx tsx krawl.ts --help"
echo "  npx tsx krawl.ts --tasks tasks/financial.json"
echo "  npx tsx krawl.ts --tasks tasks/financial.json --resume"
echo "  npx tsx krawl.ts --stats"
echo "  npx tsx krawl.ts --query \"SELECT * FROM stocks\""
echo "  npx tsx krawl.ts --search \"suku bunga\""
echo "  npx tsx krawl.ts --export all"
