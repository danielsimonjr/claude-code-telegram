#!/usr/bin/env node
/**
 * Claude Code Telegram Bridge
 *
 * Bridges Telegram messages to a persistent Claude Code conversation.
 * Uses --output-format stream-json for real-time streaming to Telegram,
 * and --resume to maintain conversation continuity across messages.
 * Works on Windows, Mac, and Linux — no tmux required.
 *
 * Architecture:
 *   Telegram message → spawn claude -p --resume <id> → stream-json stdout
 *   → parse events → stream text chunks to Telegram → save session_id
 *
 * Inspired by:
 *   - hanxiao/claudecode-telegram
 *   - RichardAtCT/claude-code-telegram
 *   - alexei-led/ccgram
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
const SESSION_FILE = path.join(CONFIG_DIR, "session.json");

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
const MAX_MSG = 4000; // Telegram message limit
const STREAM_INTERVAL = 2000; // Send streaming updates every 2s
const CLAUDE_TIMEOUT = 600000; // 10 minutes max per request

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
    text: text.slice(0, 2000),
  };
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
}

// --- Session persistence ---
function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      return JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    }
  } catch {
    // ignore corrupt file
  }
  return {};
}

function saveSession(data) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
}

let sessionData = loadSession();

// --- Claude process management ---
let isProcessing = false;
let messageQueue = [];
let activeChild = null;

function buildClaudeArgs() {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];

  // Resume conversation if we have a session
  if (sessionData.sessionId) {
    args.push("--resume", sessionData.sessionId);
  }

  return args;
}

function cleanAnsi(text) {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .trim();
}

/**
 * Run a single Claude turn with streaming output.
 * Spawns claude -p, pipes prompt via stdin, parses stream-json events,
 * and sends periodic updates + final response to Telegram.
 */
function runClaudeTurn(chatId, prompt) {
  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs();
    log(
      `Spawning: claude ${args.join(" ")} (prompt: ${prompt.length} chars)`
    );

    const child = spawn("claude", args, {
      cwd: WORK_DIR,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });

    activeChild = child;

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();

    let stdoutBuf = "";
    let fullText = "";
    let lastSentText = "";
    let statusMsgId = null;
    let turnSessionId = null;
    let streamTimer = null;
    let toolUseEvents = [];

    // Periodically send streaming updates to Telegram
    async function sendStreamUpdate() {
      const cleaned = cleanAnsi(fullText);
      if (cleaned.length > lastSentText.length + 20) {
        // Only update if meaningful new content
        const preview = cleaned.slice(0, MAX_MSG);
        try {
          if (statusMsgId) {
            await bot.editMessageText(preview + "\n\n_... streaming ..._", {
              chat_id: chatId,
              message_id: statusMsgId,
              parse_mode: "Markdown",
            });
          } else {
            const sent = await bot.sendMessage(
              chatId,
              preview + "\n\n_... streaming ..._",
              { parse_mode: "Markdown" }
            );
            statusMsgId = sent.message_id;
          }
          lastSentText = cleaned;
        } catch {
          // Markdown parse fail — try plain text
          try {
            if (statusMsgId) {
              await bot.editMessageText(preview + "\n\n... streaming ...", {
                chat_id: chatId,
                message_id: statusMsgId,
              });
            }
          } catch {
            // ignore edit failures
          }
        }
      }
    }

    streamTimer = setInterval(sendStreamUpdate, STREAM_INTERVAL);

    // Timeout
    const timeout = setTimeout(() => {
      log("Claude timeout — killing process");
      child.kill("SIGTERM");
      reject(new Error("Claude timed out after 10 minutes"));
    }, CLAUDE_TIMEOUT);

    // Parse stdout stream-json events
    child.stdout.on("data", (data) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          handleStreamEvent(event);
        } catch {
          // non-JSON line, ignore
        }
      }
    });

    function handleStreamEvent(event) {
      switch (event.type) {
        case "system":
          if (event.subtype === "init" && event.session_id) {
            turnSessionId = event.session_id;
            log(`Session: ${turnSessionId}`);
          }
          break;

        case "assistant":
          // Extract text content from assistant message
          if (event.message && event.message.content) {
            for (const block of event.message.content) {
              if (block.type === "text") {
                fullText += block.text;
              }
            }
          }
          break;

        case "result":
          // Turn complete
          if (event.session_id) {
            turnSessionId = event.session_id;
          }
          if (event.result) {
            // Use the final result text if available
            fullText = event.result;
          }
          break;
      }
    }

    child.stderr.on("data", (data) => {
      const err = data.toString().trim();
      if (err) log(`Claude stderr: ${err.slice(0, 200)}`);
    });

    child.on("error", (err) => {
      clearInterval(streamTimer);
      clearTimeout(timeout);
      activeChild = null;
      log(`Spawn error: ${err.message}`);
      reject(new Error(`Failed to start Claude: ${err.message}`));
    });

    child.on("close", async (code) => {
      clearInterval(streamTimer);
      clearTimeout(timeout);
      activeChild = null;

      // Save session for resume
      if (turnSessionId) {
        sessionData.sessionId = turnSessionId;
        sessionData.lastActive = Date.now();
        sessionData.workDir = WORK_DIR;
        saveSession(sessionData);
      }

      if (code !== 0 && code !== null) {
        log(`Claude exited with code ${code}`);
        reject(new Error(`Claude exited with code ${code}`));
        return;
      }

      const cleaned = cleanAnsi(fullText);
      log(`Claude done (${cleaned.length} chars, session: ${turnSessionId})`);
      resolve({ text: cleaned, sessionId: turnSessionId, statusMsgId });
    });
  });
}

