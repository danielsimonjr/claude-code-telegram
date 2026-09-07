import { describe, it, expect } from "vitest";
import {
  applyStreamEvent,
  buildClaudeArgs,
  initialTurnState,
  type StreamEvent,
  type TurnState,
} from "../src/claude.js";

/** Fold a sequence of events, the way the stdout handler does. */
function fold(events: StreamEvent[]): TurnState {
  return events.reduce(applyStreamEvent, initialTurnState());
}

describe("buildClaudeArgs", () => {
  it("omits --resume when there is no session", () => {
    expect(buildClaudeArgs(null)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
  });

  it("resumes when a session id is known", () => {
    expect(buildClaudeArgs("abc123")).toContain("--resume");
    expect(buildClaudeArgs("abc123")).toContain("abc123");
  });

  it("treats an empty session id as no session", () => {
    // An empty string would produce `--resume ""`, which is not a valid session.
    expect(buildClaudeArgs("")).not.toContain("--resume");
  });
});

describe("applyStreamEvent", () => {
  it("captures the session id from the init event", () => {
    expect(fold([{ type: "system", subtype: "init", session_id: "s1" }]).sessionId).toBe(
      "s1",
    );
  });

  it("ignores a system event that is not init", () => {
    expect(fold([{ type: "system", subtype: "other", session_id: "s1" }]).sessionId).toBe(
      null,
    );
  });

  it("accumulates text across assistant events", () => {
    const state = fold([
      { type: "assistant", message: { content: [{ type: "text", text: "one " }] } },
      { type: "assistant", message: { content: [{ type: "text", text: "two" }] } },
    ]);
    expect(state.fullText).toBe("one two");
  });

  it("ignores non-text content blocks", () => {
    const state = fold([
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use" },
            { type: "text", text: "kept" },
          ],
        },
      },
    ]);
    expect(state.fullText).toBe("kept");
  });

  it("survives an assistant event with no content", () => {
    expect(fold([{ type: "assistant", message: {} }]).fullText).toBe("");
    expect(fold([{ type: "assistant" }]).fullText).toBe("");
  });

  it("lets the final result REPLACE the streamed text", () => {
    // The result is authoritative and complete; the deltas may be partial. Appending
    // instead of replacing would duplicate the whole reply.
    const state = fold([
      { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } },
      { type: "result", result: "final answer", session_id: "s2" },
    ]);
    expect(state.fullText).toBe("final answer");
    expect(state.sessionId).toBe("s2");
  });

  it("keeps the streamed text when the result carries none", () => {
    const state = fold([
      { type: "assistant", message: { content: [{ type: "text", text: "kept" }] } },
      { type: "result", session_id: "s3" },
    ]);
    expect(state.fullText).toBe("kept");
    expect(state.sessionId).toBe("s3");
  });

  it("does not clear a known session id when a later event omits it", () => {
    const state = fold([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "result", result: "done" },
    ]);
    expect(state.sessionId).toBe("s1");
  });

  it("ignores unknown event types", () => {
    const state = fold([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "something_new" },
    ]);
    expect(state).toEqual({ fullText: "", sessionId: "s1" });
  });

  it("does not mutate the state it is given", () => {
    const before = initialTurnState();
    applyStreamEvent(before, { type: "result", result: "x", session_id: "s" });
    expect(before).toEqual({ fullText: "", sessionId: null });
  });
});
