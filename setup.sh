#!/bin/bash
# Setup script for Claude Code Telegram Bridge
# Run: bash setup.sh

set -e

echo "🤖 Claude Code Telegram Bridge — Setup"
echo "======================================="
echo ""

CONFIG_DIR="$HOME/.claude-code-telegram"
mkdir -p "$CONFIG_DIR/responses"

# 1. Check prerequisites
echo "Checking prerequisites..."

if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Install from https://nodejs.org"
  exit 1
fi
echo "  ✅ Node.js $(node --version)"

if ! command -v tmux &>/dev/null; then
  echo "❌ tmux not found. Install with: brew install tmux (mac) or apt install tmux (linux)"
  exit 1
fi
echo "  ✅ tmux installed"

if ! command -v claude &>/dev/null; then
  echo "❌ Claude Code not found. Install from https://claude.com/product/claude-code"
  exit 1
fi
echo "  ✅ Claude Code installed"

# 2. Get Telegram bot token
echo ""
echo "📱 Telegram Bot Setup"
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
TMUX_SESSION=claude
EOF
    echo "  ✅ Config saved to $CONFIG_DIR/.env"
  fi
else
  read -p "  Paste your bot token: " TOKEN
  read -p "  Your Telegram user ID (get from @userinfobot): " USER_ID

  cat > "$CONFIG_DIR/.env" << EOF
TELEGRAM_BOT_TOKEN=$TOKEN
ALLOWED_USERS=$USER_ID
TMUX_SESSION=claude
EOF
  echo "  ✅ Config saved to $CONFIG_DIR/.env"
fi

# 3. Install npm dependencies
echo ""
echo "Installing dependencies..."
cd "$(dirname "$0")"
npm install --production
echo "  ✅ Dependencies installed"

# 4. Install Stop hook
echo ""
echo "Installing Claude Code Stop hook..."

HOOK_DIR="$HOME/.claude/hooks"
mkdir -p "$HOOK_DIR"
cp hooks/stop-hook.sh "$HOOK_DIR/telegram-stop-hook.sh"
chmod +x "$HOOK_DIR/telegram-stop-hook.sh"

# Check if hook is already in settings
SETTINGS="$HOME/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  if grep -q "telegram-stop-hook" "$SETTINGS"; then
    echo "  ✅ Stop hook already registered in settings.json"
  else
    echo "  ⚠️  You need to add the Stop hook to $SETTINGS manually:"
    echo '  Add to hooks.Stop array:'
    echo '    {"type": "command", "command": "~/.claude/hooks/telegram-stop-hook.sh"}'
  fi
else
  echo "  ⚠️  No settings.json found at $SETTINGS"
  echo "  Create it with the Stop hook configuration."
fi

# 5. Done
echo ""
echo "======================================="
echo "✅ Setup complete!"
echo ""
echo "To start:"
echo "  1. Open a terminal: tmux new -s claude"
echo "  2. Inside tmux: claude"
echo "  3. In another terminal: node bridge.js"
echo "  4. Message your Telegram bot!"
echo ""
echo "Config: $CONFIG_DIR/.env"
echo "Logs:   $CONFIG_DIR/bridge.log"
