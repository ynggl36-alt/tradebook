# Two-session workflow

The owner can use two ChatGPT/Codex sessions connected to this same repository. Each session reads the same instructions but works in its own branch and checkout.

The [coordination and handoff issue #21](https://github.com/ynggl36-alt/tradebook/issues/21) is the entry point for both sessions. It links current tasks, their owners and latest checkpoints. Keep detailed progress in each task issue or draft PR, and application behavior in `docs/CURRENT_STATE.md`.

1. Read issue #21, its latest comments and the linked task/PR, then check the actual branch and open PRs. Record your task claim before edits. Different tasks can run in parallel when their owned files do not overlap. For a shared task, confirm the prior writer has explicitly released it or the owner has stopped/reassigned that session; an old timestamp or silence is not enough.
2. Branch from current `main`: `agent/session-a/chart-review` and `agent/session-b/import-recovery`. Use a distinct suffix for repeated tasks.
3. Keep changes focused and push only to the task branch. Open a PR and explain what changed and how it was tested.
4. Ask the other session to review that PR. With a shared GitHub account, put review findings in the PR conversation; GitHub cannot treat the account as its own independent approving reviewer.
5. The publisher integrates one change at a time. After the first merge, bring the second branch up to date, resolve conflicts, and rerun checks before merging it.
6. Publish the reviewed combined version through the existing private Sites workflow. Neither task branch publishes the live journal directly.

## Regular checkpoints and takeover

Record the request and relevant owner decisions at task start so context does not exist only in a chat. Update after meaningful progress, before long operations, and before ending or pausing. During a long investigation, aim for a checkpoint every 5–10 minutes. There is no assumed remaining-credit counter, advance cutoff warning or automatic launch of the other chat.

Use this template in the task issue or draft PR, and link important transitions from issue #21:

```text
UTC timestamp:
Agent/session and status (active / paused / ready for takeover / complete):
Task/PR and owner request:
Decisions / acceptance criteria:
Owned files/areas:
Branch and exact pushed commit:
Completed:
Validation actually run / verification limits:
Open problems and approaches already tried:
Unpushed/local-only work and how it can be recovered:
Code state (WIP / reviewed / merged):
Deployment state (not deployed / target Site, public source commit and exact version):
Exact next action:
Ownership released? yes/no:
```

Push safe source checkpoints to the task branch, including unfinished work clearly marked WIP. Keep source-data protections in force; never push private journal records, production source history, screenshots or credentials to make a handoff convenient. If work cannot be pushed, state that limitation and its recovery requirements; do not describe it as available to the next session.

On takeover, reconcile the checkpoint with the actual latest branch, PR and deployment state, record the new claim, and continue from the exact next action. Ask the owner only for information that cannot be recovered from the shared record. Do not repeat completed investigations or checks without a new failure, source change or unresolved concern. A progress entry does not authorize unrelated work, production data edits or deployment. The original publisher remains the publisher until the owner explicitly reassigns that role.

Unfinished work can be handed over without being merged or deployed. At completion, leave a final checkpoint with remaining verification limits, update the coordination index and release the task. Keep issue #21 open for the next task.

## Shared files

Agree on ownership before overlapping work in `lib/server-journal.ts`, `lib/realized.ts`, `lib/balance-adjustments.ts`, `lib/lucid-flex.ts`, `db/schema.ts`, `drizzle/` and `app/dashboard.tsx`. Parallel work can proceed elsewhere. Database migrations are generated one at a time.

## Prompt for the second session

> Continue the current authorized task from https://github.com/ynggl36-alt/tradebook/issues/21. Read AGENTS.md, docs/CURRENT_STATE.md, docs/COLLABORATION.md and the latest linked task/PR checkpoints first. Confirm the prior writer has stopped, reconcile the latest code and deployment state, and record your claim before editing. Use your own checkout and task branch. Keep regular checkpoints with the exact pushed commit and next action. You are a contributor unless the owner explicitly assigns publication; keep owner data and credentials out of GitHub and do not modify the live database.

The same GitHub login is sufficient to access a private repository from both sessions when both have the connector authorized. Worktree/branch isolation and the single-publisher rule are workflow controls, not separate credentials or hard access boundaries.
