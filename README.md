# Tradebook

A NinjaTrader execution journal with account views, realized-exit reporting, trade reviews, payout estimates and recorder-folder sync.

This repository is the shared development source for two ChatGPT/Codex sessions. It contains **no owner trading history, payouts, bank records or deployment credentials**. The journal's live database and existing Sites deployment remain owner-private. A GitHub push does not publish the website.

## Start here

1. Read [AGENTS.md](AGENTS.md), [current state](docs/CURRENT_STATE.md) and [collaboration](docs/COLLABORATION.md).
2. Use a separate checkout and a unique task branch for each session.
3. Implement and test a focused change, then open a pull request.
4. The designated publisher integrates changes one at a time and follows [the release process](docs/RELEASING.md).

## Development

Use Node.js 24 and the pnpm version declared in `package.json`.

```sh
corepack enable
pnpm install --frozen-lockfile
node tools/check-public-source.mjs
node tools/test.mjs
pnpm exec tsc --noEmit --incremental false
pnpm build
```

Tests use synthetic executions and an in-memory SQLite database. A fresh installation starts empty; the small fixture under `tests/fixtures/` is used only by tests. Local browser development uses `pnpm dev` and local storage bindings. In ChatGPT Work, use the Sites skill and its permitted preview workflow.

## Data and accounting

- Execution identity is `(account, execution ID)`. Duplicate imports are safe; conflicting saved fills are rejected.
- Completed trades are flat-to-flat episodes. Realized reporting includes partial exits and commissions at their execution timestamps.
- Calendar days use America/Chicago midnight. Payout progress uses futures sessions beginning at 17:00 Central.
- Native account values, dated Lucid checkpoints and execution estimates have separate sources.
- Lucid Flex 50K payout estimates use a 90% trader share. Missing receipts and incomplete history remain unknown.
- Balance deductions are estimates until supported by evidence; profit removals do not count as payout income.

Read [architecture](docs/ARCHITECTURE.md) before changing storage or accounting. The source code exports read-only recorder integration; it does not submit, modify or cancel broker orders.

The owner's original private source snapshot and full-history verification remain in the existing Sites source history. GitHub begins with a sanitized source snapshot rather than a mirror of that private Git history.
