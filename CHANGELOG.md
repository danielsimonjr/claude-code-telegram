# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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
