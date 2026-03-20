#!/usr/bin/env node
/**
 * Claude Code Telegram Bridge
 *
 * Bridges Telegram messages to Claude Code. Works on Windows, Mac, and Linux.
 * Uses Telegram polling (no tunnel needed) and spawns Claude as a subprocess.
 *
 * Inspired by:
 *   - hanxiao/claudecode-telegram (tmux + Stop hook architecture)
 *   - RichardAtCT/claude-code-telegram (session persistence, security)
 *   - alexei-led/ccgram (multi-session, terminal screenshots)
 *
 * Usage:
 *   1. Set TELEGRAM_BOT_TOKEN and ALLOWED_USERS in ~/.claude-code-telegram/.env
 *   2. Run: node bridge.js [optional-working-directory]
 *   3. Message your bot on Telegram
 */

const TelegramBot = require("node-telegram-bot-api");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

// --- Configuration ---
const CONFIG_DIR = path.join(os.homedir(), ".claude-code-telegram");
const ENV_FILE = path.join(CONFIG_DIR, ".env");
const LOG_FILE = path.join(CONFIG_DIR, "bridge.log");
const HISTORY_FILE = path.join(CONFIG_DIR, "history.jsonl");

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

// Load .env
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
            const val = trimmed
              .slice(eq + 1)
              .trim()
              .replace(/^["']|["']$/g, "");
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
const WORK_DIR = process.argv[2] || process.env.CLAUDE_WORK_DIR || process.cwd();
const MAX_MSG = 4000;

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

// --- Claude Process Management ---
let claudeProcess = null;
let outputBuffer = "";
let isProcessing = false;
let responseTimeout = null;
let activeChatId = null;

function startClaude() {
  if (claudeProcess) {
    log("Claude process already running");
    return;
  }

  log(`Starting Claude Code in: ${WORK_DIR}`);

  claudeProcess = spawn("claude", ["--verbose"], {
    cwd: WORK_DIR,
    shell: true,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  claudeProcess.stdout.on("data", (data) => {
    const text = data.toString();
    outputBuffer += text;

    // Reset the response timeout (Claude is still outputting)
    if (responseTimeout) clearTimeout(responseTimeout);

    // Wait for Claude to finish (no output for 2 seconds)
    responseTimeout = setTimeout(() => {
      if (outputBuffer.trim() && activeChatId && isProcessing) {
        sendResponse(activeChatId, outputBuffer);
        outputBuffer = "";
        isProcessing = false;
      }
    }, 2000);
  });

  claudeProcess.stderr.on("data", (data) => {
    const text = data.toString();
    // Filter out noise, only log meaningful stderr
    if (
      text.trim() &&
      !text.includes("ExperimentalWarning") &&
      !text.includes("punycode")
    ) {
      log(`Claude stderr: ${text.slice(0, 200)}`);
    }
  });

  claudeProcess.on("close", (code) => {
    log(`Claude process exited with code ${code}`);
    claudeProcess = null;
    isProcessing = false;
    if (activeChatId) {
      bot.sendMessage(
        activeChatId,
        `⚠️ Claude process ended (code ${code}). Send any message to restart.`
      );
    }
  });

  claudeProcess.on("error", (err) => {
    log(`Claude process error: ${err.message}`);
    claudeProcess = null;
  });
}

function sendToClaude(text) {
  if (!claudeProcess || !claudeProcess.stdin.writable) {
    startClaude();
    // Wait a moment for startup
    setTimeout(() => {
      if (claudeProcess && claudeProcess.stdin.writable) {
        claudeProcess.stdin.write(text + "\n");
      }
    }, 2000);
    return;
  }
  claudeProcess.stdin.write(text + "\n");
}

function stopClaude() {
  if (claudeProcess) {
    claudeProcess.kill("SIGINT");
  }
}

// --- Telegram Bot ---
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

log(`Bridge starting. Working directory: ${WORK_DIR}`);
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
    if (text.length <= MAX_MSG) {
      chunks.push(text);
      break;
    }
    let splitAt = text.lastIndexOf("\n", MAX_MSG);
    if (splitAt < MAX_MSG * 0.5) splitAt = MAX_MSG;
    chunks.push(text.slice(0, splitAt));
    text = text.slice(splitAt);
  }
  return chunks;
}

async function sendResponse(chatId, text) {
  // Clean up ANSI escape codes and control characters
  const cleaned = text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .trim();

  if (!cleaned) return;

  logHistory("claude", "out", cleaned);
  const chunks = splitMessage(cleaned);

  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    } catch {
      // Fallback without markdown
      try {
        await bot.sendMessage(chatId, chunk);
      } catch (e2) {
        log(`Failed to send message: ${e2.message}`);
      }
    }
  }
}

// --- Commands ---
bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg)) return;
  activeChatId = msg.chat.id;
  bot.sendMessage(
    msg.chat.id,
    "🤖 *Claude Code Telegram Bridge*\n\n" +
      `Working directory: \`${WORK_DIR}\`\n\n` +
      "Send me messages and I'll forward them to Claude Code.\n\n" +
      "*Commands:*\n" +
      "/status — Check Claude process\n" +
      "/stop — Interrupt Claude (Ctrl+C)\n" +
      "/restart — Restart Claude process\n" +
      "/help — Show this message",
    { parse_mode: "Markdown" }
  );

  // Auto-start Claude
  if (!claudeProcess) startClaude();
});

bot.onText(/\/status/, (msg) => {
  if (!isAllowed(msg)) return;
  const running = claudeProcess !== null;
  const status = running
    ? `✅ Claude is running (PID: ${claudeProcess.pid})\n📂 \`${WORK_DIR}\``
    : "❌ Claude not running. Send any message to start.";
  bot.sendMessage(msg.chat.id, status, { parse_mode: "Markdown" });
});

bot.onText(/\/stop/, (msg) => {
  if (!isAllowed(msg)) return;
  stopClaude();
  bot.sendMessage(msg.chat.id, "⛔ Sent interrupt to Claude");
});

bot.onText(/\/restart/, (msg) => {
  if (!isAllowed(msg)) return;
  stopClaude();
  setTimeout(() => {
    startClaude();
    bot.sendMessage(msg.chat.id, "🔄 Claude restarted");
  }, 1000);
});

bot.onText(/\/help/, (msg) => {
  if (!isAllowed(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    "*Commands:*\n" +
      "/status — Check Claude process\n" +
      "/stop — Interrupt Claude (Ctrl+C)\n" +
      "/restart — Restart Claude process\n" +
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

  log(
    `Message from ${msg.from.first_name} (${msg.from.id}): ${text.slice(0, 100)}`
  );
  logHistory(msg.from.id, "in", text);

  // Start Claude if not running
  if (!claudeProcess) {
    bot.sendMessage(msg.chat.id, "🚀 Starting Claude Code...");
    startClaude();
    // Wait for startup then send
    setTimeout(() => {
      isProcessing = true;
      outputBuffer = "";
      sendToClaude(text);
    }, 3000);
    return;
  }

  isProcessing = true;
  outputBuffer = "";
  sendToClaude(text);
  bot.sendMessage(msg.chat.id, "📤 Sent to Claude...");
});

// --- Graceful shutdown ---
process.on("SIGINT", () => {
  log("Bridge shutting down");
  stopClaude();
  bot.stopPolling();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Bridge terminated");
  stopClaude();
  bot.stopPolling();
  process.exit(0);
});

log("Bridge ready. Message your bot on Telegram to start.");
