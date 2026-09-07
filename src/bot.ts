/**
 * The Telegram bot: commands, the message queue, and delivery.
 *
 * `createBridge` returns the bot without starting it, so construction can be tested
 * and the caller decides when polling begins.
 */
import { Bot, type Context } from "grammy";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { STREAM_INTERVAL_MS, type Config } from "./config.js";
import { log, logHistory } from "./log.js";
import { loadSession, saveSession, type SessionData } from "./session.js";
import { runClaudeTurn } from "./claude.js";
import { splitMessage, MAX_MSG } from "./text.js";

/** A message waiting to be sent to Claude. */
interface QueuedMessage {
  chatId: number;
  text: string;
  userId: string;
}

/**
 * Decide whether a user may drive the bridge.
 *
 * An EMPTY allow-list permits everyone. That is the historical default and is
 * preserved here deliberately rather than silently tightened, but it means an
 * unconfigured bridge lets any Telegram user run Claude Code on the host. The startup
 * banner warns about it; changing the default is a security decision, not a cleanup.
 *
 * A message with no sender is refused whenever an allow-list exists, because there is
 * nothing to check it against.
 */
export function isAllowed(
  allowedUsers: string[],
  from: { id: number | string } | undefined,
): boolean {
  if (allowedUsers.length === 0) return true;
  if (!from) return false;
  return allowedUsers.includes(String(from.id));
}

/** Everything the running bridge owns. */
export interface Bridge {
  bot: Bot;
  start: () => void;
  shutdown: (signal: string) => void;
}

