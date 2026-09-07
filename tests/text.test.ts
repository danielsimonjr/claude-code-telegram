import { describe, it, expect } from "vitest";
import { cleanAnsi, splitMessage, MAX_MSG } from "../src/text.js";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe("cleanAnsi", () => {
  it("removes SGR colour codes", () => {
    expect(cleanAnsi(`${ESC}[31mred${ESC}[0m`)).toBe("red");
  });

  it("removes OSC sequences terminated by BEL", () => {
    expect(cleanAnsi(`${ESC}]0;window title${BEL}kept`)).toBe("kept");
  });

  it("strips control characters but keeps newlines and tabs", () => {
    const withControls = `a${String.fromCharCode(0)}b${String.fromCharCode(8)}c\n\td`;
    expect(cleanAnsi(withControls)).toBe("abc\n\td");
  });

  it("trims surrounding whitespace", () => {
    expect(cleanAnsi("  spaced  ")).toBe("spaced");
  });

  it("returns an empty string unchanged", () => {
    expect(cleanAnsi("")).toBe("");
  });
});

describe("splitMessage", () => {
  it("returns a short message as a single chunk", () => {
    expect(splitMessage("hello")).toEqual(["hello"]);
  });

  it("returns no chunks for an empty string rather than one empty chunk", () => {
    // An empty chunk would be sent to Telegram as an empty message, which the API
    // rejects. Nothing to say means nothing to send.
    expect(splitMessage("")).toEqual([]);
  });

  it("never emits a chunk longer than the Telegram limit", () => {
    const long = "x".repeat(MAX_MSG * 3 + 17);
    for (const chunk of splitMessage(long)) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_MSG);
    }
  });

  it("reassembles to exactly the original text", () => {
    const text = `${"a".repeat(MAX_MSG - 5)}\n${"b".repeat(MAX_MSG * 2)}`;
    expect(splitMessage(text).join("")).toBe(text);
  });

  it("prefers a newline boundary when one is late enough in the chunk", () => {
    const head = "line one".padEnd(MAX_MSG - 10, ".");
    const text = `${head}\n${"z".repeat(50)}`;
    const [first] = splitMessage(text);
    expect(first).toBe(head);
  });

  it("splits at the hard limit when the only newline is too early", () => {
    // Breaking at a newline 3 characters in would emit a 3-character chunk and make
    // no progress on the rest, so the hard limit wins.
    const text = `ab\n${"y".repeat(MAX_MSG * 2)}`;
    const [first] = splitMessage(text);
    expect(first?.length).toBe(MAX_MSG);
  });

  it("terminates on text made entirely of newlines", () => {
    // A pathological input must not loop forever: every iteration has to consume
    // at least one character.
    const chunks = splitMessage("\n".repeat(MAX_MSG * 2));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.join("")).toBe("\n".repeat(MAX_MSG * 2));
  });
});
