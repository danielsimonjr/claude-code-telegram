/**
 * Configuration: where state lives, and how the environment is read.
 *
 * `loadEnvInto` and `parseAllowedUsers` are pure enough to test directly. The old
 * code read the environment and called `process.exit(1)` at module load, so importing
 * any part of the bridge could terminate the importing process.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Directory holding the env file, logs, history and session state. */
export const CONFIG_DIR = join(homedir(), ".claude-code-telegram");
export const ENV_FILE = join(CONFIG_DIR, ".env");
export const LOG_FILE = join(CONFIG_DIR, "bridge.log");
export const HISTORY_FILE = join(CONFIG_DIR, "history.jsonl");
export const SESSION_FILE = join(CONFIG_DIR, "session.json");

/** Send a streaming update to Telegram at most this often. */
export const STREAM_INTERVAL_MS = 2000;
/** Give up on a single Claude turn after this long. */
export const CLAUDE_TIMEOUT_MS = 600_000;

/** Resolved runtime configuration. */
export interface Config {
  botToken: string;
  /** Telegram user ids permitted to use the bridge. Empty means everyone. */
  allowedUsers: string[];
  workDir: string;
}

/** Create the config directory if it is not already there. */
export function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
}

/**
 * Parse `KEY=value` lines into a target environment object.
 *
 * Existing values win, so a variable already set in the real environment is never
 * overwritten by the file. Blank lines and `#` comments are skipped, and one layer of
 * surrounding quotes is removed.
 */
export function loadEnvInto(
  contents: string,
  target: Record<string, string | undefined>,
): void {
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (target[key] === undefined) target[key] = value;
  }
}

/** Read the env file, then the working directory's `.env`, into `process.env`. */
export function loadEnvFiles(cwd: string = process.cwd()): void {
  for (const path of [ENV_FILE, join(cwd, ".env")]) {
    if (!existsSync(path)) continue;
    loadEnvInto(readFileSync(path, "utf-8"), process.env);
  }
}

/**
 * Parse the allow-list.
 *
 * Ids are kept as strings because Telegram ids exceed the safe integer range in some
 * accounts, and they are only ever compared for equality.
 */
export function parseAllowedUsers(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Build the configuration from the environment.
 *
 * Returns a reason instead of exiting, so the caller decides what to do. Exiting from
 * inside a module made every path through startup untestable.
 */
export function readConfig(argv: string[] = process.argv): Config | { error: string } {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    return {
      error:
        "TELEGRAM_BOT_TOKEN not set.\n" +
        `Create ${ENV_FILE} with:\n` +
        "  TELEGRAM_BOT_TOKEN=your_token\n" +
        "  ALLOWED_USERS=your_telegram_user_id",
    };
  }

  return {
    botToken,
    allowedUsers: parseAllowedUsers(process.env.ALLOWED_USERS),
    workDir: argv[2] ?? process.env.CLAUDE_WORK_DIR ?? process.cwd(),
  };
}