/** Build the bridge. Does not connect to Telegram until `start` is called. */
export function createBridge(config: Config): Bridge {
  const bot = new Bot(config.botToken);

  let session: SessionData = loadSession();
  let processing = false;
  const queue: QueuedMessage[] = [];
  let activeChild: ChildProcessWithoutNullStreams | null = null;

  /** Send one chunk, falling back to plain text if Markdown will not parse. */
  async function sendChunk(chatId: number, text: string): Promise<void> {
    try {
      await bot.api.sendMessage(chatId, text, { parse_mode: "Markdown" });
    } catch {
      try {
        await bot.api.sendMessage(chatId, text);
      } catch (e) {
        log(`Failed to send chunk: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** Send text of any length, split across as many messages as it needs. */
  async function sendLong(chatId: number, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) await sendChunk(chatId, chunk);
  }

  /** Run the next queued message, then continue until the queue drains. */
  async function processQueue(): Promise<void> {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        await runOne(next);
      }
    } finally {
      // Without this in a finally, an unexpected throw would leave `processing`
      // stuck true and the bridge would silently accept messages forever without
      // ever running another one.
      processing = false;
    }
  }

  /** Run a single queued message end to end. */
  async function runOne({ chatId, text }: QueuedMessage): Promise<void> {
    let statusMsgId: number | null = null;
    let lastSent = "";

    try {
      const result = await runClaudeTurn(
        text,
        {
          workDir: config.workDir,
          sessionId: session.sessionId ?? null,
          streamIntervalMs: STREAM_INTERVAL_MS,
        },
        {
          onSpawn: (child) => {
            activeChild = child;
          },
          onProgress: (progress) => {
            void streamUpdate(progress);
          },
        },
      );

      if (result.sessionId) {
        session = {
          sessionId: result.sessionId,
          lastActive: Date.now(),
          workDir: config.workDir,
        };
        saveSession(session);
      }

      if (!result.text) {
        await bot.api.sendMessage(chatId, "_(Claude returned empty response)_", {
          parse_mode: "Markdown",
        });
        return;
      }

      logHistory("claude", "out", result.text);
      const chunks = splitMessage(result.text);
      const [first, ...rest] = chunks;

      if (statusMsgId !== null && first !== undefined) {
        // Replace the streaming placeholder with the finished first chunk.
        try {
          await bot.api.editMessageText(chatId, statusMsgId, first, {
            parse_mode: "Markdown",
          });
        } catch {
          try {
            await bot.api.editMessageText(chatId, statusMsgId, first);
          } catch {
            await sendChunk(chatId, first);
          }
        }
        for (const chunk of rest) await sendChunk(chatId, chunk);
      } else {
        await sendLong(chatId, result.text);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`Error: ${message}`);
      await bot.api.sendMessage(chatId, `Error: ${message}`);
    } finally {
      activeChild = null;
    }

    /** Push an in-progress preview, creating or editing the placeholder message. */
    async function streamUpdate(progress: string): Promise<void> {
      // Only update when there is meaningfully more to show; every edit is an API
      // call and Telegram rate-limits them.
      if (progress.length <= lastSent.length + 20) return;
      const preview = progress.slice(0, MAX_MSG);
      try {
        if (statusMsgId !== null) {
          await bot.api.editMessageText(
            chatId,
            statusMsgId,
            `${preview}\n\n_... streaming ..._`,
            { parse_mode: "Markdown" },
          );
        } else {
          const sent = await bot.api.sendMessage(
            chatId,
            `${preview}\n\n_... streaming ..._`,
            { parse_mode: "Markdown" },
          );
          statusMsgId = sent.message_id;
        }
        lastSent = progress;
      } catch {
        if (statusMsgId === null) return;
        try {
          await bot.api.editMessageText(
            chatId,
            statusMsgId,
            `${preview}\n\n... streaming ...`,
          );
          lastSent = progress;
        } catch {
          // Leave the placeholder as it is; the final message still lands.
        }
      }
    }
  }

  /** Guard a command handler with the allow-list. */
  function guarded(handler: (ctx: Context) => unknown) {
    return (ctx: Context) => {
      if (!isAllowed(config.allowedUsers, ctx.from)) return;
      return handler(ctx);
    };
  }

  bot.command(
    "start",
    guarded((ctx) => {
      const info = session.sessionId
        ? `\nConversation: \`${session.sessionId.slice(0, 8)}...\``
        : "\n_No active conversation (will start on first message)_";
      return ctx.reply(
        "Claude Code Telegram Bridge\n\n" +
          `Working directory: \`${config.workDir}\`${info}\n\n` +
          "Send any message and Claude will respond with full conversation memory.\n\n" +
          "*Commands:*\n" +
          "/status — Bridge and session info\n" +
          "/new — Start a new conversation\n" +
          "/queue — Show message queue\n" +
          "/stop — Cancel current Claude process\n" +
          "/help — Show this message",
        { parse_mode: "Markdown" },
      );
    }),
  );

  bot.command(
    "status",
    guarded((ctx) =>
      ctx.reply(
        "Bridge running\n" +
          `Working directory: \`${config.workDir}\`\n` +
          `Session: ${session.sessionId ? `\`${session.sessionId.slice(0, 8)}...\`` : "none"}\n` +
          `Last active: ${session.lastActive ? new Date(session.lastActive).toLocaleString() : "never"}\n` +
          `Processing: ${processing ? "yes" : "no"}\n` +
          `Queue: ${queue.length} messages`,
        { parse_mode: "Markdown" },
      ),
    ),
  );

  bot.command(
    "new",
    guarded((ctx) => {
      const previous = session.sessionId;
      session = {};
      saveSession(session);
      return ctx.reply(
        "New conversation started.\n" +
          (previous ? `Previous session: \`${previous.slice(0, 8)}...\`` : "_(no previous session)_"),
        { parse_mode: "Markdown" },
      );
    }),
  );

  bot.command(
    "stop",
    guarded((ctx) => {
      if (!activeChild) return ctx.reply("No active Claude process.");
      activeChild.kill("SIGTERM");
      return ctx.reply("Sent stop signal to Claude.");
    }),
  );

  bot.command(
    "queue",
    guarded((ctx) => {
      if (queue.length === 0) return ctx.reply("Queue is empty.");
      const items = queue.map((m, i) => `${i + 1}. ${m.text.slice(0, 50)}...`).join("\n");
      return ctx.reply(`*Queue:*\n${items}`, { parse_mode: "Markdown" });
    }),
  );

  bot.command(
    "help",
    guarded((ctx) =>
      ctx.reply(
        "*Commands:*\n" +
          "/status — Bridge status, session, working directory\n" +
          "/new — Start a fresh conversation (clears session)\n" +
          "/stop — Cancel current Claude process\n" +
          "/queue — Show pending messages\n" +
          "/help — This message\n\n" +
          "Any other message goes to Claude Code.\n" +
          "Conversation memory persists between messages via --resume.\n" +
          "_Responses stream in real-time as Claude works._",
        { parse_mode: "Markdown" },
      ),
    ),
  );

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;

    if (!isAllowed(config.allowedUsers, ctx.from)) {
      log(`Blocked: user ${ctx.from?.id ?? "unknown"}`);
      return;
    }

    const userId = String(ctx.from?.id ?? "unknown");
    log(`From ${ctx.from?.first_name ?? "unknown"} (${userId}): ${text.slice(0, 100)}`);
    logHistory(userId, "in", text);

    queue.push({ chatId: ctx.chat.id, text, userId });

    if (processing) {
      await ctx.reply(
        `Queued (position ${queue.length}). Processing previous message...`,
      );
    } else {
      void processQueue();
    }
  });

  bot.catch((err) => {
    const inner: unknown = err.error ?? err;
    const message = inner instanceof Error ? inner.message : String(inner);
    // 409 means another poller holds the update stream; it is noisy and expected
    // while restarting, so it is not worth a log line every second.
    if (!message.includes("409 Conflict")) log(`Bot error: ${message}`);
  });

  function shutdown(signal: string): void {
    log(`${signal} — shutting down`);
    if (activeChild) activeChild.kill("SIGTERM");
    void bot.stop();
  }

  function start(): void {
    void bot.start({
      drop_pending_updates: true,
      onStart: () => log("Bridge ready. Message your bot on Telegram."),
    });
  }

  return { bot, start, shutdown };
}
