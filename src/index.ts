#!/usr/bin/env node
/**
 * Entry point.
 *
 * The only file that reads the real environment, exits the process, or opens a
 * connection. Everything it uses is importable without any of that happening.
 */
import { ensureConfigDir, loadEnvFiles, readConfig } from "./config.js";
import { createBridge } from "./bot.js";
import { log } from "./log.js";

function main(): void {
  ensureConfigDir();
  loadEnvFiles();

  const config = readConfig();
  if ("error" in config) {
    console.error(`ERROR: ${config.error}`);
    process.exit(1);
  }

  log(`Bridge starting. Working directory: ${config.workDir}`);

  if (config.allowedUsers.length === 0) {
    // Not a behaviour change -- an empty allow-list has always meant "anyone". It is
    // said loudly because the consequence is that any Telegram user who finds this
    // bot can run Claude Code on this machine with the operator's own permissions.
    log(
      "WARNING: ALLOWED_USERS is empty, so ANY Telegram user who can reach this bot " +
        "can run Claude Code on this machine. Set ALLOWED_USERS to your Telegram " +
        "user id to restrict it.",
    );
  } else {
    log(`Allowed users: ${config.allowedUsers.join(", ")}`);
  }

  const bridge = createBridge(config);

  process.on("unhandledRejection", (reason: unknown) => {
    log(`[ERROR] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  });
  process.on("SIGINT", () => {
    bridge.shutdown("SIGINT");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    bridge.shutdown("SIGTERM");
    process.exit(0);
  });

  bridge.start();
}

main();
