#!/usr/bin/env bash
# EC2 Bootstrap script for Ubuntu 22.04/24.04 & Amazon Linux 2023.
# Installs Node.js 22+, headless Chromium/Chrome dependencies, builds troy-advanced,
# and optionally registers the systemd daemon.
set -euo pipefail

echo "=== troy-advanced EC2 bootstrap ==="

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y curl ca-certificates gnupg fonts-liberation jq
  if ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
    sudo apt-get install -y chromium || sudo apt-get install -y chromium-browser || true
  fi
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y curl ca-certificates jq liberation-fonts
  if ! command -v chromium >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1; then
    sudo dnf install -y chromium || true
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - 2>/dev/null || true
  sudo apt-get install -y nodejs 2>/dev/null || sudo dnf install -y nodejs 2>/dev/null || true
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SCRIPT_DIR"
npm install
npm run build
chmod +x bin/troy-advanced.mjs
node bin/troy-advanced.mjs doctor

echo "Bootstrap complete! Start daemon with: node $SCRIPT_DIR/bin/troy-advanced.mjs daemon start --compat-troy"
