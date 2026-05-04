# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

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
