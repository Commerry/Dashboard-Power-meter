#!/bin/bash
# Power Center installation script (Linux / Raspberry Pi / server)
# Installs dependencies, creates .env, starts with PM2 and enables boot autostart.
set -e

echo "=========================================="
echo "Power Center Installation"
echo "=========================================="

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

echo "Step 1: Checking Node.js..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Install Node.js 18+ first."
    exit 1
fi
NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "❌ Node.js $(node -v) is too old - need 18 or newer."
    echo "   Install on x64 Linux:"
    echo "   curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz"
    echo "   sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1"
    exit 1
fi
echo "✓ Node $(node -v), npm $(npm -v)"
echo ""

echo "Step 2: Installing dependencies..."
# serialport / mqtt are optional - a failed native build must not stop the install
npm install --no-audit --no-fund || npm install --no-audit --no-fund --omit=optional
echo "✓ Dependencies installed"
echo ""

echo "Step 3: Creating .env if missing..."
if [ ! -f ".env" ] && [ -f ".env.example" ]; then
    cp .env.example .env
    echo "✓ Created .env from .env.example (edit ADMIN_PASS, SITE_NAME, SEED_DEMO before first start)"
else
    echo "✓ .env already present"
fi
mkdir -p logs data
echo ""

echo "Step 4: Setting up PM2..."
if ! command -v pm2 &> /dev/null; then
    npm install -g pm2
    echo "✓ PM2 installed"
else
    echo "✓ PM2 already installed"
fi
echo ""

echo "Step 5: Starting Power Center..."
pm2 delete power-center 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save --force
echo ""

echo "Step 6: Enabling autostart on boot..."
STARTUP_CMD=$(pm2 startup | grep "sudo env" | cut -d' ' -f2-)
if [ -n "$STARTUP_CMD" ]; then
    eval "sudo $STARTUP_CMD" && pm2 save --force \
        && echo "✓ Autostart enabled" \
        || echo "⚠ Run 'pm2 startup' manually, execute the sudo command it prints, then 'pm2 save'"
else
    echo "⚠ Could not detect startup command - run 'pm2 startup' manually (skip on Windows/WSL)"
fi
echo ""

PORT=$(grep -oP '^PORT=\K[0-9]+' .env 2>/dev/null || echo 8095)
echo "=========================================="
echo "Power Center is running"
echo "  Dashboard : http://<this-pc-ip>:$PORT   (login: ADMIN_USER / ADMIN_PASS from .env)"
echo "  Public API: http://<this-pc-ip>:$PORT/api/v1"
echo "  Ingest    : http://<this-pc-ip>:$PORT/api/v1/ingest"
echo ""
echo "Next: open the dashboard -> Settings -> add plants / lines -> add gateways -> add meters"
echo "Useful: pm2 status | pm2 logs power-center | pm2 restart power-center"
echo "=========================================="
