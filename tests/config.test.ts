import { describe, it, expect, afterEach } from "vitest";
import { loadEnvInto, parseAllowedUsers, readConfig } from "../src/config.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("loadEnvInto", () => {
  it("parses simple assignments", () => {
    const env: Record<string, string | undefined> = {};
    loadEnvInto("A=1\nB=two", env);
    expect(env).toEqual({ A: "1", B: "two" });
  });

  it("does NOT overwrite a value already present", () => {
    // A real environment variable must beat the file, or an operator cannot override
    // a stale committed default without editing it.
    const env: Record<string, string | undefined> = { A: "real" };
    loadEnvInto("A=fromfile", env);
    expect(env.A).toBe("real");
  });

  it("skips blanks and comments", () => {
    const env: Record<string, string | undefined> = {};
    loadEnvInto("\n# comment\n   \nA=1", env);
    expect(env).toEqual({ A: "1" });
  });

  it("strips one layer of surrounding quotes", () => {
    const env: Record<string, string | undefined> = {};
    loadEnvInto(`A="quoted"\nB='single'`, env);
    expect(env).toEqual({ A: "quoted", B: "single" });
  });

  it("keeps '=' characters inside the value", () => {
    // Tokens and base64 contain '='; splitting on every '=' would truncate them.
    const env: Record<string, string | undefined> = {};
    loadEnvInto("TOKEN=abc=def==", env);
    expect(env.TOKEN).toBe("abc=def==");
  });

  it("ignores a line with no key", () => {
    const env: Record<string, string | undefined> = {};
    loadEnvInto("=novalue\nA=1", env);
    expect(env).toEqual({ A: "1" });
  });
});

describe("parseAllowedUsers", () => {
  it("splits and trims a comma list", () => {
    expect(parseAllowedUsers(" 1, 2 ,3 ")).toEqual(["1", "2", "3"]);
  });

  it("returns an empty list for undefined or empty input", () => {
    expect(parseAllowedUsers(undefined)).toEqual([]);
    expect(parseAllowedUsers("")).toEqual([]);
  });

  it("drops empty entries from a trailing comma", () => {
    expect(parseAllowedUsers("1,,2,")).toEqual(["1", "2"]);
  });

  it("keeps ids as strings", () => {
    // Telegram ids can exceed the safe integer range, and they are only ever
    // compared for equality.
    expect(parseAllowedUsers("9007199254740993")).toEqual(["9007199254740993"]);
  });
});

describe("readConfig", () => {
  it("returns a reason instead of exiting when the token is missing", () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const result = readConfig(["node", "bridge"]);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("prefers the argv working directory over the environment", () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.CLAUDE_WORK_DIR = "/from/env";
    const result = readConfig(["node", "bridge", "/from/argv"]);
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.workDir).toBe("/from/argv");
  });

  it("falls back to CLAUDE_WORK_DIR when argv omits it", () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.CLAUDE_WORK_DIR = "/from/env";
    const result = readConfig(["node", "bridge"]);
    expect("error" in result).toBe(false);
    if (!("error" in result)) expect(result.workDir).toBe("/from/env");
  });
});
