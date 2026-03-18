#!/usr/bin/env node
/**
 * Claude Code Telegram Bridge
 *
 * Bridges Telegram messages to a running Claude Code session via tmux.
 * Uses polling (no tunnel needed) and Claude's Stop hook for responses.
 *
 * Inspired by:
 *   - hanxiao/claudecode-telegram (tmux + Stop hook architecture)
 *   - RichardAtCT/claude-code-telegram (session persistence, security)
 *   - alexei-led/ccgram (multi-session, terminal screenshots)
 *
 * Usage:
 *   1. Set TELEGRAM_BOT_TOKEN and ALLOWED_USERS in .env
 *   2. Start Claude Code in tmux: tmux new -s claude
 *   3. Run: node bridge.js
 *   4. Message your bot on Telegram
 */

const TelegramBot = require("node-telegram-bot-api");
const { execFileSync, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// --- Configuration ---
const CONFIG_DIR = path.join(os.homedir(), ".claude-code-telegram");
const ENV_FILE = path.join(CONFIG_DIR, ".env");
const PENDING_FILE = path.join(CONFIG_DIR, ".pending");
const LOG_FILE = path.join(CONFIG_DIR, "bridge.log");
const HISTORY_FILE = path.join(CONFIG_DIR, "history.jsonl");

// Ensure config directory exists
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

// Load .env file
function loadEnv() {
  const envPaths = [ENV_FILE, path.join(process.cwd(), ".env")];
  for (const p of envPaths) {
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
          const eq = trimmed.indexOf("=");
          if (eq > 0) {
            const key = trimmed.slice(0, eq).trim();
            const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
            if (!process.env[key]) process.env[key] = val;
          }
        }
      }
    }
  }
}
loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USERS = (process.env.ALLOWED_USERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TMUX_SESSION = process.env.TMUX_SESSION || "claude";
const MAX_MESSAGE_LENGTH = 4000;

if (!BOT_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN not set.");
  console.error(
    `Create ${ENV_FILE} with:\n  TELEGRAM_BOT_TOKEN=your_token\n  ALLOWED_USERS=your_telegram_user_id`
  );
  process.exit(1);
}

// --- Logging ---
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function logHistory(userId, direction, text) {
  const entry = {
    ts: Date.now(),
    userId,
    direction,
    text: text.slice(0, 500),
  };
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
}

// --- tmux helpers (using execFileSync to avoid shell injection) ---
function tmuxExists() {
  try {
    execFileSync("tmux", ["has-session", "-t", TMUX_SESSION], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function tmuxSendKeys(text) {
  execFileSync("tmux", ["send-keys", "-t", TMUX_SESSION, text, "Enter"]);
}

function tmuxCapture(lines) {
  try {
    return execFileSync(
      "tmux",
      ["capture-pane", "-t", TMUX_SESSION, "-p", "-S", `-${lines || 200}`],
      { encoding: "utf-8", maxBuffer: 1024 * 1024 }
    );
  } catch {
    return "(could not capture tmux pane)";
  }
}

function tmuxSendCtrlC() {
  try {
    execFileSync("tmux", ["send-keys", "-t", TMUX_SESSION, "C-c"]);
  } catch {
    // ignore
  }
}

// --- Response handling via Stop hook ---
const RESPONSE_DIR = path.join(CONFIG_DIR, "responses");
if (!fs.existsSync(RESPONSE_DIR))
  fs.mkdirSync(RESPONSE_DIR, { recursive: true });

function getLatestResponse() {
  const responseFile = path.join(RESPONSE_DIR, "latest.txt");
  if (fs.existsSync(responseFile)) {
    const content = fs.readFileSync(responseFile, "utf-8");
    fs.unlinkSync(responseFile);
    return content;
  }
  return null;
}

// --- Telegram Bot ---
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

log(`Bridge starting. tmux session: ${TMUX_SESSION}`);
log(
  `Allowed users: ${ALLOWED_USERS.length > 0 ? ALLOWED_USERS.join(", ") : "(anyone)"}`
);

function isAllowed(msg) {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(String(msg.from.id));
}

function splitMessage(text) {
  const chunks = [];
  while (text.length > 0) {
    if (text.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(text);
      break;
    }
    let splitAt = text.lastIndexOf("\n", MAX_MESSAGE_LENGTH);
    if (splitAt < MAX_MESSAGE_LENGTH * 0.5) splitAt = MAX_MESSAGE_LENGTH;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt);
  }
  return chunks;
}

async function sendLong(chatId, text, opts) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, {
        parse_mode: "Markdown",
        ...(opts || {}),
      });
    } catch {
      await bot.sendMessage(chatId, chunk, opts || {});
    }
  }
}

