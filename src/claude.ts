/**
 * Running one Claude turn and interpreting its `stream-json` output.
 *
 * The event interpretation is a pure reducer (`applyStreamEvent`) so the parsing can
 * be tested against recorded event shapes without spawning anything. Only
 * `runClaudeTurn` touches a process.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { CLAUDE_TIMEOUT_MS } from "./config.js";
import { cleanAnsi } from "./text.js";
import { log } from "./log.js";

/** Accumulated state of one turn. */
export interface TurnState {
  /** Assistant text seen so far. */
  fullText: string;
  /** Session id reported by Claude, used to resume the next turn. */
  sessionId: string | null;
}

/** A `stream-json` event. Only the fields the bridge reads are described. */
export interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  message?: { content?: Array<{ type?: string; text?: string }> };
}

/** The empty state a turn starts from. */
export function initialTurnState(): TurnState {
  return { fullText: "", sessionId: null };
}

/**
 * Fold one stream event into the turn state.
 *
 * Returns a new state rather than mutating, so a caller can reason about the
 * sequence. `result` REPLACES the accumulated text: Claude's final result is
 * authoritative and already complete, whereas the assistant deltas may include
 * partial content.
 */
export function applyStreamEvent(state: TurnState, event: StreamEvent): TurnState {
  switch (event.type) {
    case "system":
      if (event.subtype === "init" && event.session_id) {
        return { ...state, sessionId: event.session_id };
      }
      return state;

    case "assistant": {
      const blocks = event.message?.content;
      if (!blocks) return state;
      let added = "";
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string") added += block.text;
      }
      return added ? { ...state, fullText: state.fullText + added } : state;
    }

    case "result": {
      const next: TurnState = { ...state };
      if (event.session_id) next.sessionId = event.session_id;
      if (typeof event.result === "string") next.fullText = event.result;
      return next;
    }

    default:
      return state;
  }
}

/** Arguments for `claude -p`, resuming the stored session when there is one. */
export function buildClaudeArgs(sessionId: string | null | undefined): string[] {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

/** Outcome of a completed turn. */
export interface TurnResult {
  text: string;
  sessionId: string | null;
}

/** Callbacks the caller supplies to observe progress. */
export interface TurnHooks {
  /** Called periodically with the text so far, for streaming updates. */
  onProgress?: (text: string) => void;
  /** Receives the spawned child so the caller can cancel it. */
  onSpawn?: (child: ChildProcessWithoutNullStreams) => void;
}

/**
 * Run a single Claude turn, streaming progress and resolving with the final text.
 *
 * Rejects if Claude cannot be started, times out, or exits non-zero.
 */
export function runClaudeTurn(
  prompt: string,
  options: {
    workDir: string;
    sessionId: string | null;
    streamIntervalMs: number;
    timeoutMs?: number;
  },
  hooks: TurnHooks = {},
): Promise<TurnResult> {
  const { workDir, sessionId, streamIntervalMs, timeoutMs = CLAUDE_TIMEOUT_MS } = options;

  return new Promise((resolve, reject) => {
    const args = buildClaudeArgs(sessionId);
    log(`Spawning: claude ${args.join(" ")} (prompt: ${prompt.length} chars)`);

    const child = spawn("claude", args, {
      cwd: workDir,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    hooks.onSpawn?.(child);

    let state = initialTurnState();
    let stdoutBuf = "";
    let settled = false;

    const streamTimer = setInterval(() => {
      hooks.onProgress?.(cleanAnsi(state.fullText));
    }, streamIntervalMs);

    const timeoutTimer = setTimeout(() => {
      log("Claude timeout — killing process");
      child.kill("SIGTERM");
      finish(() => reject(new Error(`Claude timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    /** Clear timers once, then run the settling action. */
    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      clearInterval(streamTimer);
      clearTimeout(timeoutTimer);
      action();
    }

    child.stdin.write(prompt);
    child.stdin.end();

    child.stdout.on("data", (data: Buffer) => {
      stdoutBuf += data.toString();
      const lines = stdoutBuf.split("\n");
      // The final element is an incomplete line; keep it for the next chunk.
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          state = applyStreamEvent(state, JSON.parse(line) as StreamEvent);
        } catch {
          // Not a complete JSON frame; Claude also writes plain lines.
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const err = data.toString().trim();
      if (err) log(`Claude stderr: ${err.slice(0, 200)}`);
    });

    child.on("error", (err: Error) => {
      log(`Spawn error: ${err.message}`);
      finish(() => reject(new Error(`Failed to start Claude: ${err.message}`)));
    });

    child.on("close", (code) => {
      if (code !== 0 && code !== null) {
        log(`Claude exited with code ${code}`);
        finish(() => reject(new Error(`Claude exited with code ${code}`)));
        return;
      }
      const text = cleanAnsi(state.fullText);
      log(`Claude done (${text.length} chars, session: ${state.sessionId})`);
      finish(() => resolve({ text, sessionId: state.sessionId }));
    });
  });
}
