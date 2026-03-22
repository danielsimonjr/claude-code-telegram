# Claude Code Telegram Bridge

Control Claude Code from your phone via Telegram. Persistent conversations with real-time streaming. Works on Windows, Mac, and Linux. No tmux, no tunnels, no Docker, no cloud hosting.

## How It Works

```
You (Telegram) → Bot (polling) → spawn claude -p --resume <session>
                                    ↓
Claude Code → stream-json stdout → parse events → You (Telegram)
```

The bridge runs locally on your machine. Each message spawns `claude -p --resume <session_id>`, which continues your conversation. Responses stream back to Telegram in real-time as Claude works. Session ID is saved between messages, so you maintain full conversation context.

## Quick Start

```bash
git clone https://github.com/danielsimonjr/claude-code-telegram.git
cd claude-code-telegram
npm install
```

### Configure

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, copy the token
2. Get your user ID from [@userinfobot](https://t.me/userinfobot)
3. Create config:

```bash
mkdir -p ~/.claude-code-telegram
cat > ~/.claude-code-telegram/.env << EOF
TELEGRAM_BOT_TOKEN=your_token_here
ALLOWED_USERS=your_user_id_here
EOF
```

On Windows (PowerShell):
```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude-code-telegram"
@"
TELEGRAM_BOT_TOKEN=your_token_here
ALLOWED_USERS=your_user_id_here
"@ | Out-File "$env:USERPROFILE\.claude-code-telegram\.env" -Encoding utf8
```

### Run

```bash
node bridge.js [optional-working-directory]
```

Message your bot on Telegram. Claude Code starts on your first message.

## Features

- **Persistent conversations**: Each message continues the same conversation via `--resume`. Claude remembers everything you've discussed.
- **Real-time streaming**: See Claude's response as it's being generated, updated every 2 seconds in your Telegram chat.
- **Message queue**: Send multiple messages while Claude is working — they queue up and process in order.
- **Session management**: Start fresh conversations with `/new`, check status with `/status`.
- **Cross-platform**: Works on Windows, Mac, and Linux natively. No tmux or WSL required.

## Commands

| Command | What it does |
|---------|-------------|
| `/start` | Initialize and show info |
| `/status` | Session info, working directory, queue |
| `/new` | Start a fresh conversation (clears session) |
| `/stop` | Kill current Claude process |
| `/queue` | Show pending messages |
| `/help` | Show commands |
| *(any text)* | Send to Claude Code |

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
| `~/.claude-code-telegram/session.json` | Persistent session ID for --resume |
| `~/.claude-code-telegram/bridge.log` | Activity log |
| `~/.claude-code-telegram/history.jsonl` | Message history |

## Architecture

```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Telegram    │────▶│  bridge.js       │────▶│  claude -p      │
│  (phone)     │◀────│  (Node.js)       │◀────│  --resume <id>  │
└─────────────┘     │                  │     │  --stream-json   │
                    │  • polling API   │     └─────────────────┘
                    │  • message queue │
                    │  • stream parser │     ┌─────────────────┐
                    │  • session store │────▶│  session.json    │
                    └──────────────────┘     └─────────────────┘
```

Each Telegram message:
1. Gets queued (if Claude is busy) or starts immediately
2. Spawns `claude -p --resume <session_id> --output-format stream-json --verbose`
3. Pipes your message to Claude's stdin
4. Parses stream-json events from stdout
5. Sends streaming updates to Telegram every 2 seconds
6. Saves the session ID for the next message

## Security

- **User whitelist**: Only `ALLOWED_USERS` can interact with the bot
- **Local only**: The bridge runs on your machine — no cloud services except Telegram's API
- **No shell injection**: Claude is spawned with `child_process.spawn` (no shell interpolation)
- **Message logging**: All messages logged to `history.jsonl` for audit

## Prerequisites

- Node.js 18+
- Claude Code CLI installed and authenticated (`claude auth login`)
- A Telegram account

## Inspiration

- **[hanxiao/claudecode-telegram](https://github.com/hanxiao/claudecode-telegram)** — the original tmux + Stop hook idea
- **[RichardAtCT/claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram)** — session persistence and security features
- **[alexei-led/ccgram](https://github.com/alexei-led/ccgram)** — multi-session management

## License

MIT
