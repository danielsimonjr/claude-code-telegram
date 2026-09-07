#!/bin/bash
# Setup script for Claude Code Telegram Bridge
# Run: bash setup.sh

set -e

echo "Claude Code Telegram Bridge — Setup"
echo "====================================="
echo ""

CONFIG_DIR="$HOME/.claude-code-telegram"
mkdir -p "$CONFIG_DIR"

# 1. Check prerequisites
echo "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "  Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "  Node.js $(node --version)"

if ! command -v claude &>/dev/null; then
  echo "  Claude Code not found. Install from https://claude.com/product/claude-code"
  exit 1
fi
echo "  Claude Code installed"

# 2. Get Telegram bot token
echo ""
echo "Telegram Bot Setup"
echo "  1. Open Telegram and message @BotFather"
echo "  2. Send /newbot and follow the prompts"
echo "  3. Copy the bot token"
echo ""

if [ -f "$CONFIG_DIR/.env" ]; then
  echo "  Found existing .env file at $CONFIG_DIR/.env"
  read -p "  Overwrite? (y/N): " overwrite
  if [ "$overwrite" != "y" ] && [ "$overwrite" != "Y" ]; then
    echo "  Keeping existing config."
  else
    read -p "  Paste your bot token: " TOKEN
    read -p "  Your Telegram user ID (get from @userinfobot): " USER_ID

    cat > "$CONFIG_DIR/.env" << EOF
TELEGRAM_BOT_TOKEN=$TOKEN
ALLOWED_USERS=$USER_ID
EOF
    echo "  Config saved to $CONFIG_DIR/.env"
  fi
else
  read -p "  Paste your bot token: " TOKEN
  read -p "  Your Telegram user ID (get from @userinfobot): " USER_ID

  cat > "$CONFIG_DIR/.env" << EOF
TELEGRAM_BOT_TOKEN=$TOKEN
ALLOWED_USERS=$USER_ID
EOF
  echo "  Config saved to $CONFIG_DIR/.env"
fi

# 3. Install dependencies and build
# The bridge is TypeScript now, so it must be compiled before it can run. A
# production-only install would omit typescript and leave nothing to build with.
echo ""
echo "Installing dependencies..."
cd "$(dirname "$0")"
bun install
echo "  Dependencies installed"

echo "Building..."
bun run build
echo "  Built to dist/"

# 4. Done
echo ""
echo "====================================="
echo "Setup complete!"
echo ""
echo "To start:"
echo "  node dist/index.js [working-directory]"
echo ""
echo "Then message your bot on Telegram."
echo ""
echo "Config:   $CONFIG_DIR/.env"
echo "Session:  $CONFIG_DIR/session.json"
echo "Logs:     $CONFIG_DIR/bridge.log"
