#!/usr/bin/env node
/**
 * Claude Code Telegram Bridge
 *
 * Bridges Telegram messages to Claude Code using --print mode.
 * Each message runs `claude --print -p "message"` and returns the output.
 * Works on Windows, Mac, and Linux.
 *
 * Inspired by:
 *   - hanxiao/claudecode-telegram (tmux + Stop hook architecture)
 *   - RichardAtCT/claude-code-telegram (session persistence, security)
 *   - alexei-led/ccgram (multi-session, terminal screenshots)
 */

const TelegramBot = require("node-telegram-bot-api");
const { execFile } = require("child_process");
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
const WORK_DIR =
  process.argv[2] || process.env.CLAUDE_WORK_DIR || process.cwd();
const MAX_MSG = 4000;
const CLAUDE_TIMEOUT = 300000; // 5 minutes max per request

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

// --- Claude --print mode ---
let isProcessing = false;
let messageQueue = [];

function runClaude(prompt, cwd) {
  return new Promise((resolve, reject) => {
    const args = ["--print", "-p", prompt];

    log(`Running: claude --print -p "${prompt.slice(0, 50)}..."`);

    execFile("claude", args, {
      cwd: cwd,
      timeout: CLAUDE_TIMEOUT,
      maxBuffer: 1024 * 1024 * 10, // 10MB
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
      shell: true,
    }, (error, stdout, stderr) => {
      if (error) {
        if (error.killed) {
          reject(new Error("Claude timed out (5 minute limit)"));
        } else {
          reject(new Error(`Claude error: ${error.message}`));
        }
        return;
      }
      resolve(stdout);
    });
  });
}

async function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;

  isProcessing = true;
  const { chatId, text } = messageQueue.shift();

  try {
    const response = await runClaude(text, WORK_DIR);
    const cleaned = cleanAnsi(response);

    if (cleaned) {
      logHistory("claude", "out", cleaned);
      await sendLong(chatId, cleaned);
    } else {
      await bot.sendMessage(chatId, "_(Claude returned empty response)_", {
        parse_mode: "Markdown",
      });
    }
  } catch (err) {
    log(`Error: ${err.message}`);
    await bot.sendMessage(chatId, `❌ ${err.message}`);
  }

  isProcessing = false;

  // Process next message in queue
  if (messageQueue.length > 0) {
    processQueue();
  }
}

function cleanAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .trim();
}

// --- Telegram Bot ---
const bot = new TelegramBot(BOT_TOKEN, {
  polling: { interval: 2000, autoStart: true },
});

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

async function sendLong(chatId, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    try {
      await bot.sendMessage(chatId, chunk, { parse_mode: "Markdown" });
    } catch {
      try {
        await bot.sendMessage(chatId, chunk);
      } catch (e2) {
        log(`Failed to send: ${e2.message}`);
      }
    }
  }
}

// --- Commands ---
bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    "🤖 *Claude Code Telegram Bridge*\n\n" +
      `📂 Working directory:\n\`${WORK_DIR}\`\n\n` +
      "Send any message and I'll run it through Claude Code.\n\n" +
      "*Commands:*\n" +
      "/status — Bridge info\n" +
      "/queue — Show message queue\n" +
      "/help — Show this message\n\n" +
      "_Each message runs as a separate `claude --print` call._",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, (msg) => {
  if (!isAllowed(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    `✅ Bridge running\n📂 \`${WORK_DIR}\`\n` +
      `⏳ Processing: ${isProcessing ? "yes" : "no"}\n` +
      `📋 Queue: ${messageQueue.length} messages`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/queue/, (msg) => {
  if (!isAllowed(msg)) return;
  if (messageQueue.length === 0) {
    bot.sendMessage(msg.chat.id, "📋 Queue is empty");
  } else {
    const items = messageQueue
      .map((m, i) => `${i + 1}. ${m.text.slice(0, 50)}...`)
      .join("\n");
    bot.sendMessage(msg.chat.id, `📋 *Queue:*\n${items}`, {
      parse_mode: "Markdown",
    });
  }
});

bot.onText(/\/help/, (msg) => {
  if (!isAllowed(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    "*Commands:*\n" +
      "/status — Bridge status and working directory\n" +
      "/queue — Show pending messages\n" +
      "/help — This message\n\n" +
      "Any other message goes to Claude Code.\n" +
      "_Responses may take 10-60 seconds depending on complexity._",
    { parse_mode: "Markdown" }
  );
});

// --- Main message handler ---
bot.on("message", async (msg) => {
  if (msg.text && msg.text.startsWith("/")) return;
  if (!isAllowed(msg)) {
    log(`Blocked: user ${msg.from.id}`);
    return;
  }
  if (!msg.text) return;

  const text = msg.text.trim();
  if (!text) return;

  log(`From ${msg.from.first_name} (${msg.from.id}): ${text.slice(0, 100)}`);
  logHistory(msg.from.id, "in", text);

  // Add to queue
  messageQueue.push({ chatId: msg.chat.id, text });

  if (isProcessing) {
    bot.sendMessage(
      msg.chat.id,
      `📋 Queued (position ${messageQueue.length}). Processing previous message...`
    );
  } else {
    bot.sendMessage(msg.chat.id, "📤 Sending to Claude...");
    processQueue();
  }
});

// --- Error handling ---
bot.on("polling_error", (err) => {
  // Only log non-conflict errors (conflicts happen when restarting)
  if (!err.message.includes("409 Conflict")) {
    log(`Polling error: ${err.message}`);
  }
});

// --- Graceful shutdown ---
process.on("SIGINT", () => {
  log("Shutting down");
  bot.stopPolling();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Terminated");
  bot.stopPolling();
  process.exit(0);
});

log("Bridge ready. Message your bot on Telegram.");
