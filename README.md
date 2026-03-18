# Claude Code Telegram Bridge

Control your Claude Code session from Telegram. Send messages from your phone, get responses back. No tunnels, no cloud hosting, no Docker required.

## How It Works

```
You (Telegram) → Bot (polling) → tmux send-keys → Claude Code
Claude Code → Stop hook → response file → Bot → You (Telegram)
```

The bridge runs locally on your machine. It injects your Telegram messages into a tmux session running Claude Code, then uses Claude's Stop hook to capture responses and send them back to Telegram. No data leaves your machine except through Telegram's API.

## Quick Start

```bash
git clone https://github.com/danielsimonjr/claude-code-telegram.git
cd claude-code-telegram
bash setup.sh
```

The setup script walks you through creating a Telegram bot, configuring your token, and installing the Stop hook.

## Manual Setup

### Prerequisites

- Node.js 18+
- tmux
- Claude Code CLI (authenticated)

### 1. Create a Telegram Bot

Open Telegram, message [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. Copy the token.

Get your user ID from [@userinfobot](https://t.me/userinfobot).

### 2. Configure

```bash
mkdir -p ~/.claude-code-telegram
cat > ~/.claude-code-telegram/.env << EOF
TELEGRAM_BOT_TOKEN=your_token_here
ALLOWED_USERS=your_user_id_here
TMUX_SESSION=claude
EOF
```

### 3. Install Dependencies

```bash
cd claude-code-telegram
npm install
```

### 4. Install the Stop Hook

Copy the hook and register it:

```bash
cp hooks/stop-hook.sh ~/.claude/hooks/telegram-stop-hook.sh
chmod +x ~/.claude/hooks/telegram-stop-hook.sh
```

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/telegram-stop-hook.sh"
          }
        ]
      }
    ]
  }
}
```

### 5. Run

Terminal 1 — start Claude Code in tmux:
```bash
tmux new -s claude
claude
```

Terminal 2 — start the bridge:
```bash
node bridge.js
```

Now message your bot on Telegram.

## Commands

| Command | What it does |
|---------|-------------|
| `/status` | Check if tmux session is running |
| `/screen` | Capture last 50 lines of terminal output |
| `/stop` | Send Ctrl+C to interrupt Claude |
| `/clear` | Clear the conversation |
| `/help` | Show commands |
| *(any text)* | Send directly to Claude Code |

## Configuration

All config lives in `~/.claude-code-telegram/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | (required) | From @BotFather |
| `ALLOWED_USERS` | (empty = anyone) | Comma-separated Telegram user IDs |
| `TMUX_SESSION` | `claude` | Name of the tmux session |

## Files

| Path | Purpose |
|------|---------|
| `~/.claude-code-telegram/.env` | Configuration |
| `~/.claude-code-telegram/bridge.log` | Activity log |
| `~/.claude-code-telegram/history.jsonl` | Message history |
| `~/.claude-code-telegram/responses/` | Stop hook response staging |
| `~/.claude/hooks/telegram-stop-hook.sh` | Claude Code Stop hook |

## Security

- **User whitelist**: Only `ALLOWED_USERS` can interact with the bot
- **No shell injection**: All tmux commands use `execFileSync` (no shell interpolation)
- **Local only**: The bridge runs on your machine, no cloud services except Telegram's API
- **Message logging**: All messages logged to `history.jsonl` for audit

## Inspiration

This project combines ideas from several great projects:

- **[hanxiao/claudecode-telegram](https://github.com/hanxiao/claudecode-telegram)** — the tmux + Stop hook architecture
- **[RichardAtCT/claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram)** — session persistence, security features, and the agentic mode concept
- **[alexei-led/ccgram](https://github.com/alexei-led/ccgram)** — multi-session management and terminal screenshot idea

## License

MIT
