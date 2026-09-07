/**
 * Session persistence.
 *
 * The bridge keeps one Claude conversation alive across Telegram messages by storing
 * the session id and replaying it with `--resume`.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { SESSION_FILE } from "./config.js";

/** What is remembered between runs. */
export interface SessionData {
  sessionId?: string;
  lastActive?: number;
  workDir?: string;
}

/**
 * Read the stored session.
 *
 * A missing, unreadable or corrupt file yields an empty session rather than an error:
 * losing conversation continuity is a far smaller failure than refusing to start.
 */
export function loadSession(path: string = SESSION_FILE): SessionData {
  try {
    if (!existsSync(path)) return {};
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    // JSON.parse happily returns null, a number or an array. Any of those would give
    // a SessionData-shaped variable that is not an object.
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as SessionData;
  } catch {
    return {};
  }
}

/**
 * Write the session.
 *
 * Written to a temporary file and renamed, because rename is atomic on the same
 * volume. A direct write that is interrupted leaves a truncated file, which is
 * exactly the corrupt state `loadSession` then has to absorb.
 */
export function saveSession(data: SessionData, path: string = SESSION_FILE): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}