let activeChatId = null;

// --- Commands ---
bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg)) return;
  activeChatId = msg.chat.id;
  bot.sendMessage(
    msg.chat.id,
    "🤖 *Claude Code Telegram Bridge*\n\n" +
      "Send me messages and I'll forward them to your Claude Code session.\n\n" +
      "*Commands:*\n" +
      "/status — Check tmux session\n" +
      "/screen — Capture terminal output\n" +
      "/stop — Send Ctrl+C to Claude\n" +
      "/clear — Clear conversation\n" +
      "/help — Show this message",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, (msg) => {
  if (!isAllowed(msg)) return;
  const exists = tmuxExists();
  const status = exists
    ? "✅ tmux session `" + TMUX_SESSION + "` is running"
    : "❌ No tmux session found";
  bot.sendMessage(msg.chat.id, status, { parse_mode: "Markdown" });
});

bot.onText(/\/screen/, async (msg) => {
  if (!isAllowed(msg)) return;
  const output = tmuxCapture(50);
  await sendLong(msg.chat.id, "```\n" + output.slice(-3500) + "\n```");
});

bot.onText(/\/stop/, (msg) => {
  if (!isAllowed(msg)) return;
  tmuxSendCtrlC();
  bot.sendMessage(msg.chat.id, "⛔ Sent Ctrl+C to Claude");
});

bot.onText(/\/clear/, (msg) => {
  if (!isAllowed(msg)) return;
  tmuxSendKeys("/clear");
  bot.sendMessage(msg.chat.id, "🧹 Sent /clear to Claude");
});

bot.onText(/\/help/, (msg) => {
  if (!isAllowed(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    "*Commands:*\n" +
      "/status — Check tmux session\n" +
      "/screen — Capture last 50 lines of terminal\n" +
      "/stop — Send Ctrl+C (interrupt Claude)\n" +
      "/clear — Clear Claude conversation\n" +
      "/help — This message\n\n" +
      "Any other message is sent directly to Claude Code.",
    { parse_mode: "Markdown" }
  );
});

// --- Main message handler ---
bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;
  if (!isAllowed(msg)) {
    log(`Blocked message from unauthorized user ${msg.from.id}`);
    return;
  }
  if (!msg.text) return;

  activeChatId = msg.chat.id;
  const text = msg.text.trim();
  if (!text) return;

  if (!tmuxExists()) {
    bot.sendMessage(
      msg.chat.id,
      "❌ No tmux session `" +
        TMUX_SESSION +
        "` found.\n\n" +
        "Start one with:\n`tmux new -s " +
        TMUX_SESSION +
        "`\nThen run `claude` inside it.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  log(
    `Message from ${msg.from.first_name} (${msg.from.id}): ${text.slice(0, 100)}`
  );
  logHistory(msg.from.id, "in", text);

  fs.writeFileSync(
    PENDING_FILE,
    JSON.stringify({ chatId: msg.chat.id, ts: Date.now(), text: text.slice(0, 100) })
  );

  tmuxSendKeys(text);
  bot.sendMessage(msg.chat.id, "📤 Sent to Claude. Waiting for response...");
});

// --- Poll for responses from Stop hook ---
setInterval(async () => {
  const response = getLatestResponse();
  if (response && activeChatId) {
    log(
      `Response received (${response.length} chars), sending to chat ${activeChatId}`
    );
    logHistory("claude", "out", response);
    await sendLong(activeChatId, response);

    if (fs.existsSync(PENDING_FILE)) fs.unlinkSync(PENDING_FILE);
  }
}, 1000);

// --- Graceful shutdown ---
process.on("SIGINT", () => {
  log("Bridge shutting down");
  bot.stopPolling();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Bridge terminated");
  bot.stopPolling();
  process.exit(0);
});

log("Bridge ready. Send a message to your Telegram bot.");
