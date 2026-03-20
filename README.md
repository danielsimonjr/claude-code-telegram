# Claude Code Telegram Bridge

Control Claude Code from your phone via Telegram. Works on Windows, Mac, and Linux. No tunnels, no Docker, no cloud hosting.

## How It Works

```
You (Telegram) → Bot (polling) → stdin → Claude Code process
Claude Code → stdout → Bot → You (Telegram)
```

The bridge runs locally on your machine. It spawns Claude Code as a child process, pipes your Telegram messages to its stdin, and sends Claude's stdout responses back to Telegram. No data leaves your machine except through Telegram's API.

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
- Claude Code CLI (authenticated)
- A Telegram account

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

### 4. Run

```bash
node bridge.js [optional-working-directory]
```

Then message your bot on Telegram. Claude Code starts automatically when you send the first message.

## Commands

| Command | What it does |
|---------|-------------|
| `/start` | Initialize and show working directory |
| `/status` | Check if Claude process is running |
| `/stop` | Interrupt Claude (Ctrl+C) |
| `/restart` | Kill and restart Claude process |
| `/help` | Show commands |
| *(any text)* | Send directly to Claude Code |

## Configuration

All config lives in `~/.claude-code-telegram/.env`:

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | (required) | From @BotFather |
| `ALLOWED_USERS` | (empty = anyone) | Comma-separated Telegram user IDs |
| `CLAUDE_WORK_DIR` | current directory | Working directory for Claude Code |

## Files

| Path | Purpose |
|------|---------|
| `~/.claude-code-telegram/.env` | Configuration |
| `~/.claude-code-telegram/bridge.log` | Activity log |
| `~/.claude-code-telegram/history.jsonl` | Message history |

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
