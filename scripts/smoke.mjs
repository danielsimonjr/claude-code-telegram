#!/usr/bin/env node
// Does the BUILT bridge refuse to start without credentials, and say why?
//
// Adapted from a mutation-verified smoke test that sat unmerged on an abandoned
// branch (ci/add-github-actions) and never reached main. Its reasoning still holds
// and is worth restating: this is not an MCP server, so there is no stdio protocol to
// probe. The checkable question without secrets is whether the most likely real
// failure -- running with no token -- fails CLEANLY rather than hanging or crashing.
//
// It deliberately does NOT test the happy path. Connecting to Telegram needs a live
// bot token and network, and a test that needs a credential is a test that gets
// skipped and then rots.
//
// It runs dist/index.js, not src/, so a packaging fault the unit tests cannot see
// (missing shebang, bad emitted import specifier, unbuilt dist) fails here.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "dist", "index.js");
const BUDGET_MS = 20_000;

function fail(message) {
  console.error(`SMOKE FAIL: ${message}`);
  process.exit(1);
}

/** Run the bridge with the given env overrides; resolve with {code, stdout, stderr}. */
function runBridge(env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(
        new Error(
          `bridge did not exit within ${BUDGET_MS}ms — it should refuse immediately, ` +
            `not hang.\nstdout: ${stdout.slice(0, 300)}\nstderr: ${stderr.slice(0, 300)}`,
        ),
      );
    }, BUDGET_MS);
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

// An empty cwd stops a stray .env in the repo from supplying a token and turning the
// refusal path into an attempted connection.
const emptyCwd = mkdtempSync(join(tmpdir(), "cct-smoke-"));

try {
  const env = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  // HOME/USERPROFILE are redirected so the operator's real ~/.claude-code-telegram/.env
  // cannot be picked up and quietly satisfy the token requirement.
  env.HOME = emptyCwd;
  env.USERPROFILE = emptyCwd;

  const { code, stdout, stderr } = await runBridge(env, emptyCwd);
  const output = `${stdout}${stderr}`;

  if (code === 0) fail(`exited 0 with no token; it must refuse. Output:\n${output}`);
  if (!/TELEGRAM_BOT_TOKEN/.test(output)) {
    fail(`refused, but never named TELEGRAM_BOT_TOKEN. Output:\n${output}`);
  }

  console.log(`SMOKE OK: refused without a token (exit ${code}) and explained why`);
  process.exit(0);
} catch (err) {
  fail(err.message);
} finally {
  rmSync(emptyCwd, { recursive: true, force: true });
}
