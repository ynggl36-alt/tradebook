# Two-session workflow

The owner can use two ChatGPT/Codex sessions connected to this same repository. Each session reads the same instructions but works in its own branch and checkout.

1. Choose different tasks. Example: session A improves trade charts; session B improves CSV recovery. Check open PRs and claim the task in its description before parallel edits.
2. Branch from current `main`: `agent/session-a/chart-review` and `agent/session-b/import-recovery`. Use a distinct suffix for repeated tasks.
3. Keep changes focused and push only to the task branch. Open a PR and explain what changed and how it was tested.
4. Ask the other session to review that PR. With a shared GitHub account, put review findings in the PR conversation; GitHub cannot treat the account as its own independent approving reviewer.
5. The publisher integrates one change at a time. After the first merge, bring the second branch up to date, resolve conflicts, and rerun checks before merging it.
6. Publish the reviewed combined version through the existing private Sites workflow. Neither task branch publishes the live journal directly.

## Shared files

Agree on ownership before overlapping work in `lib/server-journal.ts`, `lib/realized.ts`, `lib/balance-adjustments.ts`, `lib/lucid-flex.ts`, `db/schema.ts`, `drizzle/` and `app/dashboard.tsx`. Parallel work can proceed elsewhere. Database migrations are generated one at a time.

## Prompt for the second session

> Work on https://github.com/ynggl36-alt/tradebook. Read AGENTS.md and docs/CURRENT_STATE.md first. You are a contributor; the original Tradebook conversation remains the publisher. Use your own checkout and a unique task branch, inspect open PRs, and open a tested PR for the task I assign. Keep owner data and credentials out of GitHub. Do not publish to the live Site or modify its database.

The same GitHub login is sufficient to access a private repository from both sessions when both have the connector authorized. Worktree/branch isolation and the single-publisher rule are workflow controls, not separate credentials or hard access boundaries.