async function processQueue() {
  if (isProcessing || messageQueue.length === 0) return;

  isProcessing = true;
  const { chatId, text, userId } = messageQueue.shift();

  try {
    const result = await runClaudeTurn(chatId, text);

    if (result.text) {
      logHistory("claude", "out", result.text);

      // Send final response (edit streaming message or send new)
      if (result.statusMsgId) {
        // Edit the streaming message with final text
        const chunks = splitMessage(result.text);
        try {
          await bot.editMessageText(chunks[0], {
            chat_id: chatId,
            message_id: result.statusMsgId,
            parse_mode: "Markdown",
          });
        } catch {
          try {
            await bot.editMessageText(chunks[0], {
              chat_id: chatId,
              message_id: result.statusMsgId,
            });
          } catch {
            // fallback: send new message
            await sendLong(chatId, result.text);
          }
        }
        // Send remaining chunks as new messages
        for (let i = 1; i < chunks.length; i++) {
          await sendChunk(chatId, chunks[i]);
        }
      } else {
        await sendLong(chatId, result.text);
      }
    } else {
      await bot.sendMessage(chatId, "_(Claude returned empty response)_", {
        parse_mode: "Markdown",
      });
    }
  } catch (err) {
    log(`Error: ${err.message}`);
    await bot.sendMessage(chatId, `Error: ${err.message}`);
  }

  isProcessing = false;

  if (messageQueue.length > 0) {
    processQueue();
  }
}

// --- Telegram helpers ---
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

async function sendChunk(chatId, text) {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch {
    try {
      await bot.sendMessage(chatId, text);
    } catch (e) {
      log(`Failed to send chunk: ${e.message}`);
    }
  }
}

async function sendLong(chatId, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await sendChunk(chatId, chunk);
  }
}

// --- Error handling ---
process.on("unhandledRejection", (err) => {
  log(`[ERROR] Unhandled rejection: ${err.message || err}`);
});

