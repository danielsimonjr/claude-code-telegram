/**
 * Logging to stdout and to the bridge log file.
 *
 * A log write must never take the bridge down: the config directory can be read-only,
 * full, or on a disconnected network drive, and none of those are reasons to stop
 * relaying messages.
 */
import { appendFileSync } from "node:fs";
import { HISTORY_FILE, LOG_FILE } from "./config.js";

/** One line of conversation history. */
export interface HistoryEntry {
  ts: number;
  /** Telegram user id as a string, or "claude" for outbound messages. */
  userId: string;
  direction: "in" | "out";
  text: string;
}

/** Longest history entry text kept, to stop one huge reply filling the file. */
const HISTORY_TEXT_LIMIT = 2000;

/** Write a timestamped line to stdout and append it to the log file. */
export function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try {
    appendFileSync(LOG_FILE, `${line}\n`);
  } catch {
    // Already on stdout; a failed file append is not worth crashing over.
  }
}

/**
 * Append one entry to the conversation history.
 *
 * `userId` is a string in both directions. It used to be a number for inbound and the
 * literal "claude" for outbound, so the file held two types in one field and could
 * not be parsed without special-casing.
 */
export function logHistory(
  userId: string,
  direction: "in" | "out",
  text: string,
): void {
  const entry: HistoryEntry = {
    ts: Date.now(),
    userId,
    direction,
    text: text.slice(0, HISTORY_TEXT_LIMIT),
  };
  try {
    appendFileSync(HISTORY_FILE, `${JSON.stringify(entry)}\n`);
  } catch {
    // History is a convenience, not a guarantee.
  }
}
