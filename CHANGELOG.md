# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Changed

- **Migrated to TypeScript on Bun.** The single 563-line `bridge.js` (CommonJS) is now
  seven ES modules under `src/`, compiled by `tsc` to `dist/`. TypeScript 7.0.2,
  Bun 1.4.2, Node >= 24 runtime. `bin` moves to `dist/index.js`.

- **Startup no longer exits from inside a module.** `bridge.js` read the environment
  and called `process.exit(1)` at load time, so importing any part of the bridge could
  terminate the importing process -- which is why none of it had unit tests.
  `readConfig()` now RETURNS a reason and `src/index.ts` decides what to do with it.

- **Stream parsing is a pure reducer.** `applyStreamEvent(state, event)` folds Claude's
  `stream-json` output without touching a process, so the event handling is tested
  against recorded event shapes instead of by running Claude.

- **CI now runs on Windows and macOS as well as Linux.** The bridge documents support
  for all three; CI tested only Linux.

### Fixed

- **A queue that could wedge permanently.** `processQueue` set `isProcessing = false`
  only on the success path. Any unexpected throw left the flag stuck true, and the
  bridge would then accept messages forever without ever running another one. The
  flag is now cleared in a `finally`.

- **Conversation history mixed two types in one field.** Inbound entries wrote a
  numeric `userId`; outbound entries wrote the string `"claude"` into the same field.
  Both are strings now, so the file can be parsed without special-casing.

- **A message with no sender could crash the handler.** With no allow-list configured,
  `isAllowed` returned true for a message carrying no `from`, and the next line read
  `ctx.from.id`. Channel posts and some service messages have no sender.

- **The session file could be left corrupt by an interrupted write.** It is now written
  to a temporary file and renamed, which is atomic on the same volume. `loadSession`
  also rejects valid JSON that is not an object -- `null`, `[]` and `42` all parsed
  successfully before and produced a value typed as a session that was not one.

- **A log-file write could take the bridge down.** The config directory can be
  read-only, full, or on a disconnected drive. Log appends are now best-effort; the
  line still reaches stdout.

- **Control characters were written literally into the source.** The ANSI-stripping
  regex contained raw bytes, which made the file read as BINARY to `git` and `grep`.
  It is built from `String.fromCharCode` now.

### Added

- **A test suite: 49 tests across four files**, where there were none on `main`.
  Covers message chunking (including inputs that could loop forever), env parsing,
  `stream-json` event folding, the allow-list, and session persistence.

- **`scripts/smoke.mjs`**, which runs the BUILT bridge with no token and asserts it
  refuses cleanly and names the missing variable. Adapted from a mutation-verified
  test that sat unmerged on an abandoned branch and never reached `main`.
  Mutation-verified again here: removing the refusal makes it fail, and TypeScript
  catches the same mutation independently.

### Security

- **An empty `ALLOWED_USERS` means ANY Telegram user who can reach the bot can run
  Claude Code on the host machine.** This is the historical default and is NOT changed
  here -- tightening it is a decision for the operator, not a cleanup. Startup now
  warns loudly when the allow-list is empty, and a test pins the behaviour so a future
  change to it has to be deliberate.

### Changed

- Migrated the Telegram client off `node-telegram-bot-api` to
  [grammY](https://grammy.dev) (`grammy@^1.43.0`), resolving issue #1.
  `node-telegram-bot-api` transitively pulled the deprecated/unmaintained
  `request` package (via `request-promise-core`); grammY has no such
  dependency. Its only runtime deps are `@grammyjs/types`, `abort-controller`,
  `debug`, and `node-fetch`. After the swap, `npm ls request` reports the
  package is gone from the tree and `npm audit` reports 0 vulnerabilities.
- Rewrote `bridge.js` for grammY's API while keeping behavior equivalent:
  - `new TelegramBot(token, { polling })` → `new Bot(token)` + `bot.start()`.
  - `bot.onText(/\/cmd/, ...)` → `bot.command("cmd", ctx => ...)`.
  - `bot.on("message", ...)` → `bot.on("message:text", ...)` using `ctx`.
  - `bot.sendMessage(...)` / `bot.editMessageText(text, { chat_id, ... })`
    → `bot.api.sendMessage(...)` / `bot.api.editMessageText(chatId, msgId,
    text, opts)` (grammY's positional signature).
  - `bot.on("polling_error", ...)` → `bot.catch(...)`; `bot.stopPolling()`
    → `bot.stop()`.
  - Dropped the manual `getUpdates?offset=-1` HTTPS call in favor of
    `bot.start({ drop_pending_updates: true })`.

### Removed

- The `overrides` block in `package.json` that existed only to neutralize the
  `request` / `@cypress/request` / `request-promise-core` chain pulled by
  `node-telegram-bot-api`. No longer needed with grammY.

## [1.0.1] - 2026-05-01

### Security

- Cleared the remaining 5 moderate-severity npm-audit vulnerabilities in the
  `node-telegram-bot-api` -> `request` / `request-promise` / `uuid` chain.
  - Bumped `node-telegram-bot-api` from `^0.63.0` to `^0.67.0`. This swaps the
    legacy unmaintained `request` and `request-promise` packages for the
    Cypress-maintained forks (`@cypress/request`, `@cypress/request-promise`).
    Surface used by `bridge.js` (`new TelegramBot`, `onText`, `sendMessage`,
    `editMessageText`, `on('message')`, `on('polling_error')`, `stopPolling`)
    is unchanged across the 0.63 → 0.67 range; smoke-tested locally — bridge
    boots, polls, and rejects only on the (expected) invalid bot token.
  - Pinned `@cypress/request` to `^4.0.0` via `overrides` (drops the legacy
    `uuid` transitive dependency entirely).
  - Pinned `request-promise-core` to `^1.1.4` via `overrides` (no longer
    declares the deprecated `request@2.x` as a regular dependency).
  - Aliased the `request` peer-dependency to `@cypress/request@^4.0.0` so npm
    no longer auto-installs the deprecated, vulnerable `request@2.88.2` to
    satisfy `request-promise-core`'s peerDependency.
  - Net result: `npm audit` reports `found 0 vulnerabilities` (down from 5
    moderate).