// --- Telegram Bot ---
// Clear stale polling sessions before starting
const https = require("https");
const clearUrl = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=-1`;
https.get(clearUrl, () => {
  log("Cleared stale Telegram updates");
});

const bot = new TelegramBot(BOT_TOKEN, {
  polling: { interval: 1000, autoStart: true, params: { timeout: 30 } },
});

log(`Bridge starting. Working directory: ${WORK_DIR}`);
log(
  `Allowed users: ${ALLOWED_USERS.length > 0 ? ALLOWED_USERS.join(", ") : "(anyone)"}`
);
if (sessionData.sessionId) {
  log(`Resuming session: ${sessionData.sessionId}`);
}

function isAllowed(msg) {
  if (ALLOWED_USERS.length === 0) return true;
  return ALLOWED_USERS.includes(String(msg.from.id));
}

// --- Commands ---
bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg)) return;
  const sessionInfo = sessionData.sessionId
    ? `\nConversation: \`${sessionData.sessionId.slice(0, 8)}...\``
    : "\n_No active conversation (will start on first message)_";
  bot.sendMessage(
    msg.chat.id,
    "Claude Code Telegram Bridge\n\n" +
      `Working directory: \`${WORK_DIR}\`${sessionInfo}\n\n` +
      "Send any message and Claude will respond with full conversation memory.\n\n" +
      "*Commands:*\n" +
      "/status — Bridge and session info\n" +
      "/new — Start a new conversation\n" +
      "/queue — Show message queue\n" +
      "/stop — Cancel current Claude process\n" +
      "/help — Show this message",
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/status/, (msg) => {
  if (!isAllowed(msg)) return;
  const session = sessionData.sessionId
    ? `\`${sessionData.sessionId.slice(0, 8)}...\``
    : "none";
  const lastActive = sessionData.lastActive
    ? new Date(sessionData.lastActive).toLocaleString()
    : "never";
  bot.sendMessage(
    msg.chat.id,
    `Bridge running\n` +
      `Working directory: \`${WORK_DIR}\`\n` +
      `Session: ${session}\n` +
      `Last active: ${lastActive}\n` +
      `Processing: ${isProcessing ? "yes" : "no"}\n` +
      `Queue: ${messageQueue.length} messages`,
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/new/, (msg) => {
  if (!isAllowed(msg)) return;
  const oldSession = sessionData.sessionId;
  sessionData = {};
  saveSession(sessionData);
  bot.sendMessage(
    msg.chat.id,
    `New conversation started.\n` +
      (oldSession
        ? `Previous session: \`${oldSession.slice(0, 8)}...\``
        : "_(no previous session)_"),
    { parse_mode: "Markdown" }
  );
});

bot.onText(/\/stop/, (msg) => {
  if (!isAllowed(msg)) return;
  if (activeChild) {
    activeChild.kill("SIGTERM");
    bot.sendMessage(msg.chat.id, "Sent stop signal to Claude.");
  } else {
    bot.sendMessage(msg.chat.id, "No active Claude process.");
  }
});

bot.onText(/\/queue/, (msg) => {
  if (!isAllowed(msg)) return;
  if (messageQueue.length === 0) {
    bot.sendMessage(msg.chat.id, "Queue is empty.");
  } else {
    const items = messageQueue
      .map((m, i) => `${i + 1}. ${m.text.slice(0, 50)}...`)
      .join("\n");
    bot.sendMessage(msg.chat.id, `*Queue:*\n${items}`, {
      parse_mode: "Markdown",
    });
  }
});

bot.onText(/\/help/, (msg) => {
  if (!isAllowed(msg)) return;
  bot.sendMessage(
    msg.chat.id,
    "*Commands:*\n" +
      "/status — Bridge status, session, working directory\n" +
      "/new — Start a fresh conversation (clears session)\n" +
      "/stop — Cancel current Claude process\n" +
      "/queue — Show pending messages\n" +
      "/help — This message\n\n" +
      "Any other message goes to Claude Code.\n" +
      "Conversation memory persists between messages via --resume.\n" +
      "_Responses stream in real-time as Claude works._",
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

  messageQueue.push({ chatId: msg.chat.id, text, userId: msg.from.id });

  if (isProcessing) {
    bot.sendMessage(
      msg.chat.id,
      `Queued (position ${messageQueue.length}). Processing previous message...`
    );
  } else {
    processQueue();
  }
});

// --- Error handling ---
bot.on("polling_error", (err) => {
  if (!err.message.includes("409 Conflict")) {
    log(`Polling error: ${err.message}`);
  }
});

// --- Graceful shutdown ---
function shutdown(signal) {
  log(`${signal} — shutting down`);
  if (activeChild) activeChild.kill("SIGTERM");
  bot.stopPolling();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

log("Bridge ready. Message your bot on Telegram.");
