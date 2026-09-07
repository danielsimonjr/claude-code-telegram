import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowed } from "../src/bot.js";
import { loadSession, saveSession } from "../src/session.js";

describe("isAllowed", () => {
  it("permits a listed user", () => {
    expect(isAllowed(["123"], { id: 123 })).toBe(true);
  });

  it("refuses an unlisted user", () => {
    expect(isAllowed(["123"], { id: 456 })).toBe(false);
  });

  it("compares ids as strings, so a numeric id matches its text form", () => {
    expect(isAllowed(["123"], { id: "123" })).toBe(true);
  });

  it("refuses a message with no sender when an allow-list exists", () => {
    // Channel posts and some service messages carry no `from`. With a list
    // configured there is nothing to check against, so the safe answer is no.
    expect(isAllowed(["123"], undefined)).toBe(false);
  });

  it("permits everyone when the list is empty — the documented default", () => {
    // Pinned deliberately. This is the historical behaviour and the reason the
    // startup banner warns; if the default is ever tightened, this test is the
    // record of what changed and must be updated on purpose, not by accident.
    expect(isAllowed([], { id: 999 })).toBe(true);
    expect(isAllowed([], undefined)).toBe(true);
  });

  it("does not match on a partial id", () => {
    expect(isAllowed(["1234"], { id: 123 })).toBe(false);
    expect(isAllowed(["123"], { id: 1234 })).toBe(false);
  });
});

describe("session persistence", () => {
  it("round-trips a session", () => {
    const dir = mkdtempSync(join(tmpdir(), "cct-"));
    try {
      const path = join(dir, "session.json");
      saveSession({ sessionId: "abc", lastActive: 42, workDir: "/w" }, path);
      expect(loadSession(path)).toEqual({
        sessionId: "abc",
        lastActive: 42,
        workDir: "/w",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty session when the file does not exist", () => {
    expect(loadSession(join(tmpdir(), "cct-does-not-exist.json"))).toEqual({});
  });

  it("returns an empty session for corrupt JSON rather than throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cct-"));
    try {
      const path = join(dir, "session.json");
      writeFileSync(path, "{ this is not json");
      expect(loadSession(path)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty session for valid JSON that is not an object", () => {
    // JSON.parse("null") and JSON.parse("[]") both succeed. Either would produce a
    // variable typed as SessionData that is not one, and the first property access
    // on null throws far away from the cause.
    const dir = mkdtempSync(join(tmpdir(), "cct-"));
    try {
      for (const bad of ["null", "[]", "42", '"text"']) {
        const path = join(dir, `s-${bad.replace(/\W/g, "")}.json`);
        writeFileSync(path, bad);
        expect(loadSession(path), `input: ${bad}`).toEqual({});
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no temporary file behind after a save", () => {
    const dir = mkdtempSync(join(tmpdir(), "cct-"));
    try {
      const path = join(dir, "session.json");
      saveSession({ sessionId: "x" }, path);
      expect(() => readFileSync(`${path}.tmp`)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
